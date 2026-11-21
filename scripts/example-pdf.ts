/**
 * Render sample printed copies into out/ for a visual check.
 *
 *   npm run example:pdf
 *
 * Uses the throwaway test certificate, so every sample is a test-environment
 * document and carries "Transmitted to tests environment, no fiscal value".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { calculateDocument } from '../src/engine/calc.ts';
import { loadSigningCredentials } from '../src/engine/certificate.ts';
import { signDocument } from '../src/engine/sign.ts';
import { buildUblDocument } from '../src/engine/ubl.ts';
import { renderReceipt, renderSheet } from '../src/render/pdf.ts';
import { readEtdForPrint } from '../src/render/view.ts';
import { etduiFor, LINES, makeDocument } from '../test/fixtures.ts';

const certs = new URL('../test/certs/', import.meta.url);
const creds = loadSigningCredentials(readFileSync(new URL('signer-123456.key.pem', certs), 'utf8'), readFileSync(new URL('signer-123456.cert.pem', certs), 'utf8'));
const when = new Date(creds.certificate.validFrom.getTime() + 86_400_000);
const sign = (xml: string) => signDocument(xml, creds, { signingTime: when }).xml;
const PROTOCOL = '05000000100013326800126012820091024411146627';
const out = new URL('../out/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name: string, data: Buffer) => {
  writeFileSync(new URL(name, out), data);
  console.log(`out/${name}  ${(data.length / 1024).toFixed(0)} KB`);
};
const message = 'Thank you for your business!';

// 1. Tax invoice with fuel taxes, a discount and a zero-rated line.
const invoice = readEtdForPrint(sign(buildUblDocument(makeDocument('01')).xml));
write('invoice-a4.pdf', await renderSheet(invoice, { protocolNumber: PROTOCOL, issuerMessage: message }));
write('invoice-thermal-80mm.pdf', await renderReceipt(invoice, { protocolNumber: PROTOCOL, issuerMessage: message }));

// 2. A long invoice across several sheets.
const many = calculateDocument({ lines: Array.from({ length: 120 }, (_, i) => ({ ...LINES.lines[1]!, description: `Engine oil 5W-30, case ${i + 1}` })) });
const long = readEtdForPrint(sign(buildUblDocument(makeDocument('01', { totals: many })).xml));
write('invoice-multipage-a4.pdf', await renderSheet(long, { protocolNumber: PROTOCOL }));

// 3. Contingency (subsequent authorization): "Pending of BTS authorization", no protocol.
const contingency = readEtdForPrint(
  sign(buildUblDocument(makeDocument('01', { etdui: etduiFor('01', 7, 2, 900), contingency: { reason: 'BTS reception unreachable', initDate: '2026-11-21', initTime: '13:50:00' } })).xml),
);
write('invoice-contingency-a4.pdf', await renderSheet(contingency));

// 4. Walk-in tax receipt on 80 mm and 58 mm rolls.
const receipt = readEtdForPrint(
  sign(buildUblDocument(makeDocument('02', {
    customer: undefined,
    totals: calculateDocument({ lines: [{ description: 'Coffee, large', quantity: '2', unitCode: 'H87', unitPrice: '6.00', gstCategory: 'S' }, { description: 'Johnny cake', quantity: '3', unitCode: 'H87', unitPrice: '2.50', gstCategory: 'S' }] }),
    payment: { meansCode: '10', terms: 'Paid in cash' },
  })).xml),
);
write('receipt-thermal-80mm.pdf', await renderReceipt(receipt, { protocolNumber: PROTOCOL, issuerMessage: 'Have a great day!' }));
write('receipt-thermal-58mm.pdf', await renderReceipt(receipt, { protocolNumber: PROTOCOL, widthMm: 58 }));

// 5. Credit note referencing the original invoice.
const credit = readEtdForPrint(sign(buildUblDocument(makeDocument('04')).xml));
write('credit-note-a4.pdf', await renderSheet(credit, { protocolNumber: PROTOCOL }));
