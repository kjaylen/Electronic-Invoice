/**
 * Point-of-sale tills: the iOS, Android and desktop apps (and the web till at /pos).
 *
 * In the web app (signed in, business.manage):
 *   GET    /v1/pos/devices               the tills: waiting to pair or paired, last seen, the hardware they report
 *   POST   /v1/pos/devices               add a till { name, registerId? } -> a one-time pairing code
 *   POST   /v1/pos/devices/:id/code      a new pairing code (pairs again; the old token stops working)
 *   PATCH  /v1/pos/devices/:id           rename, or move to another cash drawer
 *   DELETE /v1/pos/devices/:id           remove: the till's token and everyone signed in on it stop working
 *
 * From the till app:
 *   POST   /v1/pos/pair                  { code, platform?, appVersion? } -> the till's device token (no sign-in)
 *   GET    /v1/pos/till                  the business, this till, who can sign in here    (Bearer <device token>)
 *   POST   /v1/pos/sign-in               { userId, pin } -> a session on this till        (Bearer <device token>)
 *   POST   /v1/pos/pin                   { login, password, pin } set my PIN here         (Bearer <device token>)
 *   POST   /v1/pos/heartbeat             { platform, appVersion, hardware }               (Bearer <device token>)
 *   POST   /v1/pos/unpair                the till forgets its token                       (Bearer <device token>)
 *
 * Signed in on a till (Bearer pos_<session token>), the app uses the usual
 * API as that person with their role, limited to what a till does (see
 * TILL_ROUTES): selling, refunds, the cash drawer, the catalog, online
 * orders and invoice payments. Settings, people, keys and exports stay in
 * the web app.
 *
 * The device token and session tokens are random; only their SHA-256 is
 * stored. PINs are stored like passwords. Five wrong PINs for a person on a
 * till lock that person out of that till for 15 minutes.
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { atLimit, clearLimit, countHit, overLimit } from '../db/ratelimit.ts';
import { AccountError, checkCredentials, checkPin, createSession, setPin } from '../db/users.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { type Permission, requirePermission, ROLE_PERMISSIONS, type Role } from './permissions.ts';
import { uuid } from './schemas.ts';

export const DEVICE_TOKEN_PREFIX = 'till_';
export const SESSION_TOKEN_PREFIX = 'pos_';
const PAIRING_TTL_MS = 30 * 60 * 1000;
const PIN_FAILURES = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;
/** Unambiguous letters and digits (no 0/O, 1/I/L) for codes read off a screen. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** What a person can do on a till: their role's permissions, within these. */
export const TILL_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'documents.issue', 'documents.adjust', 'documents.cancel', 'documents.send', 'orders.manage', 'payments.record', 'reports.view',
  'venue.orders', 'venue.approve', 'venue.floor', 'venue.kitchen', 'hotel.frontdesk', 'hotel.housekeeping',
]);

/** The API routes a till session may use (method and route pattern). */
export const TILL_ROUTES: ReadonlySet<string> = new Set([
  // Table service, the bar and the kitchen screen (the hospitality module).
  'GET /v1/venue', 'POST /v1/venue/ops', 'GET /v1/venue/changes', 'GET /v1/venue/checks/:id', 'POST /v1/venue/tickets/:id/:what', 'POST /v1/venue/approve',
  'POST /v1/venue/items/:id/availability', 'POST /v1/venue/waste', 'PUT /v1/venue/sections', 'POST /v1/venue/menu-override',
  // The host stand, a server's checkout and the day's close.
  'GET /v1/venue/reservations', 'POST /v1/venue/reservations', 'PUT /v1/venue/reservations/:id', 'POST /v1/venue/reservations/:id/seat', 'POST /v1/venue/reservations/:id/cancel', 'POST /v1/venue/reservations/:id/no-show',
  'POST /v1/venue/reservations/:id/apply-deposit', 'POST /v1/venue/reservations/:id/message', 'POST /v1/venue/waitlist', 'POST /v1/venue/waitlist/:id/notify', 'POST /v1/venue/waitlist/:id/seat', 'POST /v1/venue/waitlist/:id/left',
  'GET /v1/venue/guests', 'GET /v1/venue/guests/:id', 'PUT /v1/venue/guests/:id', 'GET /v1/venue/checkout', 'GET /v1/venue/day', 'POST /v1/venue/day/close',
  // Charging to a room, and a housekeeper's phone.
  'GET /v1/hotel/in-house', 'GET /v1/hotel/housekeeping', 'POST /v1/hotel/rooms/:id/status',
  'GET /v1/me',
  'GET /v1/business',
  'GET /v1/items',
  'GET /v1/items/:id',
  'GET /v1/customers',
  'GET /v1/customers/:id',
  'GET /v1/documents',
  'POST /v1/documents',
  'POST /v1/documents/preview',
  'GET /v1/documents/:id',
  'GET /v1/documents/:id/view',
  'GET /v1/documents/:id/pdf',
  'POST /v1/documents/:id/email',
  'POST /v1/documents/:id/share',
  'POST /v1/documents/:id/cancel',
  'GET /v1/documents/:id/payments',
  'POST /v1/documents/:id/payments',
  'GET /v1/registers',
  'GET /v1/shifts',
  'POST /v1/shifts',
  'GET /v1/shifts/current',
  'GET /v1/shifts/:id',
  'GET /v1/shifts/:id/report.pdf',
  'POST /v1/shifts/:id/cash',
  'POST /v1/shifts/:id/close',
  'GET /v1/orders',
  'GET /v1/orders/:id',
  'POST /v1/orders/:id/paid',
  'POST /v1/orders/:id/fulfilled',
  'POST /v1/orders/:id/cancel',
]);

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

function newPairingCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** The permissions a person has on a till. */
export function tillPermissions(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]].filter((p) => TILL_PERMISSIONS.has(p));
}

interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  register_id: string;
  register_name: string;
  token_hash: string | null;
  platform: string | null;
  app_version: string | null;
  hardware: Record<string, unknown> | null;
  created_at: Date | string;
  paired_at: Date | string | null;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
}

const DEVICE_COLUMNS = 'd.id, d.tenant_id, d.name, d.register_id, r.name as register_name, d.token_hash, d.platform, d.app_version, d.hardware, d.created_at, d.paired_at, d.last_seen_at, d.revoked_at';
const DEVICE_FROM = 'pos_devices d join registers r on r.id = d.register_id';
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

async function deviceJson(db: Queryable, d: DeviceRow) {
  const shift = (await db.query<{ number: number; opened_by: string; opened_at: Date | string }>(
    `select s.number, u.name as opened_by, s.opened_at from register_shifts s join users u on u.id = s.opened_by where s.register_id = $1 and s.closed_at is null`,
    [d.register_id],
  )).rows[0];
  const signedIn = (await db.query<{ name: string }>(
    'select distinct u.name from sessions s join users u on u.id = s.user_id where s.device_id = $1 and s.expires_at > now() order by u.name',
    [d.id],
  )).rows.map((r) => r.name);
  return {
    id: d.id,
    name: d.name,
    register: { id: d.register_id, name: d.register_name },
    status: d.revoked_at ? 'removed' as const : d.token_hash ? 'paired' as const : 'waiting' as const,
    platform: d.platform,
    appVersion: d.app_version,
    hardware: d.hardware,
    createdAt: iso(d.created_at),
    pairedAt: iso(d.paired_at),
    lastSeenAt: iso(d.last_seen_at),
    openShift: shift ? { number: shift.number, openedBy: shift.opened_by, openedAt: iso(shift.opened_at) } : null,
    signedIn,
  };
}

async function loadDevice(db: Queryable, tenantId: string, id: string): Promise<DeviceRow> {
  const d = (await db.query<DeviceRow>(`select ${DEVICE_COLUMNS} from ${DEVICE_FROM} where d.id = $1 and d.tenant_id = $2 and d.revoked_at is null`, [id, tenantId])).rows[0];
  if (!d) throw notFound('Till');
  return d;
}

/** A fresh pairing code for a till; earlier codes for it stop working. */
async function issuePairingCode(db: Queryable, tenantId: string, deviceId: string) {
  await db.query('delete from pos_pairing_codes where device_id = $1', [deviceId]);
  const code = newPairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.query('insert into pos_pairing_codes (code_hash, device_id, tenant_id, expires_at) values ($1, $2, $3, $4)', [tokenHash(normalizeCode(code)), deviceId, tenantId, expiresAt.toISOString()]);
  return { code, expiresAt: expiresAt.toISOString() };
}

/** The register a new till sells into: the one chosen, or one named like the till (created if needed). */
async function registerForTill(db: Queryable, tenantId: string, name: string, registerId: string | undefined): Promise<string> {
  let id = registerId;
  if (id) {
    if (!(await db.query('select 1 from registers where id = $1 and tenant_id = $2 and archived_at is null', [id, tenantId])).rows.length) {
      throw new ApiError(422, 'invalid_register', 'That cash drawer is not in your list');
    }
  } else {
    id = (await db.query<{ id: string }>('select id from registers where tenant_id = $1 and lower(name) = lower($2) and archived_at is null', [tenantId, name])).rows[0]?.id;
    if (!id) {
      id = randomUUID();
      await db.query('insert into registers (id, tenant_id, name) values ($1, $2, $3)', [id, tenantId, name]);
    }
  }
  const taken = (await db.query<{ name: string }>('select name from pos_devices where register_id = $1 and revoked_at is null', [id])).rows[0];
  if (taken) throw new ApiError(409, 'register_taken', `The till "${taken.name}" already uses that cash drawer`);
  return id;
}

/** The till behind a device token, if it is paired and not removed. */
export async function deviceFromToken(db: Queryable, request: FastifyRequest): Promise<DeviceRow> {
  const h = request.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) throw new ApiError(401, 'unauthorized', 'This till is not paired');
  const d = (await db.query<DeviceRow>(`select ${DEVICE_COLUMNS} from ${DEVICE_FROM} where d.token_hash = $1 and d.revoked_at is null`, [tokenHash(token)])).rows[0];
  if (!d) throw new ApiError(401, 'unpaired', 'This till was removed or paired again; pair it with a new code');
  return d;
}

const tillUsersSql = `select u.id, u.name, u.role, u.pos_pin_set_at is not null as has_pin from users u
  where u.tenant_id = $1 and u.status = 'active' and u.role not in ('accountant') order by lower(u.name)`;

// ---------- web app: managing tills ----------

export function registerPosAdminRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const manage = (request: FastifyRequest) => {
    if (request.principal === 'api' || request.posDevice) throw new ApiError(403, 'forbidden', 'Tills are managed in the web app');
    requirePermission(request, 'business.manage');
  };
  const log = (request: FastifyRequest, action: string, target: string, details?: Record<string, unknown>) =>
    audit(db, { tenantId: request.tenantId, userId: request.userId || null, action, target, ...(details && { details }), ip: request.ip });

  app.get('/pos/devices', async (request) => {
    manage(request);
    const rows = (await db.query<DeviceRow>(`select ${DEVICE_COLUMNS} from ${DEVICE_FROM} where d.tenant_id = $1 and d.revoked_at is null order by d.created_at`, [request.tenantId])).rows;
    return { data: await Promise.all(rows.map((d) => deviceJson(db, d))) };
  });

  app.post<{ Body: { name: string; registerId?: string } }>(
    '/pos/devices',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, registerId: uuid } } } },
    async (request, reply) => {
      manage(request);
      const name = request.body.name.trim();
      if (!name) throw new ApiError(422, 'invalid_name', 'Give the till a name');
      const id = randomUUID();
      const pairing = await db.transaction(async (tx) => {
        const registerId = await registerForTill(tx, request.tenantId, name, request.body.registerId);
        try {
          await tx.query('insert into pos_devices (id, tenant_id, name, register_id, created_by) values ($1, $2, $3, $4, $5)', [id, request.tenantId, name, registerId, request.userId || null]);
        } catch (e) {
          if (/pos_devices_name/.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', 'There is already a till with that name');
          throw e;
        }
        return issuePairingCode(tx, request.tenantId, id);
      });
      await log(request, 'till.added', name);
      return reply.code(201).send({ device: await deviceJson(db, await loadDevice(db, request.tenantId, id)), pairing });
    },
  );

  app.post<{ Params: { id: string } }>('/pos/devices/:id/code', { schema: { params: idParams } }, async (request) => {
    manage(request);
    const d = await loadDevice(db, request.tenantId, request.params.id);
    const pairing = await issuePairingCode(db, request.tenantId, d.id);
    return { device: await deviceJson(db, d), pairing };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; registerId?: string } }>(
    '/pos/devices/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, registerId: uuid } } } },
    async (request) => {
      manage(request);
      const d = await loadDevice(db, request.tenantId, request.params.id);
      const name = request.body.name?.trim() || d.name;
      let registerId = d.register_id;
      if (request.body.registerId && request.body.registerId !== d.register_id) {
        if ((await db.query('select 1 from register_shifts where register_id = $1 and closed_at is null', [d.register_id])).rows.length) {
          throw new ApiError(409, 'shift_open', 'Close the shift on this till first');
        }
        registerId = await registerForTill(db, request.tenantId, name, request.body.registerId);
      }
      try {
        await db.query('update pos_devices set name = $3, register_id = $4 where id = $1 and tenant_id = $2', [d.id, request.tenantId, name, registerId]);
      } catch (e) {
        if (/pos_devices_name/.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', 'There is already a till with that name');
        throw e;
      }
      if (name !== d.name || registerId !== d.register_id) await log(request, 'till.updated', name);
      return { device: await deviceJson(db, await loadDevice(db, request.tenantId, d.id)) };
    },
  );

  app.delete<{ Params: { id: string } }>('/pos/devices/:id', { schema: { params: idParams } }, async (request, reply) => {
    manage(request);
    const d = await loadDevice(db, request.tenantId, request.params.id);
    await db.transaction(async (tx) => {
      await tx.query('update pos_devices set revoked_at = now(), revoked_by = $3, token_hash = null where id = $1 and tenant_id = $2', [d.id, request.tenantId, request.userId || null]);
      await tx.query('delete from sessions where device_id = $1', [d.id]);
      await tx.query('delete from pos_pairing_codes where device_id = $1', [d.id]);
    });
    await log(request, 'till.removed', d.name);
    return reply.code(204).send();
  });
}

// ---------- the till app ----------

export function registerPosDeviceRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const appInfo = {
    platform: { type: 'string', maxLength: 30 },
    appVersion: { type: 'string', maxLength: 30 },
  } as const;

  app.post<{ Body: { code: string; platform?: string; appVersion?: string } }>(
    '/pair',
    { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 4, maxLength: 20 }, ...appInfo } } } },
    async (request) => {
      if (await overLimit(db, `pospair|${request.ip}`, 20, 15 * 60 * 1000)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      const hash = tokenHash(normalizeCode(request.body.code));
      const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const deviceId = await db.transaction(async (tx) => {
        const used = await tx.query<{ device_id: string }>(
          'update pos_pairing_codes set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning device_id', [hash],
        );
        const id = used.rows[0]?.device_id;
        if (!id) throw new ApiError(422, 'invalid_code', 'That code is wrong or has expired. Ask a manager for a new one.');
        const paired = await tx.query(
          'update pos_devices set token_hash = $2, paired_at = now(), last_seen_at = now(), platform = coalesce($3, platform), app_version = coalesce($4, app_version) where id = $1 and revoked_at is null returning id',
          [id, tokenHash(token), request.body.platform ?? null, request.body.appVersion ?? null],
        );
        if (!paired.rows.length) throw new ApiError(422, 'invalid_code', 'That till was removed. Ask a manager for a new code.');
        // Pairing again replaces the old token: whoever was signed in with it is signed out.
        await tx.query('delete from sessions where device_id = $1', [id]);
        return id;
      });
      const d = (await db.query<DeviceRow>(`select ${DEVICE_COLUMNS} from ${DEVICE_FROM} where d.id = $1`, [deviceId])).rows[0]!;
      await audit(db, { tenantId: d.tenant_id, userId: null, action: 'till.paired', target: d.name, details: { platform: request.body.platform ?? null }, ip: request.ip });
      return { token, till: await tillJson(d) };
    },
  );

  const tillJson = async (d: DeviceRow) => {
    const biz = (await db.query<{ slug: string; name: string; tin: string; environment: string }>(
      'select slug, coalesce(trade_name, legal_name) as name, tin, environment from tenants where id = $1', [d.tenant_id],
    )).rows[0]!;
    const users = (await db.query<{ id: string; name: string; role: Role; has_pin: boolean }>(tillUsersSql, [d.tenant_id])).rows;
    return {
      business: biz,
      device: { id: d.id, name: d.name, register: { id: d.register_id, name: d.register_name } },
      users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, hasPin: u.has_pin })),
    };
  };

  app.get('/till', async (request) => tillJson(await deviceFromToken(db, request)));

  app.post<{ Body: { userId: string; pin: string } }>(
    '/sign-in',
    { schema: { body: { type: 'object', required: ['userId', 'pin'], additionalProperties: false, properties: { userId: uuid, pin: { type: 'string', minLength: 1, maxLength: 12 } } } } },
    async (request) => {
      const d = await deviceFromToken(db, request);
      const limitKey = `pospin|${d.id}|${request.body.userId}`;
      if (await atLimit(db, limitKey, PIN_FAILURES)) throw new ApiError(429, 'too_many_attempts', 'Too many wrong PINs. Try again in 15 minutes, or ask a manager to reset your PIN.');
      const user = await checkPin(db, d.tenant_id, request.body.userId, request.body.pin);
      // Anyone with something to do on a till: selling, or the floor, the kitchen screen, the rooms.
      if (!user || !tillPermissions(user.role).some((p) => p === 'documents.issue' || p.startsWith('venue.') || p.startsWith('hotel.'))) {
        const failures = await countHit(db, limitKey, PIN_WINDOW_MS);
        const left = PIN_FAILURES - failures;
        throw new ApiError(401, 'wrong_pin', left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.');
      }
      await clearLimit(db, limitKey);
      const session = await createSession(db, user.id, { deviceId: d.id });
      await db.query('update pos_devices set last_seen_at = now() where id = $1', [d.id]);
      await audit(db, { tenantId: d.tenant_id, userId: user.id, action: 'till.signed_in', target: d.name, ip: request.ip });
      return {
        token: `${SESSION_TOKEN_PREFIX}${session.token}`,
        expiresAt: session.expiresAt.toISOString(),
        user: { id: user.id, name: user.name, role: user.role },
        permissions: tillPermissions(user.role),
      };
    },
  );

  app.post<{ Body: { login: string; password: string; pin: string } }>(
    '/pin',
    { schema: { body: { type: 'object', required: ['login', 'password', 'pin'], additionalProperties: false, properties: { login: { type: 'string', minLength: 1, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 200 }, pin: { type: 'string', minLength: 1, maxLength: 12 } } } } },
    async (request) => {
      const d = await deviceFromToken(db, request);
      if (await overLimit(db, `pospinset|${d.id}`, 10, 15 * 60 * 1000)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      const result = await checkCredentials(db, d.tenant_id, request.body.login, request.body.password);
      if (!result.ok) throw new ApiError(401, 'invalid_credentials', result.reason === 'disabled' ? 'This account is deactivated' : 'Wrong email, username or password');
      if (!tillPermissions(result.user.role).includes('documents.issue')) throw new ApiError(403, 'forbidden', 'Your role does not sell at the till');
      try {
        await setPin(db, d.tenant_id, result.user.id, request.body.pin);
      } catch (e) {
        if (e instanceof AccountError) throw new ApiError(422, 'invalid_pin', e.message);
        throw e;
      }
      await audit(db, { tenantId: d.tenant_id, userId: result.user.id, action: 'user.pin_set', target: result.user.email ?? result.user.username, details: { till: d.name }, ip: request.ip });
      return { ok: true, user: { id: result.user.id, name: result.user.name } };
    },
  );

  app.post<{ Body: { platform?: string; appVersion?: string; hardware?: Record<string, unknown> } }>(
    '/heartbeat',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { ...appInfo, hardware: { type: 'object', maxProperties: 20 } } } } },
    async (request) => {
      const d = await deviceFromToken(db, request);
      const hardware = request.body.hardware ? JSON.stringify(request.body.hardware) : null;
      if (hardware && hardware.length > 8000) throw new ApiError(413, 'too_large', 'The hardware report is too large');
      await db.query(
        'update pos_devices set last_seen_at = now(), platform = coalesce($2, platform), app_version = coalesce($3, app_version), hardware = coalesce($4::jsonb, hardware) where id = $1',
        [d.id, request.body.platform ?? null, request.body.appVersion ?? null, hardware],
      );
      return { ok: true };
    },
  );

  // Locking the till: the cashier's session ends (Bearer pos_<session token>).
  app.post('/sign-out', async (request, reply) => {
    const h = request.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (token.startsWith(SESSION_TOKEN_PREFIX)) {
      await db.query('delete from sessions where token_hash = $1 and device_id is not null', [tokenHash(token.slice(SESSION_TOKEN_PREFIX.length))]);
    }
    return reply.code(204).send();
  });

  app.post('/unpair', async (request, reply) => {
    const d = await deviceFromToken(db, request);
    await db.transaction(async (tx) => {
      await tx.query('update pos_devices set token_hash = null where id = $1', [d.id]);
      await tx.query('delete from sessions where device_id = $1', [d.id]);
    });
    await audit(db, { tenantId: d.tenant_id, userId: null, action: 'till.unpaired', target: d.name, ip: request.ip });
    return reply.code(204).send();
  });
}

/** Mark the till as seen (at most once a minute) when someone uses it. */
export function touchDevice(db: Queryable, deviceId: string) {
  db.query("update pos_devices set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '1 minute')", [deviceId]).catch(() => {});
}

/** May a till session use this route? */
export function tillMayUse(request: FastifyRequest): boolean {
  return TILL_ROUTES.has(`${request.method} ${request.routeOptions.url ?? ''}`);
}

