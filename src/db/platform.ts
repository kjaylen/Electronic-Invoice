/**
 * Platform staff (the people who run this service, not businesses): their
 * accounts, sessions and permanent audit log. Staff accounts are created from
 * the command line (npm run platform-admin), never by sign-up.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from './database.ts';
import { AccountError, hashPassword, MIN_PASSWORD_LENGTH, normalizeEmail, tokenHash, verifyPassword } from './users.ts';

export const PLATFORM_SESSION_IDLE_MS = 12 * 3600 * 1000;
export const PLATFORM_SESSION_MAX_MS = 7 * 24 * 3600 * 1000;

export interface PlatformAdmin {
  id: string;
  email: string;
  name: string;
}

export async function createPlatformAdmin(db: Queryable, input: { email: string; name: string; password: string }): Promise<PlatformAdmin> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('Enter a valid email address');
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  if ((await db.query('select 1 from platform_admins where lower(email) = $1', [email])).rows.length) throw new AccountError('A platform admin with this email already exists');
  const id = randomUUID();
  await db.query('insert into platform_admins (id, email, name, password_hash) values ($1, $2, $3, $4)', [id, email, input.name.trim(), await hashPassword(input.password)]);
  return { id, email, name: input.name.trim() };
}

export async function setPlatformAdminPassword(db: Queryable, email: string, password: string): Promise<boolean> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  const r = await db.query<{ id: string }>('update platform_admins set password_hash = $2 where lower(email) = $1 returning id', [normalizeEmail(email), await hashPassword(password)]);
  if (!r.rows[0]) return false;
  await db.query('delete from platform_sessions where admin_id = $1', [r.rows[0].id]);
  return true;
}

export async function setPlatformAdminStatus(db: Queryable, email: string, status: 'active' | 'disabled'): Promise<boolean> {
  const r = await db.query<{ id: string }>('update platform_admins set status = $2 where lower(email) = $1 returning id', [normalizeEmail(email), status]);
  if (r.rows[0] && status === 'disabled') await db.query('delete from platform_sessions where admin_id = $1', [r.rows[0].id]);
  return Boolean(r.rows[0]);
}

export async function listPlatformAdmins(db: Queryable): Promise<Array<PlatformAdmin & { status: string; lastLoginAt: string | null }>> {
  const rows = (await db.query<{ id: string; email: string; name: string; status: string; last_login_at: string | Date | null }>('select id, email, name, status, last_login_at from platform_admins order by created_at')).rows;
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, status: r.status, lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null }));
}

let dummyHash: Promise<string> | undefined;

export async function checkPlatformCredentials(db: Queryable, email: string, password: string): Promise<PlatformAdmin | null> {
  const row = (await db.query<{ id: string; email: string; name: string; password_hash: string; status: string }>(
    'select id, email, name, password_hash, status from platform_admins where lower(email) = $1', [normalizeEmail(email)],
  )).rows[0];
  if (!row) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash)) || row.status !== 'active') return null;
  await db.query('update platform_admins set last_login_at = now() where id = $1', [row.id]);
  return { id: row.id, email: row.email, name: row.name };
}

export async function createPlatformSession(db: Queryable, adminId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into platform_sessions (id, token_hash, admin_id, expires_at) values ($1, $2, $3, $4)', [
    randomUUID(), tokenHash(token), adminId, new Date(Date.now() + PLATFORM_SESSION_IDLE_MS).toISOString(),
  ]);
  return token;
}

export async function lookupPlatformSession(db: Queryable, token: string): Promise<PlatformAdmin | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db.query<{ session_id: string; created_at: string | Date; expires_at: string | Date; id: string; email: string; name: string; status: string }>(
    `select s.id as session_id, s.created_at, s.expires_at, a.id, a.email, a.name, a.status
     from platform_sessions s join platform_admins a on a.id = s.admin_id where s.token_hash = $1`,
    [tokenHash(token)],
  )).rows[0];
  if (!row) return null;
  const now = Date.now();
  const created = new Date(row.created_at).getTime();
  if (row.status !== 'active' || new Date(row.expires_at).getTime() <= now || created + PLATFORM_SESSION_MAX_MS <= now) {
    await db.query('delete from platform_sessions where id = $1', [row.session_id]);
    return null;
  }
  db.query(`update platform_sessions set last_seen_at = now(), expires_at = $2 where id = $1 and last_seen_at < now() - interval '1 minute'`, [
    row.session_id, new Date(Math.min(now + PLATFORM_SESSION_IDLE_MS, created + PLATFORM_SESSION_MAX_MS)).toISOString(),
  ]).catch(() => {});
  return { id: row.id, email: row.email, name: row.name };
}

export async function deletePlatformSession(db: Queryable, token: string): Promise<void> {
  await db.query('delete from platform_sessions where token_hash = $1', [tokenHash(token)]);
}

export async function platformAudit(db: Queryable, e: { adminId: string | null; tenantId?: string | null; action: string; details?: Record<string, unknown>; ip?: string | null }): Promise<void> {
  await db.query('insert into platform_audit (admin_id, tenant_id, action, details, ip) values ($1, $2, $3, $4, $5)', [
    e.adminId, e.tenantId ?? null, e.action, e.details ? JSON.stringify(e.details) : null, e.ip ?? null,
  ]);
}
