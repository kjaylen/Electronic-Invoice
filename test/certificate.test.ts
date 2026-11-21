import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertCertificateUsable,
  CertificateError,
  formatDistinguishedName,
  loadSigningCredentials,
  parseCertificate,
} from '../src/engine/certificate.ts';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');
const SIGNER_CERT = read('signer-123456.cert.pem');
const SIGNER_KEY = read('signer-123456.key.pem');
const OTHER_KEY = read('signer-654321.key.pem');

test('reads names, serial, digest and TIN from the certificate', () => {
  const info = parseCertificate(SIGNER_CERT);
  // .NET-style quoting, as in BTS's own signatures: CN="Belize Tax Service C=BZ TIN=000001"
  assert.equal(info.subjectName, 'CN="CaribFuel C=BZ TIN=123456"');
  assert.equal(info.issuerName, 'CN=Test Root Certification Authority');
  assert.equal(info.tin, '123456');
  const x509 = new X509Certificate(SIGNER_CERT);
  assert.equal(info.serialNumber, BigInt(`0x${x509.serialNumber}`).toString());
  assert.equal(info.sha256Base64, createHash('sha256').update(x509.raw).digest('base64'));
  assert.equal(info.validTo.getTime(), new Date(x509.validTo).getTime());
});

test('formats distinguished names like .NET: reversed, comma-space, quoted when needed', () => {
  assert.equal(
    formatDistinguishedName([
      [{ oid: '2.5.4.6', value: 'BZ' }],
      [{ oid: '2.5.4.10', value: 'Peña, Ltd' }],
      [{ oid: '2.5.4.3', value: 'Shop "One"' }],
    ]),
    'CN="Shop ""One""", O="Peña, Ltd", C=BZ',
  );
  assert.equal(formatDistinguishedName([[{ oid: '1.2.3.4', value: 'x' }]]), 'OID.1.2.3.4=x');
});

test('loads matching key and certificate', () => {
  const creds = loadSigningCredentials(SIGNER_KEY, SIGNER_CERT);
  assert.equal(creds.key.asymmetricKeyType, 'rsa');
  assert.equal(creds.certificate.tin, '123456');
});

test('rejects a key that does not match the certificate', () => {
  assert.throws(() => loadSigningCredentials(OTHER_KEY, SIGNER_CERT), /does not match/);
});

test('rejects non-RSA keys and unreadable keys without echoing them', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  assert.throws(() => loadSigningCredentials(ec, SIGNER_CERT), /must be RSA/);
  assert.throws(
    () => loadSigningCredentials('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----', SIGNER_CERT),
    (e: unknown) => e instanceof CertificateError && !e.message.includes('not a key'),
  );
});

test('rejects something that is not a certificate', () => {
  assert.throws(() => parseCertificate('hello'), /Not a valid X.509/);
});

test('refuses certificates BTS would reject (codes 231 and 243)', () => {
  const info = parseCertificate(SIGNER_CERT);
  const inside = new Date(info.validFrom.getTime() + 86_400_000);
  assert.doesNotThrow(() => assertCertificateUsable(info, { tin: '123456', at: inside }));
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as CertificateError).btsCode;
    }
    return undefined;
  };
  assert.equal(code(() => assertCertificateUsable(info, { tin: '654321', at: inside })), 243);
  assert.equal(code(() => assertCertificateUsable(info, { tin: '123456', at: new Date('2100-01-01') })), 231);
  assert.equal(code(() => assertCertificateUsable(info, { tin: '123456', at: new Date('2000-01-01') })), 231);
  assert.equal(code(() => assertCertificateUsable({ ...info, tin: null }, { tin: '123456', at: inside })), 243);
});
