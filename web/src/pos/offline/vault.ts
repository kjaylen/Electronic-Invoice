/**
 * The key that locks the till's local data, and locking and unlocking with it
 * (AES-GCM, 256 bits, a fresh 96-bit IV per record).
 *
 * Where the key lives:
 *   - desktop: the app's store, encrypted with the operating system's key (Electron safeStorage:
 *     DPAPI on Windows, the Keychain on macOS, the secret service on Linux);
 *   - Android: encrypted with a key in the Android Keystore (TillHardware plugin);
 *   - iOS: the Keychain, this device only (TillHardware plugin);
 *   - a browser at /pos: a non-extractable key kept by the browser (page scripts can use it,
 *     never read it). A browser has no secure storage; the desktop and mobile apps do.
 * The key is loaded as non-extractable either way.
 */

import type { Platform } from '../platform';
import { TillDb } from './db';

export interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

const KEY_NAME = 'till.dbkey';

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const importKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** The till's data key: made once per install, kept in the platform's secure storage. */
export async function loadKey(platform: Platform, db: IDBDatabase): Promise<CryptoKey> {
  const secret = platform.secret;
  if (secret) {
    const saved = await secret.get(KEY_NAME);
    if (saved) return importKey(fromBase64(saved));
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await secret.set(KEY_NAME, toBase64(raw));
    // Read back: a key that was not kept would leave data no one can read.
    if ((await secret.get(KEY_NAME)) !== toBase64(raw)) throw new Error('This device did not keep the till’s key');
    raw.fill(0);
    return importKey(fromBase64((await secret.get(KEY_NAME))!));
  }
  const kept = await TillDb.keyFrom(db);
  if (kept) return kept;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await TillDb.saveKey(db, key);
  return key;
}

/** Forget the key (unpairing a till that has nothing left to send). */
export async function forgetKey(platform: Platform): Promise<void> {
  await platform.secret?.remove(KEY_NAME);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptJson(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encoder.encode(JSON.stringify(value)) as BufferSource);
  return { iv, data };
}

export async function decryptJson<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, key, sealed.data);
  return JSON.parse(decoder.decode(plain)) as T;
}

// ---------- PINs, for signing in without the server ----------

const PIN_ITERATIONS = 210_000;

/** A PIN's verifier: PBKDF2-SHA256 with a random salt (the PIN itself is never stored). */
export async function pinVerifier(pin: string, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PIN_ITERATIONS): Promise<{ salt: string; hash: string; iterations: number }> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(pin) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256);
  return { salt: toBase64(salt), hash: toBase64(new Uint8Array(bits)), iterations };
}

export async function pinMatches(pin: string, v: { salt: string; hash: string; iterations: number }): Promise<boolean> {
  const again = await pinVerifier(pin, fromBase64(v.salt), v.iterations);
  // Same length always (base64 of 32 bytes); compare every character.
  let diff = again.hash.length ^ v.hash.length;
  for (let i = 0; i < Math.min(again.hash.length, v.hash.length); i++) diff |= again.hash.charCodeAt(i) ^ v.hash.charCodeAt(i);
  return diff === 0;
}
