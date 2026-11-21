import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { calculateDocument } from '../src/engine/calc.ts';
import { parseCents } from '../src/engine/decimal.ts';
import { sequenceHash } from '../src/engine/sequence.ts';
import { buildUblDocument, NS, UblError, type IssuedEtdType } from '../src/engine/ubl.ts';
import { etduiFor, LINES, makeDocument } from './fixtures.ts';
import { validateUbl } from './schema.ts';

function parse(xml: string): Document {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, msg) => errors.push(`${level}: ${msg}`) }).parseFromString(xml, 'text/xml');
  assert.deepEqual(errors, [], 'XML must be well formed');
  return doc;
}

function all(node: Document | Element, ns: string, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(ns, name));
}

/** Text of a direct child element, e.g. child(root, NS.cbc, 'UUID'). */
function child(parent: Element, ns: string, name: string): string | undefined {
  for (const n of Array.from(parent.childNodes)) {
    const e = n as Element;
    if (e.namespaceURI === ns && e.localName === name) return e.textContent ?? '';
  }
  return undefined;
}

const TYPES: Array<[IssuedEtdType, 'Invoice' | 'CreditNote', string]> = [
  ['01', 'Invoice', 'Tax Invoice'],
  ['02', 'Invoice', 'Tax Receipt'],
  ['03', 'Invoice', 'Debit Note'],
  ['04', 'CreditNote', 'Credit Note'],
];

for (const [type, root, label] of TYPES) {
  test(`${label} validates against the official UBL 2.1 schema`, async () => {
    const result = buildUblDocument(makeDocument(type));
    assert.equal(result.rootElement, root);
    const { valid, errors } = await validateUbl(result.xml, root);
    assert.ok(valid, errors.join('\n'));
  });
}

test('the schema check really catches errors (wrong element order, missing required element)', async () => {
  const { xml } = buildUblDocument(makeDocument('01'));
  // Move IssueDate after InvoiceTypeCode.
  const reordered = xml
    .replace('<cbc:IssueDate>2026-11-21</cbc:IssueDate>', '')
    .replace('<cbc:DocumentCurrencyCode>', '<cbc:IssueDate>2026-11-21</cbc:IssueDate><cbc:DocumentCurrencyCode>');
  assert.equal((await validateUbl(reordered, 'Invoice')).valid, false);
  // Remove the required currencyID attribute from one amount.
  assert.equal((await validateUbl(xml.replace(/ currencyID="BZD"/, ''), 'Invoice')).valid, false);
});

test('contingency documents and anonymous receipts validate too', async () => {
  const contingency = { reason: 'Internet outage', startDate: '2026-11-21', startTime: '13:50:00' };
  const docs = [
    buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency })),
    buildUblDocument(makeDocument('02', { etdui: etduiFor('02', 7, 3, 900), contingency })),
    buildUblDocument(makeDocument('04', { etdui: etduiFor('04', 7, 2, 900), contingency })),
    buildUblDocument(makeDocument('02', { customer: undefined, payment: { meansCode: '10', terms: 'Paid in cash' } })),
    buildUblDocument(makeDocument('02', { customer: { otherId: { scheme: 'SSN', value: '000123456' } } })),
  ];
  for (const d of docs) {
    const { valid, errors } = await validateUbl(d.xml, d.rootElement);
    assert.ok(valid, errors.join('\n'));
  }
});

test('header, extension and totals carry the right values', () => {
  const input = makeDocument('01');
  const doc = parse(buildUblDocument(input).xml);
  const root = doc.documentElement!;
  assert.equal(root.localName, 'Invoice');
  assert.equal(root.namespaceURI, NS.invoice);

  assert.equal(child(root, NS.cbc, 'UBLVersionID'), '2.1');
  assert.equal(child(root, NS.cbc, 'CustomizationID'), 'urn:ciat:efdr:customization:1.0');
  assert.equal(child(root, NS.cbc, 'ProfileID'), 'urn:ciat:efdr:profile:standard');
  assert.equal(child(root, NS.cbc, 'ID'), '000000042');
  assert.equal(child(root, NS.cbc, 'UUID'), input.etdui);
  assert.equal(child(root, NS.cbc, 'IssueDate'), '2026-11-21');
  assert.equal(child(root, NS.cbc, 'IssueTime'), '14:05:33-06:00');
  assert.equal(child(root, NS.cbc, 'InvoiceTypeCode'), '388');
  assert.equal(child(root, NS.cbc, 'DocumentCurrencyCode'), 'BZD');
  assert.equal(child(root, NS.cbc, 'LineCountNumeric'), '3');

  const efdr = (name: string) => all(doc, NS.efdr, name)[0]?.textContent;
  assert.equal(efdr('ETDType'), '01');
  assert.equal(efdr('series'), '001');
  assert.equal(efdr('operMode'), '1');
  assert.equal(efdr('receptionEnv'), '02');
  assert.equal(efdr('securityCode'), '473298514');
  assert.equal(efdr('checkDigit'), input.etdui[43]);
  assert.equal(efdr('sequenceInfoThisETD'), input.sequence.thisEtd);
  assert.equal(all(doc, NS.efdr, 'contingencyInfo').length, 0);

  const supplierTin = all(all(doc, NS.cac, 'AccountingSupplierParty')[0]!, NS.cbc, 'CompanyID')[0]!.textContent;
  assert.equal(supplierTin, '123456');

  const legal = all(doc, NS.cac, 'LegalMonetaryTotal')[0]!;
  // Diesel 17,536.20 + oil 180.00 - 10% 18.00 + rice 65.00
  assert.equal(child(legal, NS.cbc, 'LineExtensionAmount'), '17763.20');
  assert.equal(child(legal, NS.cbc, 'PayableAmount'), formatTotal(input.totals.payableAmount));
  assert.equal(child(legal, NS.cbc, 'PrepaidAmount'), undefined);

  // The document-level TaxTotal is the root's direct child, not a line's.
  const docTax = Array.from(root.childNodes).find((n) => (n as Element).localName === 'TaxTotal') as Element;
  assert.equal(child(docTax, NS.cbc, 'TaxAmount'), formatTotal(input.totals.taxAmount));
});

function formatTotal(c: bigint): string {
  return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
}

test('sequence hash recomputed from the XML matches the extension', () => {
  const input = makeDocument('01');
  const doc = parse(buildUblDocument(input).xml);
  const root = doc.documentElement!;
  const docTax = Array.from(root.childNodes).find((n) => (n as Element).localName === 'TaxTotal') as Element;
  const legal = all(doc, NS.cac, 'LegalMonetaryTotal')[0]!;
  const recomputed = sequenceHash({
    uuid: child(root, NS.cbc, 'UUID')!,
    lineCount: Number(child(root, NS.cbc, 'LineCountNumeric')),
    taxAmount: parseCents(child(docTax, NS.cbc, 'TaxAmount')!),
    lineExtensionAmount: parseCents(child(legal, NS.cbc, 'LineExtensionAmount')!),
  });
  assert.equal(all(doc, NS.efdr, 'sequenceInfoThisETD')[0]!.textContent, recomputed);
});

test('every amount carries currencyID BZD', () => {
  const doc = parse(buildUblDocument(makeDocument('01')).xml);
  const amountNames = ['TaxAmount', 'TaxableAmount', 'LineExtensionAmount', 'PayableAmount', 'PriceAmount', 'Amount', 'BaseAmount', 'PerUnitAmount'];
  for (const name of amountNames) {
    for (const e of all(doc, NS.cbc, name)) assert.equal(e.getAttribute('currencyID'), 'BZD', name);
  }
});

test('lines: quantities, unit codes, other taxes and allowances', () => {
  const doc = parse(buildUblDocument(makeDocument('01')).xml);
  const lines = all(doc, NS.cac, 'InvoiceLine');
  assert.equal(lines.length, 3);
  const qty = all(lines[0]!, NS.cbc, 'InvoicedQuantity')[0]!;
  assert.equal(qty.textContent, '3000');
  assert.equal(qty.getAttribute('unitCode'), 'GLL');
  const schemes = all(lines[0]!, NS.cac, 'TaxScheme').map((s) => child(s, NS.cbc, 'ID'));
  assert.deepEqual(schemes, ['ENV', 'EXC', 'GST']);
  const perUnit = all(lines[0]!, NS.cbc, 'PerUnitAmount').map((e) => e.textContent);
  assert.deepEqual(perUnit, ['0.17', '2.9727']);
  const discount = all(lines[1]!, NS.cac, 'AllowanceCharge')[0]!;
  assert.equal(child(discount, NS.cbc, 'ChargeIndicator'), 'false');
  assert.equal(child(discount, NS.cbc, 'MultiplierFactorNumeric'), '10');
  assert.equal(child(discount, NS.cbc, 'Amount'), '18.00');
});

test('credit note uses CreditNote, CreditNoteLine and references the original', () => {
  const input = makeDocument('04');
  const doc = parse(buildUblDocument(input).xml);
  assert.equal(doc.documentElement!.namespaceURI, NS.creditNote);
  assert.equal(child(doc.documentElement!, NS.cbc, 'CreditNoteTypeCode'), '381');
  assert.equal(all(doc, NS.cac, 'CreditNoteLine').length, 3);
  assert.equal(all(doc, NS.cbc, 'CreditedQuantity').length, 3);
  const ref = all(doc, NS.cac, 'AdditionalDocumentReference')[0]!;
  assert.equal(child(ref, NS.cbc, 'UUID'), input.reference!.etdui);
  assert.equal(child(ref, NS.cbc, 'ID'), '000000041');
  assert.equal(child(ref, NS.cbc, 'DocumentDescription'), 'Price correction');
});

test('anonymous Tax Receipt has an empty customer; a receipt with an ID carries only the ID', () => {
  const anon = parse(buildUblDocument(makeDocument('02', { customer: undefined })).xml);
  assert.equal(all(anon, NS.cac, 'AccountingCustomerParty')[0]!.childNodes.length, 0);

  const named = parse(
    buildUblDocument(makeDocument('02', { customer: { name: 'Walk-in', tin: '111222', contact: { email: 'x@y.example' } } })).xml,
  );
  const party = all(named, NS.cac, 'AccountingCustomerParty')[0]!;
  assert.equal(all(party, NS.cbc, 'CompanyID')[0]!.textContent, '111222');
  assert.equal(all(party, NS.cac, 'PartyName').length, 0);
  assert.equal(all(party, NS.cac, 'Contact').length, 0);
});

test('contingency info is written in contingency mode', () => {
  const contingency = { reason: 'BTS reception down (status 009)', startDate: '2026-11-21', startTime: '13:50:00' };
  const doc = parse(buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency })).xml);
  assert.equal(all(doc, NS.efdr, 'operMode')[0]!.textContent, '2');
  assert.equal(all(doc, NS.efdr, 'contingencyReason')[0]!.textContent, contingency.reason);
});

test('user text is escaped and the output is still valid', async () => {
  const input = makeDocument('01', {
    customer: { name: 'Peña & Sons <Belize> "Ltd"', address: makeDocument('01').customer!.address },
    note: 'Deliver to back gate & call ahead',
  });
  const result = buildUblDocument(input);
  assert.match(result.xml, /Peña &amp; Sons &lt;Belize&gt; "Ltd"/);
  const doc = parse(result.xml);
  const customer = all(doc, NS.cac, 'AccountingCustomerParty')[0]!;
  assert.equal(all(customer, NS.cbc, 'RegistrationName')[0]!.textContent, 'Peña & Sons <Belize> "Ltd"');
  assert.ok((await validateUbl(result.xml, 'Invoice')).valid);
});

test('output is deterministic', () => {
  const input = makeDocument('01');
  assert.equal(buildUblDocument(input).xml, buildUblDocument(input).xml);
});

test('rejects inconsistent or incomplete documents', () => {
  const contingency = { reason: 'Outage', startDate: '2026-11-21', startTime: '13:50:00' };
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['TIN mismatch', () => makeDocument('01', { supplier: { ...makeDocument('01').supplier, tin: '999999' } }), /TIN does not match/],
    ['invoice without customer', () => makeDocument('01', { customer: undefined }), /code 283/],
    ['wrong type for ETDUI', () => makeDocument('01', { etdui: etduiFor('02', 1) }), /document type 02, not 01/],
    ['time mismatch', () => makeDocument('01', { issueTime: '14:06:00' }), /do not match the ETDUI/],
    ['note without reference', () => makeDocument('04', { reference: undefined }), /must reference/],
    ['invoice with reference', () => makeDocument('01', { reference: { etdui: etduiFor('01', 1), reason: 'x' } }), /Only Debit and Credit/],
    ['contingency mode without info', () => makeDocument('01', { etdui: etduiFor('01', 7, 2) }), /code 244/],
    ['normal mode with info', () => makeDocument('01', { contingency }), /code 246/],
    ['amount due without terms', () => makeDocument('01', { payment: undefined }), /due date or payment terms/],
    ['due date without means', () => makeDocument('01', { payment: { dueDate: '2026-12-01' } }), /payment means code/],
    ['bad district', () => makeDocument('01', { supplier: { ...makeDocument('01').supplier, address: { ...makeDocument('01').supplier.address, districtCode: '7' as never } } }), /district code/],
    ['event type', () => ({ ...makeDocument('01'), etdType: '05' as never }), /events use ApplicationResponse/],
  ];
  for (const [label, make, message] of cases) {
    assert.throws(() => buildUblDocument(make() as never), (e: unknown) => e instanceof UblError && message.test(e.message), label);
  }
});

test('rejects documents that would exceed the 500 KB BTS limit (code 210)', () => {
  const many = calculateDocument({ lines: Array.from({ length: 800 }, () => LINES.lines[0]!) });
  assert.throws(() => buildUblDocument(makeDocument('01', { totals: many })), /code 210/);
});
