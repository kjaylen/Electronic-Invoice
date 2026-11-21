import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { calculateDocument } from '../src/engine/calc.ts';
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

function children(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (n): n is Element => (n as Element).namespaceURI === ns && (n as Element).localName === name,
  );
}

/** Text of the first direct child element with this name. */
function child(parent: Element, ns: string, name: string): string | undefined {
  return children(parent, ns, name)[0]?.textContent ?? undefined;
}

const CONTINGENCY = { reason: 'Fiber optic circuit unavailable', initDate: '2026-11-21', initTime: '13:50:00' };

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

test('the schema check really catches errors (wrong element order, missing required attribute)', async () => {
  const { xml } = buildUblDocument(makeDocument('01'));
  const reordered = xml
    .replace('<cbc:IssueDate>2026-11-21</cbc:IssueDate>', '')
    .replace('<cbc:DocumentCurrencyCode>', '<cbc:IssueDate>2026-11-21</cbc:IssueDate><cbc:DocumentCurrencyCode>');
  assert.equal((await validateUbl(reordered, 'Invoice')).valid, false);
  assert.equal((await validateUbl(xml.replace(/ currencyID="BZD"/, ''), 'Invoice')).valid, false);
});

test('subsequent-authorization documents and anonymous receipts validate too', async () => {
  const docs = [
    buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency: CONTINGENCY })),
    buildUblDocument(makeDocument('02', { etdui: etduiFor('02', 7, 3, 900), contingency: CONTINGENCY })),
    buildUblDocument(makeDocument('02', { etdui: etduiFor('02', 8, 3) })), // mode 3 in normal operation
    buildUblDocument(makeDocument('04', { etdui: etduiFor('04', 7, 2, 900), contingency: CONTINGENCY })),
    buildUblDocument(makeDocument('02', { customer: undefined, payment: { meansCode: '10', terms: 'Paid in cash' } })),
    buildUblDocument(makeDocument('02', { customer: { otherId: { scheme: 'SSN', value: '000123456' } } })),
  ];
  for (const d of docs) {
    const { valid, errors } = await validateUbl(d.xml, d.rootElement);
    assert.ok(valid, errors.join('\n'));
  }
});

test('no whitespace between tags or around the document (BTS rule C02, code 221)', () => {
  const input = makeDocument('01', { note: '  padded note  ', customer: { ...makeDocument('01').customer!, name: '  Island Logistics Ltd.  ' } });
  const { xml } = buildUblDocument(input);
  assert.doesNotMatch(xml, />\s+</);
  assert.equal(xml, xml.trim());
  assert.match(xml, /<cbc:Note>padded note<\/cbc:Note>/);
});

test('header values and the EFDR extension follow the manual', () => {
  const input = makeDocument('01');
  const result = buildUblDocument(input);
  const doc = parse(result.xml);
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
  const typeCode = children(root, NS.cbc, 'InvoiceTypeCode')[0]!;
  assert.equal(typeCode.textContent, '380');
  assert.equal(typeCode.getAttribute('listID'), 'UN/ECE 1001 Subset');
  assert.equal(typeCode.getAttribute('listAgencyID'), 'UN/CEFACT');
  assert.equal(child(root, NS.cbc, 'DocumentCurrencyCode'), 'BZD');
  assert.equal(child(root, NS.cbc, 'LineCountNumeric'), '3');

  const addElem = all(doc, NS.efdr, 'ETDUIAddElem')[0]!;
  assert.equal(child(addElem, NS.efdr, 'ETDType'), '01');
  assert.equal(child(addElem, NS.efdr, 'series'), '001');
  assert.equal(child(addElem, NS.efdr, 'operMode'), '1');
  assert.equal(child(addElem, NS.efdr, 'receptionEnv'), '02');
  assert.equal(child(addElem, NS.efdr, 'securityCode'), '473298514');
  assert.equal(child(addElem, NS.efdr, 'checkDigit'), input.etdui[43]);

  // sequenceInfo wraps the two hash elements (table 4-22, example 4.7).
  const seq = all(doc, NS.efdr, 'sequenceInfo')[0]!;
  assert.equal((seq.parentNode as Element).localName, 'EFDRExtensions');
  assert.equal(child(seq, NS.efdr, 'sequenceInfoThisETD'), result.sequenceInfoThisEtd);
  assert.equal(child(seq, NS.efdr, 'sequenceInfoPreviousETD'), result.sequenceInfoThisEtd); // first in series: self
  assert.equal(all(doc, NS.efdr, 'contingencyInfo').length, 0);

  const supplier = all(doc, NS.cac, 'AccountingSupplierParty')[0]!;
  assert.equal(all(all(supplier, NS.cac, 'PartyTaxScheme')[0]!, NS.cbc, 'CompanyID')[0]!.textContent, '123456');
  assert.equal(all(all(supplier, NS.cac, 'PartyLegalEntity')[0]!, NS.cbc, 'CompanyID')[0]!.textContent, '123456');
  assert.equal(all(supplier, NS.cbc, 'CountrySubentity')[0]!.textContent, 'Belize');
  assert.equal(all(supplier, NS.cbc, 'CountrySubentityCode')[0]!.textContent, '1');
  assert.equal(all(supplier, NS.cbc, 'IdentificationCode')[0]!.textContent, 'BLZ');

  const legal = all(doc, NS.cac, 'LegalMonetaryTotal')[0]!;
  // Diesel 17,536.20 + oil 180.00 - 10% 18.00 + rice 65.00
  assert.equal(child(legal, NS.cbc, 'LineExtensionAmount'), '17763.20');
  assert.equal(child(legal, NS.cbc, 'PrepaidAmount'), undefined);
});

test('document-level TaxTotal: one per tax scheme, GST first', () => {
  const input = makeDocument('01');
  const doc = parse(buildUblDocument(input).xml);
  const totals = children(doc.documentElement!, NS.cac, 'TaxTotal');
  const schemeOf = (tt: Element) => all(tt, NS.cac, 'TaxScheme').map((s) => child(s, NS.cbc, 'ID'));
  assert.deepEqual(totals.map(schemeOf), [['GST', 'GST'], ['EXC'], ['ENV']]);
  // GST on (26,964.30 diesel base + 162.00 oil after discount) x 12.5% = 3,390.7875, rounded once.
  assert.equal(child(totals[0]!, NS.cbc, 'TaxAmount'), '3390.79');
  assert.equal(child(totals[1]!, NS.cbc, 'TaxAmount'), '8918.10');
  assert.equal(child(totals[2]!, NS.cbc, 'TaxAmount'), '510.00');
});

test('sequence hash recomputed from the XML text matches, using the manual rule', () => {
  const result = buildUblDocument(makeDocument('01'));
  const doc = parse(result.xml);
  const root = doc.documentElement!;
  const firstTaxTotal = children(root, NS.cac, 'TaxTotal')[0]!;
  const legal = all(doc, NS.cac, 'LegalMonetaryTotal')[0]!;
  const source = {
    uuid: child(root, NS.cbc, 'UUID')!,
    lineCount: child(root, NS.cbc, 'LineCountNumeric')!,
    taxAmount: child(firstTaxTotal, NS.cbc, 'TaxAmount')!,
    lineExtensionAmount: child(legal, NS.cbc, 'LineExtensionAmount')!,
  };
  assert.equal(result.sequenceSource, `${source.uuid}${source.lineCount}${source.taxAmount}${source.lineExtensionAmount}`);
  assert.equal(all(doc, NS.efdr, 'sequenceInfoThisETD')[0]!.textContent, sequenceHash(source));
});

test('documents in a series chain to each other', () => {
  const first = buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 1) }));
  const second = buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 2), previousSequenceHash: first.sequenceInfoThisEtd }));
  const doc = parse(second.xml);
  assert.equal(all(doc, NS.efdr, 'sequenceInfoPreviousETD')[0]!.textContent, first.sequenceInfoThisEtd);
  assert.notEqual(second.sequenceInfoThisEtd, first.sequenceInfoThisEtd);
});

test('every amount carries currencyID BZD', () => {
  const doc = parse(buildUblDocument(makeDocument('01')).xml);
  const amountNames = ['TaxAmount', 'TaxableAmount', 'LineExtensionAmount', 'PayableAmount', 'PriceAmount', 'Amount', 'BaseAmount', 'PerUnitAmount'];
  for (const name of amountNames) {
    for (const e of all(doc, NS.cbc, name)) assert.equal(e.getAttribute('currencyID'), 'BZD', name);
  }
});

test('fuel line follows the manual example in 4.8.2', () => {
  const doc = parse(buildUblDocument(makeDocument('01')).xml);
  const line = all(doc, NS.cac, 'InvoiceLine')[0]!;
  const qty = children(line, NS.cbc, 'InvoicedQuantity')[0]!;
  assert.equal(qty.textContent, '3000');
  assert.equal(qty.getAttribute('unitCode'), 'GLL');

  // One line TaxTotal: GST, then ENV and EXC with the quantity as taxable amount and the per-unit rate.
  const taxTotals = children(line, NS.cac, 'TaxTotal');
  assert.equal(taxTotals.length, 1);
  assert.equal(child(taxTotals[0]!, NS.cbc, 'TaxAmount'), '12798.64');
  const subtotals = children(taxTotals[0]!, NS.cac, 'TaxSubtotal');
  assert.deepEqual(
    subtotals.map((s) => [
      child(s, NS.cbc, 'TaxableAmount'),
      child(s, NS.cbc, 'TaxAmount'),
      all(s, NS.cbc, 'PerUnitAmount')[0]?.textContent,
      child(all(s, NS.cac, 'TaxScheme')[0]!, NS.cbc, 'ID'),
    ]),
    [
      ['26964.30', '3370.54', undefined, 'GST'],
      ['3000', '510.00', '0.17', 'ENV'],
      ['3000', '8918.10', '2.9727', 'EXC'],
    ],
  );

  const itemEl = children(line, NS.cac, 'Item')[0]!;
  assert.equal(child(itemEl, NS.cbc, 'Description'), 'Diesel');
  assert.equal(child(itemEl, NS.cbc, 'Name'), 'Diesel');
  assert.equal(all(all(itemEl, NS.cac, 'SellersItemIdentification')[0]!, NS.cbc, 'ID')[0]!.textContent, '30015');
  assert.deepEqual(
    children(itemEl, NS.cac, 'ClassifiedTaxCategory').map((c) => child(all(c, NS.cac, 'TaxScheme')[0]!, NS.cbc, 'ID')),
    ['ENV', 'EXC', 'GST'],
  );

  const price = children(line, NS.cac, 'Price')[0]!;
  assert.equal(child(price, NS.cbc, 'PriceAmount'), '5.7354');
  assert.equal(children(price, NS.cbc, 'BaseQuantity')[0]!.getAttribute('unitCode'), 'GLL');

  const freight = children(line, NS.cac, 'AllowanceCharge')[0]!;
  assert.equal(child(freight, NS.cbc, 'ID'), '1');
  assert.equal(child(freight, NS.cbc, 'ChargeIndicator'), 'true');
  assert.equal(child(freight, NS.cbc, 'Amount'), '330.00');
  assert.equal(child(freight, NS.cbc, 'BaseAmount'), '17206.20');
});

test('percent allowance carries ID, factor, base amount and tax category', () => {
  const doc = parse(buildUblDocument(makeDocument('01')).xml);
  const discount = children(all(doc, NS.cac, 'InvoiceLine')[1]!, NS.cac, 'AllowanceCharge')[0]!;
  assert.equal(child(discount, NS.cbc, 'ID'), '1');
  assert.equal(child(discount, NS.cbc, 'ChargeIndicator'), 'false');
  assert.equal(child(discount, NS.cbc, 'MultiplierFactorNumeric'), '10');
  assert.equal(child(discount, NS.cbc, 'Amount'), '18.00');
  assert.equal(child(discount, NS.cbc, 'BaseAmount'), '180.00');
  assert.equal(children(discount, NS.cac, 'TaxCategory').length, 1);
});

test('credit note references the original with date, time and document type', () => {
  const input = makeDocument('04');
  const doc = parse(buildUblDocument(input).xml);
  assert.equal(doc.documentElement!.namespaceURI, NS.creditNote);
  assert.equal(child(doc.documentElement!, NS.cbc, 'CreditNoteTypeCode'), '381');
  assert.equal(all(doc, NS.cac, 'CreditNoteLine').length, 3);
  assert.equal(all(doc, NS.cbc, 'CreditedQuantity').length, 3);
  const ref = all(doc, NS.cac, 'AdditionalDocumentReference')[0]!;
  assert.equal(child(ref, NS.cbc, 'ID'), '000000041');
  assert.equal(child(ref, NS.cbc, 'UUID'), input.reference!.etdui);
  assert.equal(child(ref, NS.cbc, 'IssueDate'), '2026-11-20');
  assert.equal(child(ref, NS.cbc, 'IssueTime'), '14:05:00-06:00'); // taken from the referenced ETDUI
  assert.equal(child(ref, NS.cbc, 'DocumentTypeCode'), '01');
  assert.equal(child(ref, NS.cbc, 'DocumentType'), 'Tax Invoice');
  assert.equal(child(ref, NS.cbc, 'DocumentDescription'), 'Price correction');
});

test('debit note uses type code 80', () => {
  const doc = parse(buildUblDocument(makeDocument('03')).xml);
  assert.equal(child(doc.documentElement!, NS.cbc, 'InvoiceTypeCode'), '80');
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

test('a customer contact needs both telephone and email, or is left out', () => {
  const base = makeDocument('01').customer!;
  const doc = parse(buildUblDocument(makeDocument('01', { customer: { ...base, contact: { email: 'only@email.example' } } })).xml);
  assert.equal(all(all(doc, NS.cac, 'AccountingCustomerParty')[0]!, NS.cac, 'Contact').length, 0);
});

test('contingency info uses the manual names, with the time offset', () => {
  const doc = parse(buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency: CONTINGENCY })).xml);
  const info = all(doc, NS.efdr, 'contingencyInfo')[0]!;
  assert.equal((info.parentNode as Element).localName, 'EFDRExtensions');
  assert.equal(child(info, NS.efdr, 'contingencyReason'), CONTINGENCY.reason);
  assert.equal(child(info, NS.efdr, 'contingencyInitDate'), '2026-11-21');
  assert.equal(child(info, NS.efdr, 'contingencyInitTime'), '13:50:00-06:00');
  assert.equal(all(doc, NS.efdr, 'operMode')[0]!.textContent, '2');
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
  const supplier = makeDocument('01').supplier;
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['TIN mismatch', () => makeDocument('01', { supplier: { ...supplier, tin: '999999' } }), /TIN does not match/],
    ['invoice without customer', () => makeDocument('01', { customer: undefined }), /code 283/],
    ['wrong type for ETDUI', () => makeDocument('01', { etdui: etduiFor('02', 1) }), /document type 02, not 01/],
    ['time mismatch', () => makeDocument('01', { issueTime: '14:06:00' }), /do not match the ETDUI/],
    ['note without reference', () => makeDocument('04', { reference: undefined }), /must reference/],
    ['invoice with reference', () => makeDocument('01', { reference: { etdui: etduiFor('01', 1), reason: 'x' } }), /Only Debit and Credit/],
    ['operMode 2 without contingency', () => makeDocument('01', { etdui: etduiFor('01', 7, 2) }), /code 244/],
    ['operMode 1 with contingency', () => makeDocument('01', { contingency: CONTINGENCY }), /code 246/],
    ['bad contingency time', () => makeDocument('01', { etdui: etduiFor('01', 7, 2), contingency: { ...CONTINGENCY, initTime: '1:50' } }), /code 245/],
    ['amount due without terms', () => makeDocument('01', { payment: undefined }), /due date or payment terms/],
    ['due date without means', () => makeDocument('01', { payment: { dueDate: '2026-12-01' } }), /payment means code/],
    ['district code out of range', () => makeDocument('01', { supplier: { ...supplier, address: { ...supplier.address, districtCode: '7' as never } } }), /district code must be 1 to 6/],
    ['district name and code disagree', () => makeDocument('01', { supplier: { ...supplier, address: { ...supplier.address, districtName: 'Cayo' } } }), /district code 1 is Belize/],
    ['bad previous hash', () => makeDocument('01', { previousSequenceHash: 'abc' }), /Base64 SHA-1/],
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
