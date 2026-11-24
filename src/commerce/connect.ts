/**
 * Connecting a site built somewhere else: publishable keys.
 *
 * A publishable key ("pk_test_…" in the BTS test environment, "pk_live_…" in
 * production) is safe to put in a web page. It opens only the public store
 * API (/v1/store/:slug/...), which needs no sign-in anyway, and only from
 * the sites on its list. It is not a secret: it says which integration is
 * calling, which sites may call from a browser, and whether the store it
 * was made for is a test store or a live one.
 *
 *   test keys   any site on this computer (localhost, 127.0.0.1, a file opened
 *               from disk) may call, besides the sites listed
 *   live keys   only the sites listed, and only over https
 *
 * Keys are kept in the store's settings (they are not secrets, and the store
 * is loaded on every request anyway). Secret keys ("etd_…", src/db/apikeys.ts)
 * are a different thing: they act as the whole business and never belong in
 * a page.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.ts';

export interface PublishableKey {
  id: string;
  key: string;
  name: string;
  /** Sites that may call from a browser: "https://www.example.bz" (scheme, host and port only). */
  origins: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface ConnectSettings {
  keys: PublishableKey[];
}

export type KeyMode = 'test' | 'live';

export const MAX_ACTIVE_KEYS = 10;
export const MAX_ORIGINS = 20;
/** Revoked keys are kept for a while so a refusal can say "revoked" rather than "unknown". */
const MAX_KEPT_KEYS = 40;

export const PUBLISHABLE_KEY_PATTERN = /^pk_(test|live)_[A-Za-z0-9]{24}$/;
export const looksPublishable = (value: string) => value.startsWith('pk_');
export const keyMode = (key: string): KeyMode => (key.startsWith('pk_live_') ? 'live' : 'test');
export const modeOf = (environment: string): KeyMode => (environment === 'production' ? 'live' : 'test');

export class ConnectError extends Error {
  override name = 'ConnectError';
  readonly code: 'not_found' | 'invalid_origin' | 'too_many_keys' | 'invalid_key';
  constructor(code: ConnectError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function connectDefaults(stored: Partial<ConnectSettings> | null | undefined): ConnectSettings {
  return { keys: Array.isArray(stored?.keys) ? stored.keys : [] };
}

// ---------- sites (origins) ----------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** A site on the developer's own computer. */
export function isLocalOrigin(origin: string): boolean {
  if (origin === 'null') return true; // a page opened from disk, or a sandboxed frame
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

/**
 * What a person typed ("www.example.bz", "https://example.bz/shop/") as the
 * origin browsers send ("https://www.example.bz"). Throws with a reason.
 */
export function normalizeOrigin(raw: string, mode: KeyMode): string {
  const typed = raw.trim();
  if (!typed) throw new ConnectError('invalid_origin', 'Enter the address of the site, for example https://www.example.bz');
  if (typed.includes('*')) throw new ConnectError('invalid_origin', `"${typed}": list each site by its full address; wildcards are not accepted`);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new ConnectError('invalid_origin', `"${typed}" is not a site address. Use the form https://www.example.bz`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConnectError('invalid_origin', `"${typed}": a site address starts with https://`);
  if (url.username || url.password) throw new ConnectError('invalid_origin', `"${typed}": leave out the user name and password`);
  const origin = url.origin.toLowerCase();
  if (url.protocol === 'http:' && !isLocalOrigin(origin)) {
    throw new ConnectError('invalid_origin', mode === 'live'
      ? `"${typed}": a live site must use https://`
      : `"${typed}": use https://, or http:// only for a site on your own computer (localhost)`);
  }
  if (!url.hostname.includes('.') && !isLocalOrigin(origin)) throw new ConnectError('invalid_origin', `"${typed}" is not a full site address. Use the form https://www.example.bz`);
  return origin;
}

export function normalizeOrigins(raw: readonly string[], mode: KeyMode): string[] {
  const out = [...new Set(raw.map((o) => normalizeOrigin(o, mode)))];
  if (out.length > MAX_ORIGINS) throw new ConnectError('invalid_origin', `A key can list up to ${MAX_ORIGINS} sites`);
  return out;
}

/** May a page on `origin` use this key? */
export function originAllowed(key: PublishableKey, origin: string): boolean {
  const o = origin.toLowerCase();
  return key.origins.includes(o) || (keyMode(key.key) === 'test' && isLocalOrigin(o));
}

/** May a buyer be sent back to this address after paying? The same rule as for calling. */
export function returnUrlAllowed(key: PublishableKey, raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && originAllowed(key, u.origin);
  } catch {
    return false;
  }
}

// ---------- checking a presented key ----------

export type KeyCheck =
  | { ok: true; key: PublishableKey }
  | { ok: false; reason: 'unknown' | 'revoked' | 'test_key_on_live_store' | 'live_key_on_test_store' };

/** A presented key against a store's keys and its environment. */
export function checkKey(connect: ConnectSettings, environment: string, presented: string): KeyCheck {
  const key = connect.keys.find((k) => k.key === presented.trim());
  if (!key) return { ok: false, reason: 'unknown' };
  if (key.revokedAt) return { ok: false, reason: 'revoked' };
  const mode = keyMode(key.key);
  if (mode !== modeOf(environment)) return { ok: false, reason: mode === 'test' ? 'test_key_on_live_store' : 'live_key_on_test_store' };
  return { ok: true, key };
}

// ---------- managing keys ----------

async function load(db: Queryable, tenantId: string): Promise<{ connect: ConnectSettings; mode: KeyMode }> {
  const r = (await db.query<{ connect: Partial<ConnectSettings> | null; environment: string }>(
    `select store_settings -> 'connect' as connect, environment from tenants where id = $1 for update`, [tenantId],
  )).rows[0];
  if (!r) throw new ConnectError('not_found', 'Business not found');
  return { connect: connectDefaults(r.connect), mode: modeOf(r.environment) };
}

/** Only the keys change: nothing else in the store's settings is touched, whatever was saved meanwhile. */
async function save(db: Queryable, tenantId: string, connect: ConnectSettings): Promise<void> {
  const revoked = connect.keys.filter((k) => k.revokedAt).sort((a, b) => String(b.revokedAt).localeCompare(String(a.revokedAt)));
  const keep = new Set(revoked.slice(0, Math.max(0, MAX_KEPT_KEYS - connect.keys.filter((k) => !k.revokedAt).length)).map((k) => k.id));
  const keys = connect.keys.filter((k) => !k.revokedAt || keep.has(k.id));
  await db.query(`update tenants set store_settings = jsonb_set(coalesce(store_settings, '{}'::jsonb), '{connect}', $2::jsonb) where id = $1`, [tenantId, JSON.stringify({ keys })]);
}

export async function listPublishableKeys(db: Queryable, tenantId: string): Promise<{ keys: PublishableKey[]; mode: KeyMode }> {
  const r = (await db.query<{ connect: Partial<ConnectSettings> | null; environment: string }>(`select store_settings -> 'connect' as connect, environment from tenants where id = $1`, [tenantId])).rows[0];
  if (!r) throw new ConnectError('not_found', 'Business not found');
  return { keys: connectDefaults(r.connect).keys, mode: modeOf(r.environment) };
}

type Transactional = Pick<Database, 'transaction'>;

const newKeyValue = (mode: KeyMode) => {
  // Letters and digits only, so a key can be selected with a double click and sits safely in an attribute.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 24) for (const b of randomBytes(32)) if (b < 248 && out.length < 24) out += alphabet[b % 62];
  return `pk_${mode}_${out}`;
};

export async function createPublishableKey(db: Transactional, tenantId: string, input: { name: string; origins?: readonly string[] }): Promise<PublishableKey> {
  return db.transaction(async (tx) => {
    const { connect, mode } = await load(tx, tenantId);
    if (connect.keys.filter((k) => !k.revokedAt).length >= MAX_ACTIVE_KEYS) throw new ConnectError('too_many_keys', `A store can have up to ${MAX_ACTIVE_KEYS} publishable keys. Revoke one you no longer use.`);
    const key: PublishableKey = {
      id: randomUUID(), key: newKeyValue(mode), name: input.name.trim(), origins: normalizeOrigins(input.origins ?? [], mode),
      createdAt: new Date().toISOString(), revokedAt: null,
    };
    await save(tx, tenantId, { keys: [...connect.keys, key] });
    return key;
  });
}

export async function updatePublishableKey(db: Transactional, tenantId: string, id: string, input: { name?: string; origins?: readonly string[] }): Promise<PublishableKey> {
  return db.transaction(async (tx) => {
    const { connect } = await load(tx, tenantId);
    const key = connect.keys.find((k) => k.id === id);
    if (!key) throw new ConnectError('not_found', 'Publishable key not found');
    if (key.revokedAt) throw new ConnectError('invalid_key', 'This key was revoked; make a new one');
    // A key keeps the rules of the environment it was made for.
    const next: PublishableKey = { ...key, ...(input.name !== undefined && { name: input.name.trim() }), ...(input.origins && { origins: normalizeOrigins(input.origins, keyMode(key.key)) }) };
    await save(tx, tenantId, { keys: connect.keys.map((k) => (k.id === id ? next : k)) });
    return next;
  });
}

export async function revokePublishableKey(db: Transactional, tenantId: string, id: string): Promise<PublishableKey> {
  return db.transaction(async (tx) => {
    const { connect } = await load(tx, tenantId);
    const key = connect.keys.find((k) => k.id === id);
    if (!key) throw new ConnectError('not_found', 'Publishable key not found');
    if (key.revokedAt) return key;
    const next = { ...key, revokedAt: new Date().toISOString() };
    await save(tx, tenantId, { keys: connect.keys.map((k) => (k.id === id ? next : k)) });
    return next;
  });
}
