/**
 * A business's own accounts, managed by its owners and admins (web app only).
 *
 *   GET   /v1/users                       everyone in the business
 *   POST  /v1/users                       create: temporary password, or an emailed welcome link
 *   PATCH /v1/users/:id                   name, email, username, role
 *   POST  /v1/users/:id/disable|enable    deactivate (signs them out) or reactivate
 *   POST  /v1/users/:id/password          set a temporary password, or send a set-password link
 *   POST  /v1/users/:id/sign-out          end all their sessions
 *   GET   /v1/audit                       the activity log
 *
 * Owners manage everyone; admins manage managers, cashiers and accountants.
 * Nobody changes their own role or deactivates themselves, and a business
 * always keeps an active owner. Accounts are deactivated, never deleted, so
 * the record of who issued or cancelled what stays complete.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit, auditEvents } from '../db/audit.ts';
import {
  activeOwnerCount,
  activeSessionCount,
  createPasswordLink,
  createUser,
  getUser,
  listUsers,
  setPassword,
  setUserStatus,
  signOutEverywhere,
  updateUser,
  type User,
} from '../db/users.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { userJson } from './auth.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { canManageRole, requirePersonWith, type Role, ROLES } from './permissions.ts';
import { uuid } from './schemas.ts';
import { disableTwoFactor } from '../db/twofactor.ts';
import { assertCanAddUser } from '../billing/billing.ts';

const role = { type: 'string', enum: [...ROLES] } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const ROLE_NAMES: Record<Role, string> = { owner: 'an owner', admin: 'an admin', manager: 'a manager', cashier: 'a cashier', accountant: 'an accountant' };

export function registerUserRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const actorRole = (request: FastifyRequest) => request.principal as Role;
  const log = (request: FastifyRequest, action: string, target?: User | null, details?: Record<string, unknown>) =>
    audit(db, { tenantId: request.tenantId, userId: request.userId, action, target: target ? (target.email ?? target.username) : null, ...(details && { details }), ip: request.ip });

  /** The account, if the caller may manage it. */
  const manageable = async (request: FastifyRequest, id: string): Promise<User> => {
    requirePersonWith(request, 'users.manage');
    const user = await getUser(db, request.tenantId, id);
    if (!user) throw notFound('Account');
    if (!canManageRole(actorRole(request), user.role)) throw new ApiError(403, 'forbidden', `Only an owner can manage ${ROLE_NAMES[user.role]}`);
    return user;
  };
  const business = async (tenantId: string) =>
    (await db.query<{ slug: string; name: string }>('select slug, coalesce(trade_name, legal_name) as name from tenants where id = $1', [tenantId])).rows[0]!;

  /** Email (when possible) a link to set a password. Returns the link so it can also be shared another way. */
  const sendPasswordLink = async (request: FastifyRequest, user: User, kind: 'welcome' | 'reset') => {
    publicLink(ctx, '/');
    const token = await createPasswordLink(db, user.id, 'welcome');
    const b = await business(request.tenantId);
    const link = publicLink(ctx, `/${b.slug}/reset-password?token=${token}`);
    let emailSent = false;
    if (ctx.mailConfigured && user.email) {
      const inviter = (await getUser(db, request.tenantId, request.userId))?.name ?? 'Your administrator';
      const login = user.email;
      const welcome = kind === 'welcome';
      try {
        await ctx.mailer.send({
          to: user.email,
          subject: welcome ? `${inviter} created your ${b.name} account` : `Set a new password for ${b.name}`,
          text: `${welcome ? `${inviter} created an account for you at ${b.name} on eInvoicing.` : `${inviter} asked you to set a new password for ${b.name}.`}\n\nSign-in: ${login}\nChoose your password here (the link works for 7 days):\n${link}\n\nAfterwards, sign in at ${publicLink(ctx, `/${b.slug}`)}`,
          html: simpleHtml({
            heading: welcome ? `Welcome to ${b.name}` : 'Set a new password',
            paragraphs: [
              welcome ? `${inviter} created an account for you at ${b.name} on eInvoicing.` : `${inviter} asked you to set a new password for ${b.name}.`,
              `Sign-in: ${login}. The link works for 7 days.`,
              `Afterwards, sign in at ${publicLink(ctx, `/${b.slug}`)}`,
            ],
            button: { label: 'Choose your password', url: link },
          }),
        });
        emailSent = true;
      } catch (e) {
        request.log.error({ err: e }, 'password link email failed');
      }
    }
    return { link, emailSent };
  };

  app.get('/users', async (request) => {
    requirePersonWith(request, 'users.manage');
    const users = await listUsers(db, request.tenantId);
    const sessions = await Promise.all(users.map((u) => activeSessionCount(db, u.id)));
    const withTwoFactor = new Set((await db.query<{ owner_id: string }>(
      `select owner_id from two_factor where owner_kind = 'user' and confirmed_at is not null and owner_id = any($1::uuid[])`, [users.map((u) => u.id)],
    )).rows.map((r) => r.owner_id));
    return { data: users.map((u, i) => ({ ...userJson(u), activeSessions: sessions[i], twoFactor: withTwoFactor.has(u.id), manageable: canManageRole(actorRole(request), u.role) && u.id !== request.userId })) };
  });

  app.post<{ Body: { name: string; email?: string; username?: string; role: Role; password?: string; sendWelcome?: boolean } }>(
    '/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'role'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: 'string', minLength: 3, maxLength: 254 },
            username: { type: 'string', minLength: 2, maxLength: 40 },
            role,
            password: { type: 'string', minLength: 1, maxLength: 200 },
            sendWelcome: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      requirePersonWith(request, 'users.manage');
      await assertCanAddUser(db, request.tenantId);
      const b = request.body;
      if (!canManageRole(actorRole(request), b.role)) throw new ApiError(403, 'forbidden', `Only an owner can create ${ROLE_NAMES[b.role]}`);
      if (!b.password && !b.email) throw new ApiError(422, 'invalid_account', 'Set a temporary password, or give an email address to send a welcome link');
      const user = await createUser(db, {
        tenantId: request.tenantId,
        name: b.name,
        ...(b.email && { email: b.email }),
        ...(b.username && { username: b.username }),
        role: b.role,
        ...(b.password && { password: b.password, mustChangePassword: true }),
        createdBy: request.userId,
      });
      await log(request, 'user.created', user, { role: user.role });
      const welcome = !b.password ? await sendPasswordLink(request, user, 'welcome') : null;
      return reply.code(201).send({ user: userJson(user), ...(welcome && { welcomeUrl: welcome.link, emailSent: welcome.emailSent }) });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; email?: string | null; username?: string | null; role?: Role } }>(
    '/users/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: ['string', 'null'], maxLength: 254 },
            username: { type: ['string', 'null'], maxLength: 40 },
            role,
          },
        },
      },
    },
    async (request) => {
      const b = request.body;
      if (request.params.id === request.userId && b.role !== undefined) throw new ApiError(409, 'own_role', 'You cannot change your own role. Ask another owner.');
      const target = await manageable(request, request.params.id);
      if (b.role && b.role !== target.role) {
        if (!canManageRole(actorRole(request), b.role)) throw new ApiError(403, 'forbidden', `Only an owner can make someone ${ROLE_NAMES[b.role]}`);
        if (target.role === 'owner' && target.status === 'active' && (await activeOwnerCount(db, request.tenantId)) <= 1) {
          throw new ApiError(409, 'last_owner', 'A business needs at least one owner. Make someone else an owner first.');
        }
      }
      const updated = await updateUser(db, request.tenantId, target.id, {
        ...(b.name !== undefined && { name: b.name }),
        ...(b.email !== undefined && { email: b.email || null }),
        ...(b.username !== undefined && { username: b.username || null }),
        ...(b.role !== undefined && { role: b.role }),
      });
      const changed = Object.fromEntries((['name', 'email', 'username', 'role'] as const).filter((k) => target[k] !== updated[k]).map((k) => [k, { from: target[k], to: updated[k] }]));
      if (Object.keys(changed).length) await log(request, 'user.updated', updated, changed);
      return userJson(updated);
    },
  );

  for (const [path, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    app.post<{ Params: { id: string } }>(`/users/:id/${path}`, { schema: { params: idParams } }, async (request) => {
      if (request.params.id === request.userId) throw new ApiError(409, 'own_account', 'You cannot deactivate your own account');
      const target = await manageable(request, request.params.id);
      if (status === 'disabled' && target.role === 'owner' && target.status === 'active' && (await activeOwnerCount(db, request.tenantId)) <= 1) {
        throw new ApiError(409, 'last_owner', 'A business needs at least one active owner');
      }
      if (status === 'active' && target.status !== 'active') await assertCanAddUser(db, request.tenantId);
      await setUserStatus(db, request.tenantId, target.id, status);
      await log(request, status === 'disabled' ? 'user.disabled' : 'user.enabled', target);
      return userJson((await getUser(db, request.tenantId, target.id))!);
    });
  }

  app.post<{ Params: { id: string }; Body: { password?: string; sendLink?: boolean } }>(
    '/users/:id/password',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { password: { type: 'string', minLength: 1, maxLength: 200 }, sendLink: { type: 'boolean' } } },
      },
    },
    async (request) => {
      if (request.params.id === request.userId) throw new ApiError(409, 'own_account', 'Change your own password from your account settings');
      const target = await manageable(request, request.params.id);
      if (request.body.password) {
        // A temporary password: they must choose their own at the next sign-in. All their sessions end.
        await setPassword(db, target.id, request.body.password, { mustChange: true });
        await log(request, 'user.password_set', target);
        return { ok: true };
      }
      if (!request.body.sendLink) throw new ApiError(422, 'invalid_request', 'Give a temporary password, or ask to send a link');
      const { link, emailSent } = await sendPasswordLink(request, target, 'reset');
      await log(request, 'user.password_link_sent', target);
      return { ok: true, link, emailSent };
    },
  );

  app.post<{ Params: { id: string } }>('/users/:id/two-factor/reset', { schema: { params: idParams } }, async (request) => {
    if (request.params.id === request.userId) throw new ApiError(409, 'own_account', 'Turn off your own two-step sign-in from your account settings');
    const target = await manageable(request, request.params.id);
    if (await disableTwoFactor(db, 'user', target.id)) {
      // Whoever had the phone may have a session: end them all.
      await signOutEverywhere(db, target.id);
      await log(request, 'user.two_factor_reset', target);
    }
    return userJson((await getUser(db, request.tenantId, target.id))!);
  });

  app.post<{ Params: { id: string } }>('/users/:id/sign-out', { schema: { params: idParams } }, async (request) => {
    const target = request.params.id === request.userId ? (await getUser(db, request.tenantId, request.userId))! : await manageable(request, request.params.id);
    const ended = await signOutEverywhere(db, target.id);
    await log(request, 'user.signed_out', target, { sessions: ended });
    return { sessionsEnded: ended };
  });

  app.get<{ Querystring: { before?: string; limit?: string } }>(
    '/audit',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^\\d{1,18}$' }, limit: { type: 'string', pattern: '^\\d{1,3}$' } } } } },
    async (request) => {
      requirePersonWith(request, 'audit.view');
      const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 200);
      const events = await auditEvents(db, request.tenantId, { limit: limit + 1, ...(request.query.before && { before: Number(request.query.before) }) });
      return { data: events.slice(0, limit), nextBefore: events.length > limit ? events[limit - 1]!.id : null };
    },
  );
}
