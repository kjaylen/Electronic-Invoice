import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { loadSigningCredentials } from '../src/engine/certificate.ts';
import { buildEtdui, type OperMode } from '../src/engine/etdui.ts';
import { APPLICATION_RESPONSE_NS, buildCancellationEvent, EventError, type CancellationInput } from '../src/engine/event.ts';
import { signDocument } from '../src/engine/sign.ts';
import { NS } from '../src/engine/ubl.ts';
import { verifyDocumentSignature } from '../src/engine/verify.ts';
import { etduiFor, SUPPLIER } from './fixtures.ts';
import { validateUbl } from './schema.ts';

function eventEtdui(serial = 1, overrides: { series?: number; operMode?: OperMode; tin?: string } = {}) {
  return buildEtdui({
    etdType: '05',
    tin: overrides.tin ?? SUPPLIER.tin,
    serial,
    series: overrides.series ?? 50,
    issueDate: '2026-11-22',
    issueTime: '09:15',
    operMode: overrides.operMode ?? 1,
    receptionEnv: '02',
    securityCode: '123456789',
  });
}

const INPUT: CancellationInput = {
  eventEtdui: eventEtdui(),
  issueDate: '2026-11-22',
  issueTime: '09:15:20',
  issuer: SUPPLIER,
  cancelledEtdui: etduiFor('01', 42),
  reason: 'Superseded by contingency document',
};

const child = (parent: Element, ns: string, name: string) =>
  Array.from(parent.childNodes).find((n) => (n as Element).namespaceURI === ns && (n as Element).localName === name) as Element | undefined;

test('cancellation event validates against the official UBL 2.1 ApplicationResponse schema', async () => {
  const { xml, rootElement } = buildCancellationEvent(INPUT);
  assert.equal(rootElement, 'ApplicationResponse');
  const { valid, errors } = await validateUbl(xml, 'ApplicationResponse');
  assert.ok(valid, errors.join('\n'));
});

test('cancellation event content follows manual 4.10 and the BTS event rules', () => {
  const doc = new DOMParser().parseFromString(buildCancellationEvent(INPUT).xml, 'text/xml');
  const root = doc.documentElement!;
  assert.equal(root.namespaceURI, APPLICATION_RESPONSE_NS);
  assert.equal(child(root, NS.cbc, 'ID')?.textContent, '000000001');
  assert.equal(child(root, NS.cbc, 'UUID')?.textContent, INPUT.eventEtdui);
  assert.equal(child(root, NS.cbc, 'IssueTime')?.textContent, '09:15:20-06:00');

  // Extension: ETDUI elements with series = event code, and no sequenceInfo (code 287).
  assert.equal(doc.getElementsByTagNameNS(NS.efdr, 'series')[0]!.textContent, '050');
  assert.equal(doc.getElementsByTagNameNS(NS.efdr, 'ETDType')[0]!.textContent, '05');
  assert.equal(doc.getElementsByTagNameNS(NS.efdr, 'sequenceInfo').length, 0);

  // Response code equals the series (285); exact description (286); reason in Status.
  const response = doc.getElementsByTagNameNS(NS.cac, 'Response')[0]!;
  assert.equal(child(response, NS.cbc, 'ResponseCode')?.textContent, '050');
  assert.equal(child(response, NS.cbc, 'Description')?.textContent, 'ETD Cancellation');
  const status = child(response, NS.cac, 'Status')!;
  assert.equal(child(status, NS.cbc, 'ConditionCode')?.textContent, '050');
  assert.equal(child(status, NS.cbc, 'StatusReason')?.textContent, INPUT.reason);

  // Exactly one DocumentReference (227), pointing at the cancelled document.
  const refs = doc.getElementsByTagNameNS(NS.cac, 'DocumentReference');
  assert.equal(refs.length, 1);
  assert.equal(child(refs[0]!, NS.cbc, 'UUID')?.textContent, INPUT.cancelledEtdui);
  assert.equal(child(refs[0]!, NS.cbc, 'DocumentType')?.textContent, 'Tax Invoice');

  // Author and referenced-document author are the issuer (268).
  for (const tag of ['SenderParty', 'ReceiverParty']) {
    const p = doc.getElementsByTagNameNS(NS.cac, tag)[0]!;
    assert.equal(p.getElementsByTagNameNS(NS.cbc, 'CompanyID')[0]!.textContent, SUPPLIER.tin);
  }
});

test('a cancellation event signs and verifies like any other ETD', () => {
  const certs = new URL('./certs/', import.meta.url);
  const creds = loadSigningCredentials(readFileSync(new URL('signer-123456.key.pem', certs), 'utf8'), readFileSync(new URL('signer-123456.cert.pem', certs), 'utf8'));
  const signed = signDocument(buildCancellationEvent(INPUT).xml, creds, { signingTime: new Date(creds.certificate.validFrom.getTime() + 86_400_000) });
  assert.deepEqual(verifyDocumentSignature(signed.xml).errors, []);
});

test('rejects events BTS would refuse', () => {
  const cases: Array<[Partial<CancellationInput>, RegExp]> = [
    [{ eventEtdui: eventEtdui(1, { series: 51 }) }, /series 050.*257/],
    [{ eventEtdui: etduiFor('01', 7) }, /document type 05/],
    [{ cancelledEtdui: eventEtdui(9) }, /event 051/],
    [{ cancelledEtdui: buildEtdui({ etdType: '01', tin: '654321', serial: 1, series: 1, issueDate: '2026-11-22', issueTime: '09:00', operMode: 1, receptionEnv: '02', securityCode: '111111111' }) }, /code 268/],
    [{ issueTime: '09:16:00' }, /do not match/],
    [{ reason: '  ' }, /needs a reason/],
  ];
  for (const [override, message] of cases) {
    assert.throws(() => buildCancellationEvent({ ...INPUT, ...override }), (e: unknown) => (e instanceof EventError || (e as Error).name === 'EtduiError') && message.test((e as Error).message), JSON.stringify(override));
  }
  // operMode 2 for an event is already refused when building the ETDUI (code 258).
  assert.throws(() => eventEtdui(1, { operMode: 2 }), /previous authorization/);
});
