/**
 * Signing in to a business. Each business is its own instance with its own
 * address (app.example.bz/<slug>) and its own accounts.
 *
 *   POST /v1/auth/signup            create a business and its first owner
 *   POST /v1/auth/login             { business: slug, login: email or username, password }
 *                                   → the session, or { twoFactorRequired, challenge } when two-step sign-in is on
 *   POST /v1/auth/login/verify      { challenge, code }: the code from the authenticator app (or a recovery code)
 *   GET  /v1/auth/two-factor        status; POST .../setup { password }, .../confirm { code },
 *                                   .../disable { password }, .../recovery-codes { code }
 *   POST /v1/auth/logout
 *   GET  /v1/auth/session           who is signed in, their business and permissions
 *   POST /v1/auth/password/change
 *   POST /v1/auth/password/forgot   { business, email }: always 204
 *   GET  /v1/auth/password/link/:t  who a reset or welcome link is for
 *   POST /v1/auth/password/reset    { token, password }: sets it and signs in
 *   GET  /v1/auth/business/:slug    a business's public name, for its login page
 *   GET  /v1/auth/slug?slug=        is an address free?
 *
 * Sessions live in httpOnly, SameSite=Lax cookies, one per business
 * ("etd_s_<slug>"), so someone can be signed in to two businesses in one
 * browser. Requests say which business they are for with the X-Business
 * header (or ?b=<slug> on plain links such as PDF downloads).
 *
 * Every state-changing request authenticated by cookie must also send
 * "X-Requested-With: etd-web": browsers will not attach a custom header
 * cross-site without a CORS preflight, and this API allows none.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { atLimit, countHit, overLimit } from '../db/ratelimit.ts';
import { createTenant, freeSlug, type NewTenant, slugify, slugProblem, slugTaken, tenantBySlug } from '../db/tenants.ts';
import {
  changePassword,
  checkCredentials,
  consumePasswordLink,
  createPasswordLink,
  createSession,
  createUser,
  deleteSession,
  findActiveUserByEmail,
  lookupSession,
  peekPasswordLink,
  getUserById,
  passwordMatches,
  SESSION_MAX_MS,
  type Session,
  twoFactorFor,
  type User,
} from '../db/users.ts';
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  createLoginChallenge,
  disableTwoFactor,
  endLoginChallenge,
  newRecoveryCodes,
  otpauthQr,
  otpauthUrl,
  TOTP_ISSUER,
  twoFactorStatus,
  useLoginChallenge,
  verifySecondFactor,
} from '../db/twofactor.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, requireMail, type ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { ROLE_PERMISSIONS } from './permissions.ts';
import { tenantSchema } from './schemas.ts';

export const SESSION_COOKIE_PREFIX = 'etd_s_';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'etd-web';
export const BUSINESS_HEADER = 'x-business';

export type AuthOptions = Pick<ServerContext, 'cookieSecure' | 'allowSignup'>;

export const sessionCookieName = (slug: string) => `${SESSION_COOKIE_PREFIX}${slug}`;

function cookies(request: FastifyRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out.set(k, decodeURIComponent(v.join('=')));
  }
  return out;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  return cookies(request).get(name);
}

/** The business a request is for: X-Business header, or ?b= on plain links. */
export function requestedBusiness(request: FastifyRequest): string | undefined {
  const header = request.headers[BUSINESS_HEADER];
  if (typeof header === 'string' && header) return header.toLowerCase();
  const b = (request.query as { b?: unknown } | undefined)?.b;
  return typeof b === 'string' && b ? b.toLowerCase() : undefined;
}

function sessionToken(request: FastifyRequest): string | undefined {
  const slug = requestedBusiness(request);
  const jar = cookies(request);
  if (slug) return jar.get(sessionCookieName(slug));
  // No business named: fine when the browser is signed in to exactly one.
  const tokens = [...jar].filter(([k]) => k.startsWith(SESSION_COOKIE_PREFIX)).map(([, v]) => v);
  return tokens.length === 1 ? tokens[0] : undefined;
}

export async function sessionFromRequest(deps: PipelineDeps, request: FastifyRequest): Promise<Session | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const session = await lookupSession(deps.db, token);
  const slug = requestedBusiness(request);
  return session && (!slug || session.business.slug === slug) ? session : null;
}

function setSessionCookie(reply: FastifyReply, slug: string, token: string, options: AuthOptions) {
  reply.header('set-cookie', `${sessionCookieName(slug)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_MS / 1000}${options.cookieSecure ? '; Secure' : ''}`);
}

function clearSessionCookie(reply: FastifyReply, slug: string, options: AuthOptions) {
  reply.header('set-cookie', `${sessionCookieName(slug)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.cookieSecure ? '; Secure' : ''}`);
}

export function requireCsrfHeader(request: FastifyRequest) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new ApiError(403, 'csrf', `Send the header X-Requested-With: ${CSRF_VALUE}`);
  }
}

// ---------- rate limiting (in the database, shared by every server process) ----------

const WINDOW_MS = 15 * 60 * 1000;

// ---------- responses ----------

export function userJson(u: User) {
  return { id: u.id, name: u.name, email: u.email, username: u.username, role: u.role, status: u.status, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt };
}

export function sessionBody(s: Pick<Session, 'user' | 'business' | 'twoFactor'>) {
  return {
    user: userJson(s.user),
    business: s.business,
    permissions: [...ROLE_PERMISSIONS[s.user.role]],
    twoFactor: { ...s.twoFactor, setupRequired: s.twoFactor.required && !s.twoFactor.enabled },
  };
}

const slugField = { type: 'string', minLength: 3, maxLength: 40 } as const;
const passwordField = { type: 'string', minLength: 1, maxLength: 200 } as const;
const tooMany = (wait = 'in 15 minutes') => new ApiError(429, 'too_many_attempts', `Too many attempts; try again ${wait}`);

export function registerAuthRoutes(app: FastifyInstance, deps: PipelineDeps, options: ServerContext) {
  const { db } = deps;
  app.addHook('onRequest', async (request) => requireCsrfHeader(request));

  const requireSession = async (request: FastifyRequest): Promise<Session> => {
    const session = await sessionFromRequest(deps, request);
    if (!session) throw new ApiError(401, 'unauthorized', 'Please log in');
    return session;
  };
  const businessOr404 = async (slug: string) => {
    const b = await tenantBySlug(db, slug.toLowerCase());
    if (!b) throw new ApiError(404, 'business_not_found', 'There is no business at this address. Check the link with your administrator.');
    return b;
  };
  const startSession = async (reply: FastifyReply, user: User, slug: string) => {
    const { token } = await createSession(db, user.id);
    setSessionCookie(reply, slug, token, options);
    const business = (await tenantBySlug(db, slug))!;
    return sessionBody({ user, business, twoFactor: await twoFactorFor(db, user) });
  };
  /** After the password: the session, or (when two-step sign-in is on) a challenge for the code. */
  const passwordAccepted = async (reply: FastifyReply, user: User, slug: string) => {
    if ((await twoFactorStatus(db, 'user', user.id)).enabled) {
      return { twoFactorRequired: true, challenge: await createLoginChallenge(db, 'user', user.id) };
    }
    return startSession(reply, user, slug);
  };

  // ---------- addresses ----------

  app.get<{ Querystring: { slug?: string; name?: string } }>(
    '/slug',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { slug: { type: 'string', maxLength: 60 }, name: { type: 'string', maxLength: 300 } } } } },
    async (request) => {
      if (request.query.name && !request.query.slug) return { slug: await freeSlug(db, slugify(request.query.name)), available: true, problem: null };
      const slug = (request.query.slug ?? '').toLowerCase();
      const problem = slugProblem(slug);
      if (problem) return { slug, available: false, problem };
      const taken = await slugTaken(db, slug);
      return { slug, available: !taken, problem: taken ? 'Another business already uses this address' : null };
    },
  );

  app.get<{ Params: { slug: string } }>('/business/:slug', async (request) => {
    if (await overLimit(db, `lookup|${request.ip}`, 300, WINDOW_MS)) throw tooMany();
    const b = await businessOr404(request.params.slug);
    return { slug: b.slug, name: b.tradeName ?? b.legalName };
  });

  // ---------- a new business and its first owner ----------

  // A business never chooses its address (slug): it is made from its name.
  const { environment: _env, slug: _slug, ...businessProperties } = tenantSchema.properties;
  app.post<{ Body: { business: Omit<NewTenant, 'environment'>; owner: { name: string; email: string; password: string } } }>(
    '/signup',
    {
      schema: {
        body: {
          type: 'object',
          required: ['business', 'owner'],
          additionalProperties: false,
          properties: {
            // No address field: it is made from the business's name.
            business: { ...tenantSchema, required: ['legalName', 'tin', 'address', 'contact'], properties: businessProperties },
            owner: {
              type: 'object',
              required: ['name', 'email', 'password'],
              additionalProperties: false,
              properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', minLength: 3, maxLength: 254 }, password: passwordField },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!options.allowSignup) throw new ApiError(403, 'signup_closed', 'Creating businesses is closed on this server');
      if (await overLimit(db, `signup|${request.ip}`, 20, WINDOW_MS)) throw tooMany('later');
      const { business, owner } = request.body;
      // Self-service businesses start in the BTS test environment; moving to production is an admin step.
      const dup = await db.query(`select 1 from tenants where tin = $1 and environment = 'test'`, [business.tin]);
      if (dup.rows.length) throw new ApiError(409, 'conflict', 'A business with this TIN is already registered. Ask its owner to create an account for you.');
      const { user, slug } = await db.transaction(async (tx) => {
        const tenantId = await createTenant(tx, { ...business, environment: 'test' });
        const created = await createUser(tx, { tenantId, name: owner.name, email: owner.email, password: owner.password, role: 'owner' });
        await audit(tx, { tenantId, userId: created.id, action: 'business.created', ip: request.ip });
        const s = (await tx.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
        return { user: created, slug: s };
      });
      return reply.code(201).send(await startSession(reply, user, slug));
    },
  );

  // ---------- sign in and out ----------

  app.post<{ Body: { business: string; login: string; password: string } }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['business', 'login', 'password'],
          additionalProperties: false,
          properties: { business: { type: 'string', minLength: 1, maxLength: 60 }, login: { type: 'string', minLength: 1, maxLength: 254 }, password: passwordField },
        },
      },
    },
    async (request, reply) => {
      const slug = request.body.business.toLowerCase();
      const login = request.body.login.trim().toLowerCase();
      const accountKey = `login|${request.ip}|${slug}|${login}`;
      const ipKey = `login|${request.ip}`;
      if (await atLimit(db, accountKey, 10) || await atLimit(db, ipKey, 50)) throw tooMany();
      const business = await businessOr404(slug);
      const result = await checkCredentials(db, business.id, login, request.body.password);
      if (!result.ok) {
        await countHit(db, accountKey, WINDOW_MS);
        await countHit(db, ipKey, WINDOW_MS);
        await audit(db, { tenantId: business.id, action: 'login.failed', target: login, ip: request.ip });
        if (result.reason === 'disabled') throw new ApiError(403, 'account_disabled', 'This account is deactivated. Ask an administrator of this business.');
        throw new ApiError(401, 'invalid_credentials', 'Email, username or password is incorrect');
      }
      const next = await passwordAccepted(reply, result.user, business.slug);
      if (!('twoFactorRequired' in next)) await audit(db, { tenantId: business.id, userId: result.user.id, action: 'login', ip: request.ip });
      return next;
    },
  );

  app.post<{ Body: { challenge: string; code: string } }>(
    '/login/verify',
    { schema: { body: { type: 'object', required: ['challenge', 'code'], additionalProperties: false, properties: { challenge: { type: 'string', maxLength: 100 }, code: { type: 'string', minLength: 6, maxLength: 20 } } } } },
    async (request, reply) => {
      const ipKey = `2fa|${request.ip}`;
      if (await atLimit(db, ipKey, 30)) throw tooMany();
      const userId = await useLoginChallenge(db, 'user', request.body.challenge);
      if (!userId) throw new ApiError(401, 'challenge_expired', 'This sign-in has expired. Enter your password again.');
      const user = await getUserById(db, userId);
      if (!user || user.status !== 'active') throw new ApiError(401, 'challenge_expired', 'This sign-in has expired. Enter your password again.');
      const method = await verifySecondFactor(db, deps.keys, 'user', user.id, request.body.code);
      if (!method) {
        await countHit(db, ipKey, WINDOW_MS);
        await audit(db, { tenantId: user.tenantId, userId: user.id, action: 'login.code_failed', ip: request.ip });
        throw new ApiError(401, 'invalid_code', 'That code is not right. Try the newest code from your app.');
      }
      await endLoginChallenge(db, request.body.challenge);
      await audit(db, { tenantId: user.tenantId, userId: user.id, action: 'login', details: { twoFactor: method }, ip: request.ip });
      const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [user.tenantId])).rows[0]!.slug;
      return startSession(reply, user, slug);
    },
  );

  app.post('/logout', async (request, reply) => {
    const session = await sessionFromRequest(deps, request);
    const slug = session?.business.slug ?? requestedBusiness(request);
    const token = slug ? readCookie(request, sessionCookieName(slug)) : undefined;
    if (token) await deleteSession(db, token);
    if (slug) clearSessionCookie(reply, slug, options);
    return reply.code(204).send();
  });

  app.get('/session', async (request) => sessionBody(await requireSession(request)));

  // ---------- two-step sign-in (for the signed-in person) ----------

  const confirmPassword = async (session: Session, password: string) => {
    if (!(await passwordMatches(db, session.user.id, password))) throw new ApiError(403, 'wrong_password', 'Your password is not right');
  };
  const passwordBody = { type: 'object', required: ['password'], additionalProperties: false, properties: { password: passwordField } } as const;
  const codeBody = { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 6, maxLength: 20 } } } as const;
  const log = (session: Session, action: string, ip: string) => audit(db, { tenantId: session.business.id, userId: session.user.id, action, target: session.user.email ?? session.user.username ?? session.user.name, ip });

  app.get('/two-factor', async (request) => {
    const session = await requireSession(request);
    return { ...(await twoFactorStatus(db, 'user', session.user.id)), required: session.twoFactor.required };
  });

  app.post<{ Body: { password: string } }>('/two-factor/setup', { schema: { body: passwordBody } }, async (request) => {
    const session = await requireSession(request);
    if (await overLimit(db, `2fa-setup|${session.user.id}`, 10, WINDOW_MS)) throw tooMany();
    await confirmPassword(session, request.body.password);
    const secret = await beginTwoFactorSetup(db, deps.keys, 'user', session.user.id);
    const account = `${session.user.email ?? session.user.username ?? session.user.name} (${session.business.slug})`;
    const url = otpauthUrl(TOTP_ISSUER, account, secret);
    return { secret, otpauthUrl: url, qr: await otpauthQr(url) };
  });

  app.post<{ Body: { code: string } }>('/two-factor/confirm', { schema: { body: codeBody } }, async (request) => {
    const session = await requireSession(request);
    if (await overLimit(db, `2fa-setup|${session.user.id}`, 10, WINDOW_MS)) throw tooMany();
    const recoveryCodes = await confirmTwoFactorSetup(db, deps.keys, 'user', session.user.id, request.body.code);
    await log(session, 'two_factor.enabled', request.ip);
    return { recoveryCodes };
  });

  app.post<{ Body: { password: string } }>('/two-factor/disable', { schema: { body: passwordBody } }, async (request) => {
    const session = await requireSession(request);
    if (session.twoFactor.required) throw new ApiError(409, 'two_factor_required', 'Your business requires two-step sign-in for your role');
    await confirmPassword(session, request.body.password);
    if (await disableTwoFactor(db, 'user', session.user.id)) await log(session, 'two_factor.disabled', request.ip);
    return { enabled: false };
  });

  app.post<{ Body: { code: string } }>('/two-factor/recovery-codes', { schema: { body: codeBody } }, async (request) => {
    const session = await requireSession(request);
    if (await overLimit(db, `2fa-setup|${session.user.id}`, 10, WINDOW_MS)) throw tooMany();
    if ((await verifySecondFactor(db, deps.keys, 'user', session.user.id, request.body.code)) !== 'totp') {
      throw new ApiError(422, 'invalid_code', 'Enter the current code from your authenticator app');
    }
    const recoveryCodes = await newRecoveryCodes(db, 'user', session.user.id);
    await log(session, 'two_factor.recovery_codes', request.ip);
    return { recoveryCodes };
  });

  // ---------- passwords ----------

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/password/change',
    { schema: { body: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: passwordField, newPassword: passwordField } } } },
    async (request, reply) => {
      const session = await requireSession(request);
      if (await overLimit(db, `change|${session.user.id}`, 10, WINDOW_MS)) throw tooMany();
      if (!(await changePassword(db, session.user.id, request.body.currentPassword, request.body.newPassword, session.id))) {
        throw new ApiError(422, 'wrong_password', 'Your current password is incorrect');
      }
      await audit(db, { tenantId: session.business.id, userId: session.user.id, action: 'password.changed', ip: request.ip });
      return reply.code(204).send();
    },
  );

  // Always 204, whether or not the email has an account here, so the form cannot be used to find out who is registered.
  app.post<{ Body: { business: string; email: string } }>(
    '/password/forgot',
    { schema: { body: { type: 'object', required: ['business', 'email'], additionalProperties: false, properties: { business: { type: 'string', minLength: 1, maxLength: 60 }, email: { type: 'string', minLength: 3, maxLength: 254 } } } } },
    async (request, reply) => {
      requireMail(options);
      publicLink(options, '/'); // fail now, not silently in the background, when links cannot be built
      const email = request.body.email.trim().toLowerCase();
      if (await overLimit(db, `forgot|${request.ip}`, 20, WINDOW_MS) || await overLimit(db, `forgot|${email}`, 5, WINDOW_MS)) throw tooMany();
      const business = await businessOr404(request.body.business);
      // In the background, so the response time does not reveal whether the account exists.
      void (async () => {
        const user = await findActiveUserByEmail(db, business.id, email);
        if (!user?.email) return;
        const token = await createPasswordLink(db, user.id, 'reset');
        const link = publicLink(options, `/${business.slug}/reset-password?token=${token}`);
        const name = business.tradeName ?? business.legalName;
        await options.mailer.send({
          to: user.email,
          subject: `Reset your ${name} password`,
          text: `Hello ${user.name},\n\nSomeone (hopefully you) asked to reset your password for ${name} on eInvoicing.\n\nChoose a new password here (the link works for one hour):\n${link}\n\nIf you did not ask for this, ignore this email; your password stays the same.`,
          html: simpleHtml({
            heading: 'Reset your password',
            paragraphs: [`Hello ${user.name},`, `Someone (hopefully you) asked to reset your password for ${name} on eInvoicing. The link works for one hour.`, 'If you did not ask for this, ignore this email; your password stays the same.'],
            button: { label: 'Choose a new password', url: link },
          }),
        });
        await audit(db, { tenantId: business.id, userId: user.id, action: 'password.reset_requested', ip: request.ip });
      })().catch((e) => request.log.error({ err: e }, 'password reset email failed'));
      return reply.code(204).send();
    },
  );

  const invalidLink = () => new ApiError(400, 'invalid_token', 'This link is invalid, already used or expired. Ask for a new one.');

  app.get<{ Params: { token: string } }>('/password/link/:token', async (request) => {
    if (await overLimit(db, `link|${request.ip}`, 60, WINDOW_MS)) throw tooMany();
    const found = await peekPasswordLink(db, request.params.token);
    if (!found) throw invalidLink();
    const business = (await db.query<{ slug: string; name: string }>('select slug, coalesce(trade_name, legal_name) as name from tenants where id = $1', [found.user.tenantId])).rows[0]!;
    return { purpose: found.purpose, name: found.user.name, login: found.user.email ?? found.user.username, business };
  });

  app.post<{ Body: { token: string; password: string } }>(
    '/password/reset',
    { schema: { body: { type: 'object', required: ['token', 'password'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 100 }, password: passwordField } } } },
    async (request, reply) => {
      if (await overLimit(db, `reset|${request.ip}`, 30, WINDOW_MS)) throw tooMany('later');
      const user = await consumePasswordLink(db, request.body.token, request.body.password);
      if (!user) throw invalidLink();
      const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [user.tenantId])).rows[0]!.slug;
      await audit(db, { tenantId: user.tenantId, userId: user.id, action: 'password.reset', ip: request.ip });
      // With two-step sign-in on, a reset link alone does not sign in: the code is still needed.
      return passwordAccepted(reply, user, slug);
    },
  );
}
