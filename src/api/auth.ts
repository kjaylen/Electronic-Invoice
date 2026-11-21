/**
 * Accounts for people (the web app): sign up, log in, log out, create a
 * business, switch business, change or reset a password, accept an invitation.
 *
 * Sessions live in an httpOnly, SameSite=Lax cookie. Every state-changing
 * request authenticated by cookie must also send "X-Requested-With: etd-web":
 * browsers will not attach a custom header cross-site without a CORS
 * preflight, and this API allows none, so a forged form post cannot pass.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createTenant, type NewTenant } from '../db/tenants.ts';
import { acceptInvitation, findInvitation } from '../db/team.ts';
import {
  addMembership,
  changePassword,
  checkCredentials,
  consumePasswordReset,
  createPasswordReset,
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  lookupSession,
  memberships,
  SESSION_MAX_MS,
  setSessionTenant,
  type Session,
  type User,
} from '../db/users.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, requireMail, type ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { tenantSchema, uuid } from './schemas.ts';

export const SESSION_COOKIE = 'etd_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'etd-web';

export type AuthOptions = Pick<ServerContext, 'cookieSecure' | 'allowSignup'>;

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, options: AuthOptions) {
  reply.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_MS / 1000}${options.cookieSecure ? '; Secure' : ''}`);
}

function clearSessionCookie(reply: FastifyReply, options: AuthOptions) {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.cookieSecure ? '; Secure' : ''}`);
}

export function requireCsrfHeader(request: FastifyRequest) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new ApiError(403, 'csrf', `Send the header X-Requested-With: ${CSRF_VALUE}`);
  }
}

export async function sessionFromRequest(deps: PipelineDeps, request: FastifyRequest): Promise<Session | null> {
  const token = readCookie(request, SESSION_COOKIE);
  return token ? lookupSession(deps.db, token) : null;
}

// ---------- login rate limiting (per process; use a shared store when running several instances) ----------

const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(key: string, limit: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

/** For tests. */
export function resetLoginAttempts() {
  attempts.clear();
}

// ---------- routes ----------

const credentials = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

async function sessionBody(deps: PipelineDeps, user: Session['user'], currentTenantId: string | null) {
  const businesses = await memberships(deps.db, user.id);
  return {
    user,
    businesses: businesses.map((b) => ({ id: b.tenantId, legalName: b.legalName, tradeName: b.tradeName, environment: b.environment, role: b.role })),
    currentBusinessId: currentTenantId,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: PipelineDeps, options: ServerContext) {
  const { db } = deps;
  app.addHook('onRequest', async (request) => requireCsrfHeader(request));

  const requireSession = async (request: FastifyRequest): Promise<Session> => {
    const session = await sessionFromRequest(deps, request);
    if (!session) throw new ApiError(401, 'unauthorized', 'Please log in');
    return session;
  };

  app.post<{ Body: { name: string; email: string; password: string } }>(
    '/signup',
    { schema: { body: { ...credentials, required: ['name', 'email', 'password'], properties: { ...credentials.properties, name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      if (!options.allowSignup) throw new ApiError(403, 'signup_closed', 'Sign-up is closed; ask for an invitation');
      if (tooManyAttempts(`signup|${request.ip}`, 20)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again later');
      const user = await createUser(db, request.body);
      const { token } = await createSession(db, user.id, null);
      setSessionCookie(reply, token, options);
      return reply.code(201).send(await sessionBody(deps, user, null));
    },
  );

  app.post<{ Body: { email: string; password: string } }>('/login', { schema: { body: credentials } }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    if (tooManyAttempts(`login|${request.ip}|${email}`, 10) || tooManyAttempts(`login|${request.ip}`, 50)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
    }
    const user = await checkCredentials(db, email, request.body.password);
    if (!user) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    const first = (await memberships(db, user.id))[0];
    const { token } = await createSession(db, user.id, first?.tenantId ?? null);
    setSessionCookie(reply, token, options);
    return sessionBody(deps, user, first?.tenantId ?? null);
  });

  app.post('/logout', async (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await deleteSession(db, token);
    clearSessionCookie(reply, options);
    return reply.code(204).send();
  });

  app.get('/session', async (request) => {
    const session = await requireSession(request);
    return { ...(await sessionBody(deps, session.user, session.currentTenantId)), role: session.role };
  });

  // Self-service businesses start in the BTS test environment; moving to production is an admin step.
  const { environment: _env, ...businessProperties } = tenantSchema.properties;
  app.post<{ Body: Omit<NewTenant, 'environment'> }>(
    '/businesses',
    { schema: { body: { ...tenantSchema, required: ['legalName', 'tin', 'address', 'contact'], properties: businessProperties } } },
    async (request, reply) => {
      const session = await requireSession(request);
      const dup = await db.query(`select 1 from tenants where tin = $1 and environment = 'test'`, [request.body.tin]);
      if (dup.rows.length) throw new ApiError(409, 'conflict', 'A business with this TIN is already registered; ask its owner to invite you');
      const tenantId = await createTenant(db, { ...request.body, environment: 'test' });
      await addMembership(db, session.user.id, tenantId, 'owner');
      await setSessionTenant(db, session.id, tenantId);
      return reply.code(201).send(await sessionBody(deps, session.user, tenantId));
    },
  );

  app.post<{ Body: { businessId: string } }>(
    '/switch',
    { schema: { body: { type: 'object', required: ['businessId'], additionalProperties: false, properties: { businessId: uuid } } } },
    async (request) => {
      const session = await requireSession(request);
      const member = (await memberships(db, session.user.id)).some((m) => m.tenantId === request.body.businessId);
      if (!member) throw new ApiError(404, 'not_found', 'Business not found');
      await setSessionTenant(db, session.id, request.body.businessId);
      return sessionBody(deps, session.user, request.body.businessId);
    },
  );

  // ---------- passwords ----------

  const passwordField = { type: 'string', minLength: 1, maxLength: 200 } as const;

  async function startSession(reply: FastifyReply, user: User, tenantId?: string) {
    const current = tenantId ?? (await memberships(db, user.id))[0]?.tenantId ?? null;
    const { token } = await createSession(db, user.id, current);
    setSessionCookie(reply, token, options);
    return sessionBody(deps, user, current);
  }

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/password/change',
    { schema: { body: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: passwordField, newPassword: passwordField } } } },
    async (request, reply) => {
      const session = await requireSession(request);
      if (tooManyAttempts(`change|${session.user.id}`, 10)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      if (!(await changePassword(db, session.user.id, request.body.currentPassword, request.body.newPassword, session.id))) {
        throw new ApiError(422, 'wrong_password', 'Your current password is incorrect');
      }
      return reply.code(204).send();
    },
  );

  // Always 204, whether or not the email has an account, so the form cannot be used to find out who is registered.
  app.post<{ Body: { email: string } }>(
    '/password/forgot',
    { schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 254 } } } } },
    async (request, reply) => {
      requireMail(options);
      publicLink(options, '/'); // fail now, not silently in the background, when links cannot be built
      const email = request.body.email.trim().toLowerCase();
      if (tooManyAttempts(`forgot|${request.ip}`, 20) || tooManyAttempts(`forgot|${email}`, 5)) {
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      }
      // In the background, so the response time does not reveal whether the account exists.
      void (async () => {
        const reset = await createPasswordReset(db, email);
        if (!reset) return;
        const link = publicLink(options, `/reset-password?token=${reset.token}`);
        await options.mailer.send({
          to: reset.user.email,
          subject: 'Reset your password',
          text: `Hello ${reset.user.name},\n\nSomeone (hopefully you) asked to reset the password for your eInvoicing account.\n\nChoose a new password here (the link works for one hour):\n${link}\n\nIf you did not ask for this, ignore this email; your password stays the same.`,
          html: simpleHtml({
            heading: 'Reset your password',
            paragraphs: [`Hello ${reset.user.name},`, 'Someone (hopefully you) asked to reset the password for your eInvoicing account. The link works for one hour.', 'If you did not ask for this, ignore this email; your password stays the same.'],
            button: { label: 'Choose a new password', url: link },
          }),
        });
      })().catch((e) => request.log.error({ err: e }, 'password reset email failed'));
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/password/reset',
    { schema: { body: { type: 'object', required: ['token', 'password'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 100 }, password: passwordField } } } },
    async (request, reply) => {
      if (tooManyAttempts(`reset|${request.ip}`, 30)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again later');
      const user = await consumePasswordReset(db, request.body.token, request.body.password);
      if (!user) throw new ApiError(400, 'invalid_token', 'This reset link is invalid, already used or expired. Ask for a new one.');
      return startSession(reply, user);
    },
  );

  // ---------- invitations ----------

  const invalidInvitation = () => new ApiError(404, 'invalid_token', 'This invitation is invalid, already used or expired. Ask for a new one.');

  app.get<{ Params: { token: string } }>('/invitations/:token', async (request) => {
    const inv = await findInvitation(db, request.params.token);
    if (!inv) throw invalidInvitation();
    return {
      businessName: inv.businessName,
      invitedByName: inv.invitedByName,
      email: inv.email,
      role: inv.role,
      accountExists: Boolean(await findUserByEmail(db, inv.email)),
      expiresAt: inv.expiresAt,
    };
  });

  app.post<{ Body: { token: string; name?: string; password?: string } }>(
    '/invitations/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 200 }, password: passwordField },
        },
      },
    },
    async (request, reply) => {
      if (tooManyAttempts(`accept|${request.ip}`, 30)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again later');
      const inv = await findInvitation(db, request.body.token);
      if (!inv) throw invalidInvitation();
      const session = await sessionFromRequest(deps, request);
      if (session) {
        if (session.user.email !== inv.email) {
          throw new ApiError(403, 'wrong_account', `This invitation is for ${inv.email}. Log out, then open the link again.`);
        }
        if (!(await acceptInvitation(db, inv, session.user.id))) throw invalidInvitation();
        await setSessionTenant(db, session.id, inv.tenantId);
        return sessionBody(deps, session.user, inv.tenantId);
      }
      if (await findUserByEmail(db, inv.email)) throw new ApiError(409, 'login_required', `Log in as ${inv.email} to accept this invitation`);
      if (!request.body.name || !request.body.password) throw new ApiError(422, 'invalid_account', 'Enter your name and choose a password');
      const user = await createUser(db, { email: inv.email, name: request.body.name, password: request.body.password });
      if (!(await acceptInvitation(db, inv, user.id))) throw invalidInvitation();
      return reply.code(201).send(await startSession(reply, user, inv.tenantId));
    },
  );
}
