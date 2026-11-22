/**
 * Encryption of secrets at rest: taxpayers' private keys and two-step
 * sign-in secrets.
 *
 * Secrets are encrypted with AES-256-GCM under a key-encryption key (KEK)
 * held outside the database. A context (the tenant id, or the owner of a
 * sign-in secret) is bound in as additional authenticated data, so a
 * ciphertext copied onto another row fails to decrypt.
 *
 * Keys are versioned: each blob names the key that made it ("v2:<key id>:…",
 * the id being the first 8 hex digits of the key's SHA-256), so the KEK can
 * be rotated: set the new key as KEY_ENCRYPTION_KEY, keep the old one in
 * KEY_ENCRYPTION_KEYS_PREVIOUS, run `npm run rotate-keys`, then drop the old
 * key. Blobs from before versioning ("v1:…") are still read.
 *
 * KeyProtector is async so a cloud KMS (AWS KMS, GCP KMS, Azure Key Vault)
 * can replace the local keyring without changing callers; see
 * docs/operations.md.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface KeyProtector {
  encrypt(plaintext: Buffer, context: string): Promise<string>;
  decrypt(blob: string, context: string): Promise<Buffer>;
}

/** A KeyProtector that can say whether a blob is under the current key (for rotation). */
export interface Keyring extends KeyProtector {
  readonly currentKeyId: string;
  readonly keyIds: readonly string[];
  isCurrent(blob: string): boolean;
}

export class KeystoreError extends Error {
  override name = 'KeystoreError';
}

export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

function seal(key: Buffer, plaintext: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function open(key: Buffer, data: string, context: string): Buffer | null {
  const raw = Buffer.from(data, 'base64');
  if (raw.length < 29) throw new KeystoreError('Key blob is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Encrypts with `current`; decrypts with it or any of `previous`. */
export function keyringProtector(current: Buffer, previous: Buffer[] = []): Keyring {
  for (const k of [current, ...previous]) if (k.length !== 32) throw new KeystoreError('The key-encryption key must be 32 bytes');
  const byId = new Map<string, Buffer>();
  for (const k of [current, ...previous]) byId.set(keyId(k), k);
  const currentKeyId = keyId(current);
  // Wrong key, wrong row, or tampered data. Never say which, never echo data.
  const fail = () => new KeystoreError('Could not decrypt (wrong key or altered data)');
  return {
    currentKeyId,
    keyIds: [...byId.keys()],
    isCurrent: (blob) => blob.startsWith(`v2:${currentKeyId}:`),
    async encrypt(plaintext, context) {
      return `v2:${currentKeyId}:${seal(current, plaintext, context)}`;
    },
    async decrypt(blob, context) {
      const parts = blob.split(':');
      if (parts[0] === 'v2' && parts.length === 3 && parts[1] && parts[2]) {
        const key = byId.get(parts[1]);
        if (!key) throw new KeystoreError(`Encrypted with key ${parts[1]}, which this server does not have`);
        return open(key, parts[2], context) ?? (() => { throw fail(); })();
      }
      if (parts[0] === 'v1' && parts.length === 2 && parts[1]) {
        // Before versioning: try each key.
        for (const key of byId.values()) {
          const out = open(key, parts[1], context);
          if (out) return out;
        }
        throw fail();
      }
      throw new KeystoreError('Unknown key blob format');
    },
  };
}

/** A keyring of one key. */
export const localKeyProtector = (kek: Buffer): Keyring => keyringProtector(kek);

function decodeKey(value: string, name: string): Buffer {
  const kek = Buffer.from(value.trim(), 'base64');
  if (kek.length !== 32) throw new KeystoreError(`${name} must be 32 bytes, Base64 encoded`);
  return kek;
}

/** Read the KEK from KEY_ENCRYPTION_KEY (32 bytes, Base64). Generate one with: openssl rand -base64 32 */
export function keyEncryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env.KEY_ENCRYPTION_KEY;
  if (!value) throw new KeystoreError('KEY_ENCRYPTION_KEY is not set');
  return decodeKey(value, 'KEY_ENCRYPTION_KEY');
}

/** KEY_ENCRYPTION_KEY, plus older keys still needed to read (KEY_ENCRYPTION_KEYS_PREVIOUS, comma separated). */
export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const previous = (env.KEY_ENCRYPTION_KEYS_PREVIOUS ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => decodeKey(v, 'KEY_ENCRYPTION_KEYS_PREVIOUS'));
  return keyringProtector(keyEncryptionKeyFromEnv(env), previous);
}
