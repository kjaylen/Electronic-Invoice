/**
 * Rotate the key-encryption key.
 *
 *   1. Generate a new key:            openssl rand -base64 32
 *   2. On every server, set           KEY_ENCRYPTION_KEY=<new key>
 *                                     KEY_ENCRYPTION_KEYS_PREVIOUS=<old key>
 *      and restart (they can now read both, and write with the new one).
 *   3. Re-encrypt what is stored:     npm run rotate-keys            (add -- --dry-run to only count)
 *   4. Remove KEY_ENCRYPTION_KEYS_PREVIOUS everywhere and restart.
 *
 * Uses DATABASE_URL. Safe to run more than once.
 */

import pg from 'pg';
import { migrate, pgDatabase } from '../src/db/database.ts';
import { keyringFromEnv } from '../src/db/keystore.ts';
import { rotateSecrets } from '../src/db/rotation.ts';

const dryRun = process.argv.includes('--dry-run');
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL (and KEY_ENCRYPTION_KEY, KEY_ENCRYPTION_KEYS_PREVIOUS).');
  process.exit(1);
}
const keys = keyringFromEnv();
const db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
try {
  await migrate(db);
  const r = await rotateSecrets(db, keys, { dryRun });
  const verb = dryRun ? 'Would re-encrypt' : 'Re-encrypted';
  console.log(`${verb} ${r.certificates} certificate key(s) and ${r.twoFactorSecrets} two-step sign-in secret(s) under key ${keys.currentKeyId}; ${r.alreadyCurrent} already used it.`);
  if (!dryRun) console.log('Once every server runs with the new key, remove KEY_ENCRYPTION_KEYS_PREVIOUS and restart.');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
