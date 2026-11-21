/**
 * People, memberships and sessions.
 *
 * Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), compared in
 * constant time. Stored as "scrypt$N$r$p$salt$hash" so parameters can be raised
 * later without breaking existing accounts.
 *
 * Sessions: a 32-byte random token in an httpOnly cookie; only its SHA-256 is
 * stored. Sessions slide: each use extends them, up to an absolute maximum.
 */

import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Database } from './database.ts';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 10;
export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;

export class AccountError extends Error {
  override name = 'AccountError';
}

export type Role = 'owner' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  tenantId: string;
  role: Role;
  legalName: string;
  tradeName: string | null;
  environment: string;
}

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

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createUser(db: Database, input: { email: string; name: string; password: string }): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('Enter a valid email address');
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!input.name.trim()) throw new AccountError('Enter your name');
  const exists = await db.query('select 1 from users where lower(email) = $1', [email]);
  if (exists.rows.length) throw new AccountError('An account with this email already exists');
  const id = randomUUID();
  await db.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)', [id, email, input.name.trim(), await hashPassword(input.password)]);
  return { id, email, name: input.name.trim() };
}

// A fixed hash to compare against when the email is unknown, so timing does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;

export async function checkCredentials(db: Database, email: string, password: string): Promise<User | null> {
  const row = (await db.query<{ id: string; email: string; name: string; password_hash: string }>(
    'select id, email, name, password_hash from users where lower(email) = $1', [normalizeEmail(email)],
  )).rows[0];
  if (!row) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, row.password_hash)) ? { id: row.id, email: row.email, name: row.name } : null;
}

export async function memberships(db: Database, userId: string): Promise<Membership[]> {
  const rows = (await db.query<{ tenant_id: string; role: Role; legal_name: string; trade_name: string | null; environment: string }>(
    `select m.tenant_id, m.role, t.legal_name, t.trade_name, t.environment
     from memberships m join tenants t on t.id = m.tenant_id where m.user_id = $1 order by m.created_at`,
    [userId],
  )).rows;
  return rows.map((r) => ({ tenantId: r.tenant_id, role: r.role, legalName: r.legal_name, tradeName: r.trade_name, environment: r.environment }));
}

export async function addMembership(db: Database, userId: string, tenantId: string, role: Role): Promise<void> {
  await db.query('insert into memberships (user_id, tenant_id, role) values ($1, $2, $3) on conflict (user_id, tenant_id) do update set role = excluded.role', [userId, tenantId, role]);
}

// ---------- sessions ----------

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export interface Session {
  id: string;
  user: User;
  currentTenantId: string | null;
  role: Role | null;
}

export async function createSession(db: Database, userId: string, currentTenantId: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
  await db.query('insert into sessions (id, token_hash, user_id, current_tenant_id, expires_at) values ($1, $2, $3, $4, $5)', [
    randomUUID(), tokenHash(token), userId, currentTenantId, expiresAt.toISOString(),
  ]);
  return { token, expiresAt };
}

export async function lookupSession(db: Database, token: string): Promise<Session | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db.query<{ id: string; user_id: string; email: string; name: string; current_tenant_id: string | null; role: Role | null; created_at: string | Date; expires_at: string | Date }>(
    `select s.id, s.user_id, u.email, u.name, s.current_tenant_id, m.role, s.created_at, s.expires_at
     from sessions s join users u on u.id = s.user_id
     left join memberships m on m.user_id = s.user_id and m.tenant_id = s.current_tenant_id
     where s.token_hash = $1`,
    [tokenHash(token)],
  )).rows[0];
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now || new Date(row.created_at).getTime() + SESSION_MAX_MS <= now) {
    await db.query('delete from sessions where id = $1', [row.id]);
    return null;
  }
  // Slide the idle expiry, at most once a minute.
  db.query(`update sessions set last_seen_at = now(), expires_at = $2 where id = $1 and last_seen_at < now() - interval '1 minute'`, [
    row.id, new Date(Math.min(now + SESSION_IDLE_MS, new Date(row.created_at).getTime() + SESSION_MAX_MS)).toISOString(),
  ]).catch(() => {});
  return {
    id: row.id,
    user: { id: row.user_id, email: row.email, name: row.name },
    // A business the person no longer belongs to is not current.
    currentTenantId: row.role ? row.current_tenant_id : null,
    role: row.role,
  };
}

export async function setSessionTenant(db: Database, sessionId: string, tenantId: string | null): Promise<void> {
  await db.query('update sessions set current_tenant_id = $2 where id = $1', [sessionId, tenantId]);
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash(token)]);
}

// ---------- passwords: change and reset ----------

export const RESET_TTL_MS = 60 * 60 * 1000;

function checkNewPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
}

/** Replace the password and sign the person out everywhere (except the session kept, if any). */
export async function setPassword(db: Database, userId: string, password: string, keepSessionId?: string): Promise<void> {
  checkNewPassword(password);
  await db.query('update users set password_hash = $2 where id = $1', [userId, await hashPassword(password)]);
  await db.query('delete from sessions where user_id = $1 and id is distinct from $2', [userId, keepSessionId ?? null]);
}

export async function changePassword(db: Database, userId: string, current: string, next: string, keepSessionId: string): Promise<boolean> {
  const row = (await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId])).rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) return false;
  await setPassword(db, userId, next, keepSessionId);
  return true;
}

/** A one-time reset token for this email, or null when no account has it. Earlier unused tokens stop working. */
export async function createPasswordReset(db: Database, email: string): Promise<{ token: string; user: User } | null> {
  const user = (await db.query<User>('select id, email, name from users where lower(email) = $1', [normalizeEmail(email)])).rows[0];
  if (!user) return null;
  const token = randomBytes(32).toString('base64url');
  await db.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [user.id]);
  await db.query('insert into password_resets (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)', [
    randomUUID(), user.id, tokenHash(token), new Date(Date.now() + RESET_TTL_MS).toISOString(),
  ]);
  return { token, user };
}

/** Use a reset token: sets the password, signs out all sessions. Null when the token is unknown, used or expired. */
export async function consumePasswordReset(db: Database, token: string, password: string): Promise<User | null> {
  checkNewPassword(password);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db.query<{ user_id: string }>(
    `update password_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id`,
    [tokenHash(token)],
  )).rows[0];
  if (!row) return null;
  await setPassword(db, row.user_id, password);
  return (await db.query<User>('select id, email, name from users where id = $1', [row.user_id])).rows[0] ?? null;
}

export async function findUserByEmail(db: Database, email: string): Promise<User | null> {
  return (await db.query<User>('select id, email, name from users where lower(email) = $1', [normalizeEmail(email)])).rows[0] ?? null;
}

export { normalizeEmail, tokenHash };
