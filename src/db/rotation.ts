/**
 * Re-encrypt every stored secret under the keyring's current key: the
 * certificates' private keys and the two-step sign-in secrets. Rows already
 * under the current key are left alone, so it can be run again safely; each
 * row is updated only if it has not changed meanwhile.
 */

import type { Queryable } from './database.ts';
import type { Keyring } from './keystore.ts';

export interface RotationResult {
  certificates: number;
  twoFactorSecrets: number;
  alreadyCurrent: number;
}

export async function rotateSecrets(db: Queryable, keys: Keyring, options: { dryRun?: boolean } = {}): Promise<RotationResult> {
  const result: RotationResult = { certificates: 0, twoFactorSecrets: 0, alreadyCurrent: 0 };

  const certs = (await db.query<{ id: string; tenant_id: string; encrypted_key: string }>('select id, tenant_id, encrypted_key from certificates')).rows;
  for (const c of certs) {
    if (keys.isCurrent(c.encrypted_key)) {
      result.alreadyCurrent++;
      continue;
    }
    const plain = await keys.decrypt(c.encrypted_key, c.tenant_id);
    if (!options.dryRun) {
      const next = await keys.encrypt(plain, c.tenant_id);
      await db.query('update certificates set encrypted_key = $3 where id = $1 and encrypted_key = $2', [c.id, c.encrypted_key, next]);
    }
    plain.fill(0);
    result.certificates++;
  }

  const secrets = (await db.query<{ owner_kind: string; owner_id: string; secret_encrypted: string }>('select owner_kind, owner_id, secret_encrypted from two_factor')).rows;
  for (const s of secrets) {
    if (keys.isCurrent(s.secret_encrypted)) {
      result.alreadyCurrent++;
      continue;
    }
    const context = `totp:${s.owner_kind}:${s.owner_id}`;
    const plain = await keys.decrypt(s.secret_encrypted, context);
    if (!options.dryRun) {
      const next = await keys.encrypt(plain, context);
      await db.query('update two_factor set secret_encrypted = $4 where owner_kind = $1 and owner_id = $2 and secret_encrypted = $3', [s.owner_kind, s.owner_id, s.secret_encrypted, next]);
    }
    plain.fill(0);
    result.twoFactorSecrets++;
  }
  return result;
}
