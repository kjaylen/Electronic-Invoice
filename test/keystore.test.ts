import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keyEncryptionKeyFromEnv, KeystoreError, localKeyProtector } from '../src/db/keystore.ts';

const KEK = randomBytes(32);
const SECRET = Buffer.from('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n');

test('round trip', async () => {
  const keys = localKeyProtector(KEK);
  const blob = await keys.encrypt(SECRET, 'tenant-a');
  assert.match(blob, /^v1:/);
  assert.ok(!blob.includes('secret'));
  assert.deepEqual(await keys.decrypt(blob, 'tenant-a'), SECRET);
});

test('each encryption uses a fresh IV', async () => {
  const keys = localKeyProtector(KEK);
  assert.notEqual(await keys.encrypt(SECRET, 't'), await keys.encrypt(SECRET, 't'));
});

test("a blob copied to another tenant's row does not decrypt", async () => {
  const keys = localKeyProtector(KEK);
  const blob = await keys.encrypt(SECRET, 'tenant-a');
  await assert.rejects(keys.decrypt(blob, 'tenant-b'), KeystoreError);
});

test('wrong KEK or tampered data fails without revealing anything', async () => {
  const blob = await localKeyProtector(KEK).encrypt(SECRET, 't');
  await assert.rejects(localKeyProtector(randomBytes(32)).decrypt(blob, 't'), (e: unknown) => e instanceof KeystoreError && !/secret/.test((e as Error).message));
  const raw = Buffer.from(blob.slice(3), 'base64');
  raw[raw.length - 1]! ^= 1;
  await assert.rejects(localKeyProtector(KEK).decrypt(`v1:${raw.toString('base64')}`, 't'), KeystoreError);
  await assert.rejects(localKeyProtector(KEK).decrypt('v2:abc', 't'), /Unknown key blob/);
});

test('KEK must be 32 bytes; read from KEY_ENCRYPTION_KEY', () => {
  assert.throws(() => localKeyProtector(randomBytes(16)), /32 bytes/);
  assert.throws(() => keyEncryptionKeyFromEnv({}), /not set/);
  assert.throws(() => keyEncryptionKeyFromEnv({ KEY_ENCRYPTION_KEY: Buffer.alloc(8).toString('base64') }), /32 bytes/);
  assert.equal(keyEncryptionKeyFromEnv({ KEY_ENCRYPTION_KEY: KEK.toString('base64') }).length, 32);
});
