/**
 * API keys: "etd_<prefix>_<secret>". The prefix (public, unique) finds the
 * row; the secret is 32 random bytes, stored only as a SHA-256 hash and
 * compared in constant time. A fast hash is fine here because the secret is
 * long and random, unlike a password.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from './database.ts';

export interface ApiKeyPrincipal {
  keyId: string;
  tenantId: string;
  name: string;
}

const KEY_PATTERN = /^etd_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const hash = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

/** Create a key for a tenant. The returned secret is shown once and never stored. */
export async function createApiKey(db: Database, tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
  if (!name?.trim()) throw new Error('An API key needs a name');
  const prefix = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
  const secret = randomBytes(32).toString('base64url');
  const id = randomUUID();
  await db.query('insert into api_keys (id, tenant_id, name, prefix, key_hash) values ($1, $2, $3, $4, $5)', [id, tenantId, name.trim(), prefix, hash(secret)]);
  return { id, prefix, key: `etd_${prefix}_${secret}` };
}

/** Resolve a presented key to its tenant, or null. Never says why a key failed. */
export async function authenticateApiKey(db: Database, presented: string): Promise<ApiKeyPrincipal | null> {
  const m = KEY_PATTERN.exec(presented.trim());
  if (!m) return null;
  const [, prefix, secret] = m;
  const row = (
    await db.query<{ id: string; tenant_id: string; name: string; key_hash: string; revoked_at: unknown; suspended: boolean }>(
      'select k.id, k.tenant_id, k.name, k.key_hash, k.revoked_at, (t.suspended_at is not null or t.closed_at is not null) as suspended from api_keys k join tenants t on t.id = k.tenant_id where k.prefix = $1',
      [prefix],
    )
  ).rows[0];
  if (!row || row.revoked_at || row.suspended) return null;
  const expected = Buffer.from(row.key_hash, 'hex');
  const actual = Buffer.from(hash(secret!), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  // Best effort; never fails the request.
  db.query('update api_keys set last_used_at = now() where id = $1', [row.id]).catch(() => {});
  return { keyId: row.id, tenantId: row.tenant_id, name: row.name };
}

export async function revokeApiKey(db: Database, tenantId: string, keyId: string): Promise<boolean> {
  const r = await db.query<{ id: string }>('update api_keys set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null returning id', [keyId, tenantId]);
  return r.rows.length === 1;
}
