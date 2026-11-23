/**
 * Two-step sign-in with an authenticator app (TOTP, RFC 6238: HMAC-SHA1,
 * 6 digits, 30-second steps), for business accounts ('user') and platform
 * staff ('staff').
 *
 * The shared secret is encrypted at rest like certificate keys. A code is
 * accepted one step either side of now, and never twice (the last step used
 * is kept). Ten single-use recovery codes are given at setup, stored hashed.
 *
 * Signing in is two requests: the password gives a short-lived challenge
 * token (5 minutes, 5 tries), and the code with that token gives the session.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import type { Queryable } from './database.ts';
import type { KeyProtector } from './keystore.ts';

export type OwnerKind = 'user' | 'staff';

/** The name authenticator apps show next to the code. */
export const TOTP_ISSUER = 'Floreo';

// ---------- TOTP ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const STEP_SECONDS = 30;
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The 6-digit code for a step. */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** The step a code matches (now, or one step either side), or null. */
export function matchTotp(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** The link an authenticator app reads from the QR code. */
export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** The otpauth link as a QR code image (an SVG data URL) for the setup screen. */
export async function otpauthQr(url: string): Promise<string> {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

// ---------- stored secrets ----------

const context = (kind: OwnerKind, ownerId: string) => `totp:${kind}:${ownerId}`;
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Recovery codes are shown as xxxxx-xxxxx; spaces, dashes and case do not matter when typed. */
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export async function twoFactorStatus(db: Queryable, kind: OwnerKind, ownerId: string): Promise<TwoFactorStatus> {
  const row = (await db.query<{ enabled: boolean; left: number }>(
    `select exists (select 1 from two_factor where owner_kind = $1 and owner_id = $2 and confirmed_at is not null) as enabled,
            (select count(*)::int from recovery_codes where owner_kind = $1 and owner_id = $2 and used_at is null) as left`,
    [kind, ownerId],
  )).rows[0]!;
  return { enabled: row.enabled, recoveryCodesLeft: row.left };
}

/** Start (or restart) setup: a new secret, not active until confirmed with a code. */
export async function beginTwoFactorSetup(db: Queryable, keys: KeyProtector, kind: OwnerKind, ownerId: string): Promise<string> {
  const status = await twoFactorStatus(db, kind, ownerId);
  if (status.enabled) throw new TwoFactorError('already_enabled', 'Two-step sign-in is already on. Turn it off first to set up a new device.');
  const secret = randomBytes(20);
  const encrypted = await keys.encrypt(secret, context(kind, ownerId));
  await db.query(
    `insert into two_factor (owner_kind, owner_id, secret_encrypted) values ($1, $2, $3)
     on conflict (owner_kind, owner_id) do update set secret_encrypted = excluded.secret_encrypted, confirmed_at = null, last_step = null, created_at = now()`,
    [kind, ownerId, encrypted],
  );
  return base32Encode(secret);
}

/** Confirm setup with a code from the app; returns the recovery codes (shown once). */
export async function confirmTwoFactorSetup(db: Queryable, keys: KeyProtector, kind: OwnerKind, ownerId: string, code: string): Promise<string[]> {
  const row = (await db.query<{ secret_encrypted: string; confirmed_at: string | null }>(
    'select secret_encrypted, confirmed_at from two_factor where owner_kind = $1 and owner_id = $2', [kind, ownerId],
  )).rows[0];
  if (!row) throw new TwoFactorError('not_started', 'Start the setup first');
  if (row.confirmed_at) throw new TwoFactorError('already_enabled', 'Two-step sign-in is already on');
  const step = matchTotp(await keys.decrypt(row.secret_encrypted, context(kind, ownerId)), code.trim());
  if (step === null) throw new TwoFactorError('invalid_code', 'That code is not right. Check the time on your phone and try the newest code.');
  await db.query('update two_factor set confirmed_at = now(), last_step = $3 where owner_kind = $1 and owner_id = $2', [kind, ownerId, step]);
  return newRecoveryCodes(db, kind, ownerId);
}

/** Replace all recovery codes with ten new ones. */
export async function newRecoveryCodes(db: Queryable, kind: OwnerKind, ownerId: string): Promise<string[]> {
  await db.query('delete from recovery_codes where owner_kind = $1 and owner_id = $2', [kind, ownerId]);
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const raw = randomBytes(8).toString('hex').slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    await db.query('insert into recovery_codes (id, owner_kind, owner_id, code_hash) values ($1, $2, $3, $4)', [randomUUID(), kind, ownerId, hash(raw)]);
  }
  return codes;
}

/**
 * Check a code from the app or a recovery code. A code is used once: the
 * step is recorded atomically, so the same code cannot sign in twice.
 */
export async function verifySecondFactor(db: Queryable, keys: KeyProtector, kind: OwnerKind, ownerId: string, code: string): Promise<'totp' | 'recovery' | null> {
  const row = (await db.query<{ secret_encrypted: string }>(
    'select secret_encrypted from two_factor where owner_kind = $1 and owner_id = $2 and confirmed_at is not null', [kind, ownerId],
  )).rows[0];
  if (!row) return null;
  const trimmed = code.trim().replace(/\s/g, '');
  if (/^\d{6}$/.test(trimmed)) {
    const step = matchTotp(await keys.decrypt(row.secret_encrypted, context(kind, ownerId)), trimmed);
    if (step === null) return null;
    const used = await db.query(
      'update two_factor set last_step = $3 where owner_kind = $1 and owner_id = $2 and (last_step is null or last_step < $3) returning owner_id',
      [kind, ownerId, step],
    );
    return used.rows.length ? 'totp' : null;
  }
  const normalized = normalizeRecovery(code);
  if (normalized.length !== 10) return null;
  const used = await db.query(
    `update recovery_codes set used_at = now() where owner_kind = $1 and owner_id = $2 and code_hash = $3 and used_at is null returning id`,
    [kind, ownerId, hash(normalized)],
  );
  return used.rows.length ? 'recovery' : null;
}

export async function disableTwoFactor(db: Queryable, kind: OwnerKind, ownerId: string): Promise<boolean> {
  const r = await db.query('delete from two_factor where owner_kind = $1 and owner_id = $2 returning owner_id', [kind, ownerId]);
  await db.query('delete from recovery_codes where owner_kind = $1 and owner_id = $2', [kind, ownerId]);
  return r.rows.length > 0;
}

// ---------- the step between password and code ----------

const CHALLENGE_MS = 5 * 60 * 1000;
const CHALLENGE_TRIES = 5;

export async function createLoginChallenge(db: Queryable, kind: OwnerKind, ownerId: string): Promise<string> {
  await db.query('delete from login_challenges where expires_at < now()');
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into login_challenges (token_hash, owner_kind, owner_id, expires_at) values ($1, $2, $3, $4)', [
    hash(token), kind, ownerId, new Date(Date.now() + CHALLENGE_MS).toISOString(),
  ]);
  return token;
}

/** Who a challenge is for, counting this as a try; null when unknown, expired or out of tries. */
export async function useLoginChallenge(db: Queryable, kind: OwnerKind, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await db.query<{ owner_id: string }>(
    `update login_challenges set attempts = attempts + 1
     where token_hash = $1 and owner_kind = $2 and expires_at > now() and attempts < $3 returning owner_id`,
    [hash(token), kind, CHALLENGE_TRIES],
  )).rows[0];
  return row?.owner_id ?? null;
}

export async function endLoginChallenge(db: Queryable, token: string): Promise<void> {
  await db.query('delete from login_challenges where token_hash = $1', [hash(token)]);
}

export class TwoFactorError extends Error {
  override name = 'TwoFactorError';
  readonly code: 'already_enabled' | 'not_started' | 'invalid_code';
  constructor(code: TwoFactorError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
