import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, sign as rsaSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';
import { CertificateError, loadSigningCredentials } from '../src/engine/certificate.ts';
import { BTS_SIGNATURE_POLICY, DSIG_NS, signDocument, SignError, XADES_NS } from '../src/engine/sign.ts';
import { buildUblDocument, NS, type IssuedEtdType } from '../src/engine/ubl.ts';
import { verifyDocumentSignature } from '../src/engine/verify.ts';
import { makeDocument } from './fixtures.ts';
import { validateUbl } from './schema.ts';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');
const CREDS = loadSigningCredentials(read('signer-123456.key.pem'), read('signer-123456.cert.pem'));
const OTHER = loadSigningCredentials(read('signer-654321.key.pem'), read('signer-654321.cert.pem'));
const WHEN = new Date(CREDS.certificate.validFrom.getTime() + 30 * 86_400_000);

function sign(type: IssuedEtdType = '01', options = {}) {
  return signDocument(buildUblDocument(makeDocument(type)).xml, CREDS, { signingTime: WHEN, ...options });
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');
const one = (node: Element | ReturnType<typeof parse>, ns: string, name: string) => node.getElementsByTagNameNS(ns, name)[0] as Element;

for (const type of ['01', '02', '03', '04'] as const) {
  test(`document type ${type}: signature verifies and the document still validates against UBL 2.1`, async () => {
    const signed = sign(type);
    const result = verifyDocumentSignature(signed.xml);
    assert.deepEqual(result.errors, []);
    assert.ok(result.valid);
    const root = type === '04' ? 'CreditNote' : 'Invoice';
    const schema = await validateUbl(signed.xml, root);
    assert.ok(schema.valid, schema.errors.join('\n'));
  });
}

test('document digest matches libxml2 canonicalization (an independent C14N implementation)', async () => {
  const { xml } = sign();
  // Enveloped-signature transform: drop the Signature element, keep its empty ExtensionContent.
  const enveloped = xml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '');
  const c14n = (await validateXML({ xml: { fileName: 'doc.xml', contents: enveloped }, normalization: 'c14n' })).normalized;
  const digest = createHash('sha256').update(c14n.replace(/\n$/, ''), 'utf8').digest('base64'); // xmllint adds a newline
  const reference = Array.from(parse(xml).getElementsByTagNameNS(DSIG_NS, 'Reference')).find((r) => r.getAttribute('URI') === '')!;
  assert.equal(one(reference, DSIG_NS, 'DigestValue').textContent, digest);
});

test('signature verifies with .NET SignedXml (an independent XMLDSig implementation)', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'etd-sign-'));
  try {
    const file = join(dir, 'signed.xml');
    writeFileSync(file, sign('01').xml, 'utf8');
    const script = fileURLToPath(new URL('../scripts/verify-signature.ps1', import.meta.url));
    const run = (path: string) =>
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path], { encoding: 'utf8' });
    const ok = run(file);
    assert.equal(ok.stdout.trim(), 'VALID', ok.stderr);
    assert.equal(ok.status, 0);
    // And .NET must reject a tampered copy, so VALID above means something.
    const tampered = join(dir, 'tampered.xml');
    writeFileSync(tampered, readFileSync(file, 'utf8').replace('Island Logistics Ltd.', 'Island Logistics Inc.'), 'utf8');
    const bad = run(tampered);
    assert.equal(bad.stdout.trim(), 'INVALID', bad.stderr);
    assert.equal(bad.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('layout follows BTS: second UBLExtension, Ids, KeyInfo, policy, two references', () => {
  const signed = sign('01', { idBase: 'xmldsig-test' });
  const doc = parse(signed.xml);
  const exts = Array.from(doc.getElementsByTagNameNS(NS.ext, 'UBLExtension'));
  assert.equal(exts.length, 2);
  assert.ok(one(exts[0]!, NS.efdr, 'EFDRExtensions'));
  const sig = one(exts[1]!, DSIG_NS, 'Signature');
  assert.equal((sig.parentNode as Element).localName, 'ExtensionContent');
  assert.equal(sig.getAttribute('Id'), 'xmldsig-test-sigvalue');
  assert.equal(signed.signatureId, 'xmldsig-test-sigvalue');

  const algorithms = (name: string) => Array.from(sig.getElementsByTagNameNS(DSIG_NS, name)).map((e) => e.getAttribute('Algorithm'));
  assert.deepEqual(algorithms('CanonicalizationMethod'), ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315']);
  assert.deepEqual(algorithms('SignatureMethod'), ['http://www.w3.org/2001/04/xmldsig-more#rsa-sha256']);
  assert.deepEqual(algorithms('Transform'), ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315']);

  const refs = Array.from(sig.getElementsByTagNameNS(DSIG_NS, 'Reference')).map((r) => [r.getAttribute('Id'), r.getAttribute('URI'), r.getAttribute('Type')]);
  assert.deepEqual(refs, [
    ['xmldsig-test', '', null],
    [null, '#xmldsig-test-signedprops', 'http://uri.etsi.org/01903#SignedProperties'],
  ]);

  const keyInfo = one(sig, DSIG_NS, 'KeyInfo');
  assert.equal(keyInfo.getAttribute('Id'), 'xmldsig-test-keyinfo');
  assert.equal(one(keyInfo, DSIG_NS, 'X509SubjectName').textContent, 'CN="CaribFuel C=BZ TIN=123456"');
  assert.equal(one(keyInfo, DSIG_NS, 'X509IssuerName').textContent, 'CN=Test Root Certification Authority');
  assert.equal(one(keyInfo, DSIG_NS, 'X509Certificate').textContent, CREDS.certificate.derBase64);

  const qp = one(sig, XADES_NS, 'QualifyingProperties');
  assert.equal(qp.getAttribute('Target'), '#xmldsig-test-sigvalue');
  assert.equal(one(qp, XADES_NS, 'SigningTime').textContent, WHEN.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal(one(qp, XADES_NS, 'Identifier').textContent, BTS_SIGNATURE_POLICY.identifier);
  const policyHash = one(qp, XADES_NS, 'SigPolicyHash');
  assert.equal(one(policyHash, DSIG_NS, 'DigestValue').textContent, BTS_SIGNATURE_POLICY.digestValue);
  const certDigest = one(qp, XADES_NS, 'CertDigest');
  assert.equal(one(certDigest, DSIG_NS, 'DigestValue').textContent, CREDS.certificate.sha256Base64);
});

test('signed output keeps BTS formatting rules: no whitespace between tags, under 500 KB', () => {
  const signed = sign('01');
  assert.doesNotMatch(signed.xml, />\s+</);
  assert.ok(signed.byteLength < 500_000);
  assert.equal(signed.byteLength, Buffer.byteLength(signed.xml, 'utf8'));
});

test('every signature gets fresh Ids', () => {
  assert.notEqual(sign().signatureId, sign().signatureId);
});

test('any change after signing breaks verification', () => {
  const { xml } = sign();
  const cases: Array<[string, string]> = [
    ['amount', xml.replace('<cbc:PayableAmount currencyID="BZD">', '<cbc:PayableAmount currencyID="BZD">1')],
    ['customer name', xml.replace('Island Logistics Ltd.', 'Island Logistics Inc.')],
    ['signing time', xml.replace(/<xades:SigningTime>\d{4}/, '<xades:SigningTime>1999')],
    ['policy', xml.replace(BTS_SIGNATURE_POLICY.digestValue, BTS_SIGNATURE_POLICY.digestValue.replace('k', 'K'))],
    ['security code', xml.replace('<efdr:securityCode>473298514', '<efdr:securityCode>473298515')],
  ];
  for (const [label, tampered] of cases) {
    assert.notEqual(tampered, xml, `${label}: replacement must change the document`);
    assert.equal(verifyDocumentSignature(tampered).valid, false, label);
  }
});

test('a signature value made with another key does not verify against the embedded certificate', () => {
  const { xml } = sign();
  const foreign = rsaSign('sha256', Buffer.from('anything'), OTHER.key).toString('base64');
  const swapped = xml.replace(/<ds:SignatureValue>[^<]+/, `<ds:SignatureValue>${foreign}`);
  assert.equal(verifyDocumentSignature(swapped).valid, false);
});

test('refuses to sign with a certificate BTS would reject', () => {
  const { xml } = buildUblDocument(makeDocument('01'));
  assert.throws(() => signDocument(xml, OTHER, { signingTime: WHEN }), (e: unknown) => e instanceof CertificateError && e.btsCode === 243);
  assert.throws(() => signDocument(xml, CREDS, { signingTime: new Date('2100-01-01') }), (e: unknown) => e instanceof CertificateError && e.btsCode === 231);
});

test('refuses to sign twice or sign malformed input', () => {
  const signed = sign();
  assert.throws(() => signDocument(signed.xml, CREDS, { signingTime: WHEN }), (e: unknown) => e instanceof SignError && /code 226/.test(e.message));
  assert.throws(() => signDocument('<Invoice', CREDS), SignError);
  assert.throws(() => signDocument(buildUblDocument(makeDocument('01')).xml, CREDS, { idBase: 'bad id' }), /valid XML Id/);
});

test('verifier reports missing or misplaced signatures', () => {
  const unsigned = buildUblDocument(makeDocument('01')).xml;
  assert.match(verifyDocumentSignature(unsigned).errors[0]!, /code 225/);
  const signed = sign().xml;
  const sigXml = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)![0];
  assert.match(verifyDocumentSignature(signed.replace('</cac:LegalMonetaryTotal>', `</cac:LegalMonetaryTotal>${sigXml}`)).errors.join(), /code 226/);
});
