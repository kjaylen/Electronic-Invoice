/**
 * Encryption of taxpayers' private keys at rest.
 *
 * Keys are encrypted with AES-256-GCM under a key-encryption key (KEK) held
 * outside the database. The tenant id is bound in as additional authenticated
 * data, so a ciphertext copied onto another tenant's row fails to decrypt.
 *
 * KeyProtector is async so a cloud KMS (AWS KMS, GCP KMS, Azure Key Vault)
 * can replace the local KEK without changing callers.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyProtector {
  encrypt(plaintext: Buffer, context: string): Promise<string>;
  decrypt(blob: string, context: string): Promise<Buffer>;
}

export class KeystoreError extends Error {
  override name = 'KeystoreError';
}

const VERSION = 'v1';

/** A KeyProtector using a 32-byte key held by this process. */
export function localKeyProtector(kek: Buffer): KeyProtector {
  if (kek.length !== 32) throw new KeystoreError('The key-encryption key must be 32 bytes');
  return {
    async encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
    },
    async decrypt(blob, context) {
      const [version, data] = blob.split(':');
      if (version !== VERSION || !data) throw new KeystoreError('Unknown key blob format');
      const raw = Buffer.from(data, 'base64');
      if (raw.length < 29) throw new KeystoreError('Key blob is too short');
      const decipher = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(raw.subarray(12, 28));
      try {
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      } catch {
        // Wrong KEK, wrong tenant, or tampered data. Never say which, never echo data.
        throw new KeystoreError('Could not decrypt the private key');
      }
    },
  };
}

/** Read the KEK from KEY_ENCRYPTION_KEY (32 bytes, Base64). Generate one with: openssl rand -base64 32 */
export function keyEncryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env.KEY_ENCRYPTION_KEY;
  if (!value) throw new KeystoreError('KEY_ENCRYPTION_KEY is not set');
  const kek = Buffer.from(value, 'base64');
  if (kek.length !== 32) throw new KeystoreError('KEY_ENCRYPTION_KEY must be 32 bytes, Base64 encoded');
  return kek;
}
