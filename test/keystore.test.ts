import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keyEncryptionKeyFromEnv, keyId, keyringFromEnv, keyringProtector, KeystoreError, localKeyProtector } from '../src/db/keystore.ts';

const KEK = randomBytes(32);
const SECRET = Buffer.from('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n');

test('round trip', async () => {
  const keys = localKeyProtector(KEK);
  const blob = await keys.encrypt(SECRET, 'tenant-a');
  assert.match(blob, new RegExp(`^v2:${keyId(KEK)}:`), 'the blob names its key');
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
  const [, id, data] = blob.split(':');
  const raw = Buffer.from(data!, 'base64');
  raw[raw.length - 1]! ^= 1;
  await assert.rejects(localKeyProtector(KEK).decrypt(`v2:${id}:${raw.toString('base64')}`, 't'), KeystoreError);
  await assert.rejects(localKeyProtector(KEK).decrypt('v2:abc', 't'), /Unknown key blob/);
});

test('KEK must be 32 bytes; read from KEY_ENCRYPTION_KEY', () => {
  assert.throws(() => localKeyProtector(randomBytes(16)), /32 bytes/);
  assert.throws(() => keyEncryptionKeyFromEnv({}), /not set/);
  assert.throws(() => keyEncryptionKeyFromEnv({ KEY_ENCRYPTION_KEY: Buffer.alloc(8).toString('base64') }), /32 bytes/);
  assert.equal(keyEncryptionKeyFromEnv({ KEY_ENCRYPTION_KEY: KEK.toString('base64') }).length, 32);
});

test('rotation: the new key writes, old keys still read (versioned and pre-versioning blobs)', async () => {
  const OLD = randomBytes(32);
  const NEW = randomBytes(32);
  const before = await localKeyProtector(OLD).encrypt(SECRET, 't');
  const ring = keyringProtector(NEW, [OLD]);
  assert.deepEqual(await ring.decrypt(before, 't'), SECRET);
  assert.equal(ring.isCurrent(before), false);
  const after = await ring.encrypt(SECRET, 't');
  assert.equal(ring.isCurrent(after), true);
  await assert.rejects(localKeyProtector(OLD).decrypt(after, 't'), /does not have/);

  // A blob from before versioning ("v1:"), made with the old key.
  const { createCipheriv } = await import('node:crypto');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', OLD, iv);
  c.setAAD(Buffer.from('t'));
  const ct = Buffer.concat([c.update(SECRET), c.final()]);
  const legacy = `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
  assert.deepEqual(await ring.decrypt(legacy, 't'), SECRET);
  assert.equal(ring.isCurrent(legacy), false);

  const fromEnv = keyringFromEnv({ KEY_ENCRYPTION_KEY: NEW.toString('base64'), KEY_ENCRYPTION_KEYS_PREVIOUS: ` ${OLD.toString('base64')} ` });
  assert.deepEqual(fromEnv.keyIds, [keyId(NEW), keyId(OLD)]);
});
