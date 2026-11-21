import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQRImport from 'jsqr';
import { PNG } from 'pngjs';
import { calculateDocument } from '../src/engine/calc.ts';
import { loadSigningCredentials } from '../src/engine/certificate.ts';
import { signDocument } from '../src/engine/sign.ts';
import { buildUblDocument } from '../src/engine/ubl.ts';
import { formatAmount, qrCodePng, renderReceipt, renderSheet } from '../src/render/pdf.ts';
import { PrintError, QR_BASE_URLS, qrUrl, readEtdForPrint, REGULATORY_MESSAGES } from '../src/render/view.ts';
import { etduiFor, LINES, makeDocument } from './fixtures.ts';

const certs = new URL('./certs/', import.meta.url);
const CREDS = loadSigningCredentials(readFileSync(new URL('signer-123456.key.pem', certs), 'utf8'), readFileSync(new URL('signer-123456.cert.pem', certs), 'utf8'));
const sign = (xml: string) => signDocument(xml, CREDS, { signingTime: new Date(CREDS.certificate.validFrom.getTime() + 86_400_000) }).xml;
const PROTOCOL = '05000000100013326800126012820091024411146627';
// jsqr is CommonJS with an ESM-style type declaration; take whichever shape the runtime gives.
const jsQR = ((jsQRImport as unknown as { default?: unknown }).default ?? jsQRImport) as (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const CONTINGENCY = { reason: 'BTS reception unreachable', initDate: '2026-11-21', initTime: '13:50:00' };

const invoice = () => readEtdForPrint(sign(buildUblDocument(makeDocument('01')).xml));
const contingencyInvoice = () => readEtdForPrint(sign(buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency: CONTINGENCY })).xml));

// Present on most dev machines (Poppler or Xpdf; Xpdf exits 99 on -v), so test by whether it launches.
const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;
function pdfText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'etd-pdf-'));
  try {
    const file = join(dir, 'doc.pdf');
    writeFileSync(file, pdf);
    return spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const mediaBox = (pdf: Buffer) => /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1'))!.slice(1).map(Number) as [number, number];

// ---------- what goes on the printed copy ----------

test('reads every printed field back from the signed XML', () => {
  const v = invoice();
  assert.equal(v.typeName, 'Tax Invoice');
  assert.equal(v.number, '000000042');
  assert.equal(v.series, '001');
  assert.equal(v.issueDate, '2026-11-21');
  assert.equal(v.issueTime, '14:05:33');
  assert.equal(v.issuer.name, 'CaribFuel');
  assert.equal(v.issuer.tin, '123456');
  assert.deepEqual(v.issuer.addressLines, ['12 Regent Street', 'Belize City, Belize']);
  assert.equal(v.customer?.name, 'Island Logistics Ltd.');
  assert.equal(v.customer?.tin, '654321');
  assert.equal(v.lines.length, 3);
  assert.deepEqual(
    { ...v.lines[0]!, adjustments: v.lines[0]!.adjustments.map((a) => a.reason) },
    { number: '1', quantity: '3000', unitCode: 'GLL', description: 'Diesel', code: '30015', unitPrice: '5.7354', adjustments: ['Freight'], net: '17536.20', tax: '12798.64', total: '30334.84' },
  );
  assert.deepEqual(v.totals, {
    taxExclusive: '17763.20',
    gst: '3390.79',
    otherTaxes: [{ scheme: 'EXC', amount: '8918.10' }, { scheme: 'ENV', amount: '510.00' }],
    taxInclusive: '30582.09',
    payable: '30582.09',
  });
  assert.deepEqual(v.payment, { dueDate: '2026-12-21', terms: 'Net 30' });
  assert.deepEqual(v.regulatory, [REGULATORY_MESSAGES.testEnvironment], 'test-environment documents say so (table 3-3)');
  assert.equal(v.pendingAuthorization, false);
});

test('a contingency document carries "Pending of BTS authorization" and its contingency info', () => {
  const v = contingencyInvoice();
  assert.equal(v.pendingAuthorization, true);
  assert.deepEqual(v.regulatory, [REGULATORY_MESSAGES.testEnvironment, REGULATORY_MESSAGES.pendingAuthorization]);
  assert.deepEqual(v.contingency, CONTINGENCY);
  assert.equal(v.series, '900');
});

test('a credit note shows the document it corrects; an anonymous receipt has no customer', () => {
  const credit = readEtdForPrint(sign(buildUblDocument(makeDocument('04')).xml));
  assert.equal(credit.typeName, 'Credit Note');
  assert.equal(credit.reference?.documentType, 'Tax Invoice');
  assert.equal(credit.reference?.reason, 'Price correction');
  const receipt = readEtdForPrint(sign(buildUblDocument(makeDocument('02', { customer: undefined })).xml));
  assert.equal(receipt.customer, undefined);
});

test('only invoices and credit notes have a printed copy', () => {
  assert.throws(() => readEtdForPrint('<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"/>'), PrintError);
});

// ---------- QR code ----------

test('QR URL: BTS lookup with the ETDUI, production or test host', () => {
  const prod = '01023456777401919700126012823091021306598061'.replace(/^(.{32})02/, '$101'); // same ID, env 01
  assert.ok(qrUrl(etduiFor('01', 1)).startsWith(QR_BASE_URLS.test));
  assert.equal(qrUrl('01023456777401919700126012823091021306598061'), `${QR_BASE_URLS.test}01023456777401919700126012823091021306598061`);
  assert.ok(QR_BASE_URLS.production.startsWith('https://portal.prod.bz.efdrciat.org/QRCode?UUID='));
  assert.equal(qrUrl(etduiFor('01', 1), { baseUrl: 'https://x/?id=' }), `https://x/?id=${etduiFor('01', 1)}`);
  void prod;
});

test('the QR image decodes to the lookup URL for this document', async () => {
  const etdui = etduiFor('01', 42);
  const png = PNG.sync.read(await qrCodePng(etdui));
  // jsQR needs a quiet zone; add one around the margin-less image.
  const pad = 40;
  const w = png.width + 2 * pad;
  const h = png.height + 2 * pad;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const s = (y * png.width + x) * 4;
      const d = ((y + pad) * w + (x + pad)) * 4;
      data.set(png.data.subarray(s, s + 4), d);
    }
  }
  const decoded = jsQR(data, w, h);
  assert.equal(decoded?.data, qrUrl(etdui));
});

// ---------- sheets ----------

test('A4 sheet: a valid one-page PDF, landscape by default, portrait on request', async () => {
  const pdf = await renderSheet(invoice(), { protocolNumber: PROTOCOL });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
  assert.equal(pageCount(pdf), 1);
  const [w, h] = mediaBox(pdf);
  assert.ok(w > h, 'landscape');
  const portrait = await renderSheet(invoice(), { protocolNumber: PROTOCOL, orientation: 'portrait', paper: 'LETTER' });
  const [pw, ph] = mediaBox(portrait);
  assert.deepEqual([pw, ph], [612, 792]);
});

test('A4 sheet text: fields, authorization protocol and regulatory message', { skip: !hasPdftotext && 'needs pdftotext' }, async () => {
  const text = pdfText(await renderSheet(invoice(), { protocolNumber: PROTOCOL, issuerMessage: 'Thank you!' }));
  for (const expected of ['TAX INVOICE', 'CaribFuel', 'TIN 123456', 'Island Logistics Ltd.', '000000042', etduiFor('01', 42), PROTOCOL, '30,334.84', '30,582.09', REGULATORY_MESSAGES.testEnvironment, 'Thank you!']) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  assert.ok(!text.includes('Sheet 1 of'), 'a one-sheet document has no sheet counter');
});

test('long documents: "Sheet n of m" on every sheet, totals only on the last', { skip: !hasPdftotext && 'needs pdftotext' }, async () => {
  const many = calculateDocument({ lines: Array.from({ length: 120 }, (_, i) => ({ ...LINES.lines[2]!, description: `Rice 25 lb, bag ${i + 1}` })) });
  const pdf = await renderSheet(readEtdForPrint(sign(buildUblDocument(makeDocument('01', { totals: many })).xml)), { protocolNumber: PROTOCOL });
  const m = pageCount(pdf);
  assert.ok(m > 1);
  const pages = pdfText(pdf).split('\f').filter((p) => p.trim());
  assert.equal(pages.length, m);
  pages.forEach((page, i) => {
    assert.ok(page.includes(`Sheet ${i + 1} of ${m}`), `sheet ${i + 1} counter`);
    assert.ok(page.includes('CaribFuel') && page.includes('Island Logistics Ltd.'), `sheet ${i + 1} repeats the header`);
    assert.equal(page.includes('Amount due'), i === m - 1, `totals only on the last sheet (sheet ${i + 1})`);
  });
  for (let n = 1; n <= 120; n++) assert.ok(pages.some((p) => p.includes(`bag ${n}`)), `line ${n} printed`);
});

test('a contingency sheet needs no protocol and says it is pending', { skip: !hasPdftotext && 'needs pdftotext' }, async () => {
  const text = pdfText(await renderSheet(contingencyInvoice()));
  assert.ok(text.includes(REGULATORY_MESSAGES.pendingAuthorization));
  assert.ok(text.includes('Contingency since 2026-11-21 13:50:00'));
});

test('a previous-authorization document cannot be printed without the protocol, unless marked as a draft', async () => {
  await assert.rejects(renderSheet(invoice()), /authorization protocol/);
  await assert.rejects(renderReceipt(invoice()), /authorization protocol/);
  const draft = await renderSheet(invoice(), { draft: true });
  if (hasPdftotext) assert.ok(pdfText(draft).includes('DRAFT - NOT AUTHORIZED BY BTS'));
});

// ---------- thermal receipts ----------

test('thermal receipt: 80 mm default, 58 mm on request, height fits the content', async () => {
  const v = readEtdForPrint(sign(buildUblDocument(makeDocument('02', { customer: undefined })).xml));
  const r80 = await renderReceipt(v, { protocolNumber: PROTOCOL });
  const [w80, h80] = mediaBox(r80);
  assert.ok(Math.abs(w80 - (80 * 72) / 25.4) < 0.01);
  assert.ok(h80 > 300 && h80 < 2000);
  assert.equal(pageCount(r80), 1);
  const [w58] = mediaBox(await renderReceipt(v, { protocolNumber: PROTOCOL, widthMm: 58 }));
  assert.ok(Math.abs(w58 - (58 * 72) / 25.4) < 0.01);
  if (hasPdftotext) {
    const text = pdfText(r80).replace(/\s+/g, ' '); // narrow paper wraps long messages
    for (const expected of ['TAX RECEIPT', 'TOTAL', REGULATORY_MESSAGES.testEnvironment]) assert.ok(text.includes(expected), expected);
  }
});

test('thermal rolls: only invoices and receipts, 56 to 80 mm', async () => {
  const debit = readEtdForPrint(sign(buildUblDocument(makeDocument('03')).xml));
  await assert.rejects(renderReceipt(debit, { protocolNumber: PROTOCOL }), /only for Tax Invoices and Tax Receipts/);
  await assert.rejects(renderReceipt(invoice(), { protocolNumber: PROTOCOL, widthMm: 50 }), /56 to 80 mm/);
});

test('amounts print with thousands separators and two decimals', () => {
  assert.equal(formatAmount('30334.84'), '30,334.84');
  assert.equal(formatAmount('5.7354'), '5.7354');
  assert.equal(formatAmount('-18'), '-18.00');
  assert.equal(formatAmount('1234567.5'), '1,234,567.50');
});
