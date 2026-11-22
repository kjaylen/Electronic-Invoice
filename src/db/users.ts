/**
 * Accounts and sessions. Every account belongs to one business, which
 * manages it: creates it, sets its role, resets its password, deactivates it.
 * People sign in with their email or a username (for staff without email).
 *
 * Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), compared in
 * constant time. Stored as "scrypt$N$r$p$salt$hash" so parameters can be raised
 * later without breaking existing accounts.
 *
 * Sessions: a 32-byte random token in an httpOnly cookie; only its SHA-256 is
 * stored. Sessions slide: each use extends them, up to an absolute maximum.
 */

import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Role } from '../api/permissions.ts';
import type { Database, Queryable } from './database.ts';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 10;
export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const WELCOME_TTL_MS = 7 * 24 * 3600 * 1000;

export class AccountError extends Error {
  override name = 'AccountError';
}

export type { Role };
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  username: string | null;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface BusinessRef {
  id: string;
  slug: string;
  legalName: string;
  tradeName: string | null;
  environment: string;
}

interface UserRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  username: string | null;
  role: Role;
  status: UserStatus;
  must_change_password: boolean;
  last_login_at: string | Date | null;
  created_at: string | Date;
}

const USER_COLUMNS = 'u.id, u.tenant_id, u.name, u.email, u.username, u.role, u.status, u.must_change_password, u.last_login_at, u.created_at';

const toUser = (r: UserRow): User => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  email: r.email,
  username: r.username,
  role: r.role,
  status: r.status,
  mustChangePassword: r.must_change_password,
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const normalizeUsername = (username: string) => username.trim().toLowerCase();
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function checkNewPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
}

function checkIdentity(email: string | null, username: string | null) {
  if (!email && !username) throw new AccountError('Give an email address or a username');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('Enter a valid email address');
  if (username && !/^[a-z0-9][a-z0-9._-]{1,39}$/.test(username)) {
    throw new AccountError('A username is 2 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  }
}

/** Friendly message for the unique indexes on email and username within a business. */
async function withUniqueCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e as Error).message);
    if (/users_tenant_email/.test(msg)) throw new AccountError('Someone in this business already uses this email');
    if (/users_tenant_username/.test(msg)) throw new AccountError('Someone in this business already uses this username');
    throw e;
  }
}

export interface NewUser {
  tenantId: string;
  name: string;
  email?: string | null;
  username?: string | null;
  role: Role;
  /** Unset: the account gets an unusable password until a welcome link is used. */
  password?: string;
  mustChangePassword?: boolean;
  createdBy?: string | null;
}

export async function createUser(db: Queryable, input: NewUser): Promise<User> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const username = input.username ? normalizeUsername(input.username) : null;
  checkIdentity(email, username);
  if (!input.name.trim()) throw new AccountError('Enter a name');
  if (input.password !== undefined) checkNewPassword(input.password);
  const id = randomUUID();
  const hash = await hashPassword(input.password ?? randomBytes(32).toString('base64'));
  await withUniqueCheck(() => db.query(
    `insert into users (id, tenant_id, name, email, username, role, password_hash, must_change_password, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.tenantId, input.name.trim(), email, username, input.role, hash, input.mustChangePassword ?? false, input.createdBy ?? null],
  ));
  return (await getUser(db, input.tenantId, id))!;
}

export async function getUser(db: Queryable, tenantId: string, id: string): Promise<User | null> {
  const r = (await db.query<UserRow>(`select ${USER_COLUMNS} from users u where u.id = $1 and u.tenant_id = $2`, [id, tenantId])).rows[0];
  return r ? toUser(r) : null;
}

export async function listUsers(db: Queryable, tenantId: string): Promise<User[]> {
  const rows = (await db.query<UserRow>(
    `select ${USER_COLUMNS} from users u where u.tenant_id = $1 order by u.status, case u.role when 'owner' then 0 when 'admin' then 1 when 'manager' then 2 else 3 end, lower(u.name)`,
    [tenantId],
  )).rows;
  return rows.map(toUser);
}

export async function updateUser(db: Queryable, tenantId: string, id: string, patch: { name?: string; email?: string | null; username?: string | null; role?: Role }): Promise<User> {
  const current = await getUser(db, tenantId, id);
  if (!current) throw new AccountError('Account not found');
  const email = patch.email === undefined ? current.email : patch.email ? normalizeEmail(patch.email) : null;
  const username = patch.username === undefined ? current.username : patch.username ? normalizeUsername(patch.username) : null;
  checkIdentity(email, username);
  const name = patch.name?.trim() ?? current.name;
  if (!name) throw new AccountError('Enter a name');
  await withUniqueCheck(() => db.query('update users set name = $3, email = $4, username = $5, role = $6 where id = $1 and tenant_id = $2', [
    id, tenantId, name, email, username, patch.role ?? current.role,
  ]));
  return (await getUser(db, tenantId, id))!;
}

export async function setUserStatus(db: Queryable, tenantId: string, id: string, status: UserStatus): Promise<void> {
  await db.query('update users set status = $3 where id = $1 and tenant_id = $2', [id, tenantId, status]);
  if (status === 'disabled') await signOutEverywhere(db, id);
}

export async function activeOwnerCount(db: Queryable, tenantId: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from users where tenant_id = $1 and role = 'owner' and status = 'active'`, [tenantId])).rows[0]!.n;
}

// A fixed hash to compare against when the account is unknown, so timing does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;

export type CredentialResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'disabled' };

/** Sign-in with an email or a username, within one business. */
export async function checkCredentials(db: Queryable, tenantId: string, login: string, password: string): Promise<CredentialResult> {
  const value = login.trim().toLowerCase();
  const row = (await db.query<UserRow & { password_hash: string }>(
    `select ${USER_COLUMNS}, u.password_hash from users u where u.tenant_id = $1 and (lower(u.email) = $2 or u.username = $2) limit 1`,
    [tenantId, value],
  )).rows[0];
  if (!row) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummyHash);
    return { ok: false, reason: 'invalid' };
  }
  if (!(await verifyPassword(password, row.password_hash))) return { ok: false, reason: 'invalid' };
  // Only someone who knows the password learns that the account is deactivated.
  if (row.status !== 'active') return { ok: false, reason: 'disabled' };
  await db.query('update users set last_login_at = now() where id = $1', [row.id]);
  return { ok: true, user: toUser(row) };
}

// ---------- passwords ----------

/** Replace the password and sign the person out everywhere (except the session kept, if any). */
export async function setPassword(db: Queryable, userId: string, password: string, opts: { keepSessionId?: string; mustChange?: boolean } = {}): Promise<void> {
  checkNewPassword(password);
  await db.query('update users set password_hash = $2, must_change_password = $3 where id = $1', [userId, await hashPassword(password), opts.mustChange ?? false]);
  await db.query('delete from sessions where user_id = $1 and id is distinct from $2', [userId, opts.keepSessionId ?? null]);
}

export async function changePassword(db: Queryable, userId: string, current: string, next: string, keepSessionId: string): Promise<boolean> {
  const row = (await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId])).rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) return false;
  if (current === next) throw new AccountError('Choose a password different from the current one');
  await setPassword(db, userId, next, { keepSessionId });
  return true;
}

/** A one-time link token for an account: "reset" (1 hour) or "welcome" (7 days). Earlier unused links stop working. */
export async function createPasswordLink(db: Queryable, userId: string, purpose: 'reset' | 'welcome'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [userId]);
  await db.query('insert into password_resets (id, user_id, token_hash, expires_at, purpose) values ($1, $2, $3, $4, $5)', [
    randomUUID(), userId, tokenHash(token), new Date(Date.now() + (purpose === 'welcome' ? WELCOME_TTL_MS : RESET_TTL_MS)).toISOString(), purpose,
  ]);
  return token;
}

/** The active account with this email in this business, for "forgot password". */
export async function findActiveUserByEmail(db: Queryable, tenantId: string, email: string): Promise<User | null> {
  const r = (await db.query<UserRow>(`select ${USER_COLUMNS} from users u where u.tenant_id = $1 and lower(u.email) = $2 and u.status = 'active'`, [tenantId, normalizeEmail(email)])).rows[0];
  return r ? toUser(r) : null;
}

/** Who a password link is for, without using it (to greet them on the page). */
export async function peekPasswordLink(db: Queryable, token: string): Promise<{ user: User; purpose: 'reset' | 'welcome' } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = (await db.query<UserRow & { purpose: 'reset' | 'welcome' }>(
    `select ${USER_COLUMNS}, p.purpose from password_resets p join users u on u.id = p.user_id
     where p.token_hash = $1 and p.used_at is null and p.expires_at > now() and u.status = 'active'`,
    [tokenHash(token)],
  )).rows[0];
  return r ? { user: toUser(r), purpose: r.purpose } : null;
}

/** Use a password link: sets the password, signs out all sessions. Null when the link is unknown, used, expired, or the account is off. */
export async function consumePasswordLink(db: Database, token: string, password: string): Promise<User | null> {
  checkNewPassword(password);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.transaction(async (tx) => {
    const row = (await tx.query<{ user_id: string; tenant_id: string }>(
      `update password_resets p set used_at = now() from users u
       where p.token_hash = $1 and p.used_at is null and p.expires_at > now() and u.id = p.user_id and u.status = 'active'
       returning p.user_id, u.tenant_id`,
      [tokenHash(token)],
    )).rows[0];
    if (!row) return null;
    await setPassword(tx, row.user_id, password);
    return getUser(tx, row.tenant_id, row.user_id);
  });
}

// ---------- sessions ----------

export interface Session {
  id: string;
  user: User;
  business: BusinessRef;
}

export async function createSession(db: Queryable, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
  await db.query('insert into sessions (id, token_hash, user_id, expires_at) values ($1, $2, $3, $4)', [randomUUID(), tokenHash(token), userId, expiresAt.toISOString()]);
  return { token, expiresAt };
}

export async function lookupSession(db: Queryable, token: string): Promise<Session | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db.query<UserRow & { session_id: string; s_created_at: string | Date; expires_at: string | Date; slug: string; legal_name: string; trade_name: string | null; environment: string }>(
    `select ${USER_COLUMNS}, s.id as session_id, s.created_at as s_created_at, s.expires_at, t.slug, t.legal_name, t.trade_name, t.environment
     from sessions s join users u on u.id = s.user_id join tenants t on t.id = u.tenant_id
     where s.token_hash = $1`,
    [tokenHash(token)],
  )).rows[0];
  if (!row) return null;
  const now = Date.now();
  const created = new Date(row.s_created_at).getTime();
  if (row.status !== 'active' || new Date(row.expires_at).getTime() <= now || created + SESSION_MAX_MS <= now) {
    await db.query('delete from sessions where id = $1', [row.session_id]);
    return null;
  }
  // Slide the idle expiry, at most once a minute.
  db.query(`update sessions set last_seen_at = now(), expires_at = $2 where id = $1 and last_seen_at < now() - interval '1 minute'`, [
    row.session_id, new Date(Math.min(now + SESSION_IDLE_MS, created + SESSION_MAX_MS)).toISOString(),
  ]).catch(() => {});
  return {
    id: row.session_id,
    user: toUser(row),
    business: { id: row.tenant_id, slug: row.slug, legalName: row.legal_name, tradeName: row.trade_name, environment: row.environment },
  };
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash(token)]);
}

export async function signOutEverywhere(db: Queryable, userId: string): Promise<number> {
  const r = await db.query<{ id: string }>('delete from sessions where user_id = $1 returning id', [userId]);
  return r.rows.length;
}

export async function activeSessionCount(db: Queryable, userId: string): Promise<number> {
  return (await db.query<{ n: number }>('select count(*)::int as n from sessions where user_id = $1 and expires_at > now()', [userId])).rows[0]!.n;
}
