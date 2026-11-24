/**
 * Certificate files as portals hand them out: the PKCS#12 file itself, or the
 * same file written as base64 text (one long line, wrapped lines, or between
 * PEM lines) under a .pfx name, which is what the BTS portal gives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pfxBytes, PfxError, pfxToPem } from '../src/db/pfx.ts';

const PASSWORD = 'test-pfx-password';
const file = readFileSync(new URL('./certs/signer-123456.pfx', import.meta.url));

test('a certificate file opens whether it is the file itself or the file written as base64 text', () => {
  const plain = pfxToPem(file, PASSWORD);
  assert.match(plain.certificatePem, /BEGIN CERTIFICATE/);
  assert.match(plain.privateKeyPem, /BEGIN PRIVATE KEY/);

  const b64 = file.toString('base64');
  const wrapped = b64.match(/.{1,64}/g)!.join('\r\n');
  const forms = {
    'one long line': b64,
    'a line break at the end': `${b64}\n`,
    'wrapped lines': wrapped,
    'between PEM lines': `-----BEGIN PKCS12-----\n${wrapped}\n-----END PKCS12-----\n`,
    'with a byte order mark': `﻿${b64}`,
  };
  for (const [name, text] of Object.entries(forms)) {
    assert.deepEqual(pfxBytes(Buffer.from(text, 'utf8')), file, name);
    assert.deepEqual(pfxToPem(Buffer.from(text, 'utf8'), PASSWORD), plain, name);
  }

  // The wrong password is still refused, in either form, and anything else is not mistaken for a certificate.
  assert.throws(() => pfxToPem(file, 'wrong'), PfxError);
  assert.throws(() => pfxToPem(Buffer.from(b64), 'wrong'), PfxError);
  assert.throws(() => pfxToPem(Buffer.from('not a certificate at all'), PASSWORD), PfxError);
  assert.throws(() => pfxToPem(Buffer.from('aGVsbG8gd29ybGQsIHRoaXMgaXMgdGV4dA=='), PASSWORD), PfxError);
  assert.throws(() => pfxToPem(Buffer.alloc(0), PASSWORD), PfxError);
});
