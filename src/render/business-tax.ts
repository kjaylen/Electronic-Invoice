/**
 * The business tax worksheet for a period (A4): receipts by kind, the rate
 * and the tax for each, less contract tax customers withheld, and what is
 * left to pay. A working paper for filing with the Belize Tax Service, not
 * the return itself.
 */

import PDFDocument from 'pdfkit';
import { formatAmount } from './pdf.ts';

export interface BusinessTaxInput {
  business: { name: string; tin: string };
  period: { from: string; to: string };
  environment: 'test' | 'production';
  documents: number;
  kinds: Array<{ name: string; rate: string; categories: string[]; receipts: string; tax: string }>;
  receipts: string;
  tax: string;
  withheld: { invoices: number; amount: string };
  toPay: string;
  dueOn: string;
  warnings: string[];
}

export function renderBusinessTax(r: BusinessTaxInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Business tax worksheet ${r.period.from} to ${r.period.to}`, Author: r.business.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#160923').text('Business tax worksheet', left, 48);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`${r.period.from} to ${r.period.to}`);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(r.business.name, left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(`TIN ${r.business.tin}`, { width, align: 'right' });
  if (r.environment === 'test') doc.fillColor('#9c2a1d').text('TEST ENVIRONMENT: no tax value', { width, align: 'right' });

  let y = 120;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(`Receipts (${r.documents} documents)`, left, y);
  y += 18;
  doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor('#160923').lineWidth(1).stroke();
  const cols = { receipts: left + width - 280, rate: left + width - 165, tax: left + width - 105 };
  doc.font('Helvetica').fontSize(8).fillColor('#635b68')
    .text('RECEIPTS BEFORE GST (BZD)', cols.receipts - 40, y, { width: 155, align: 'right' })
    .text('RATE', cols.rate, y, { width: 55, align: 'right' })
    .text('TAX (BZD)', cols.tax, y, { width: 105, align: 'right' });
  y += 14;
  const row = (label: string, receipts: string | null, rate: string | null, tax: string | null, bold = false, note?: string) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#160923')
      .text(label, left, y, { width: width - 300 })
      .text(receipts === null ? '' : formatAmount(receipts), cols.receipts, y, { width: 115, align: 'right' })
      .text(rate === null ? '' : `${rate}%`, cols.rate, y, { width: 55, align: 'right' })
      .text(tax === null ? '' : formatAmount(tax), cols.tax, y, { width: 105, align: 'right' });
    y += 16;
    if (note) {
      doc.font('Helvetica').fontSize(8).fillColor('#635b68').text(note, left, y - 2, { width: width - 300 });
      y = Math.max(y, doc.y) + 4;
    }
    doc.moveTo(left, y - 2).lineTo(left + width, y - 2).strokeColor('#e6e1ea').lineWidth(0.5).stroke();
    y += 4;
  };
  for (const [i, k] of r.kinds.entries()) {
    row(k.name, k.receipts, k.rate, k.tax, false, i === 0 ? (r.kinds.length > 1 ? 'Everything not listed under another kind' : undefined) : k.categories.length ? `Categories: ${k.categories.join(', ')}` : 'No categories chosen yet');
  }
  row('Total', r.receipts, null, r.tax, true);
  row(`Less contract tax withheld by customers (${r.withheld.invoices} invoice${r.withheld.invoices === 1 ? '' : 's'})`, null, null, r.withheld.amount === '0.00' ? '0.00' : `-${r.withheld.amount}`);

  y += 14;
  const owe = !r.toPay.startsWith('-');
  doc.roundedRect(left, y, width, 52, 6).fillColor(owe ? '#f6f1fa' : '#e3fbe5').fill();
  doc.font('Helvetica').fontSize(9).fillColor('#635b68').text(owe ? `BUSINESS TAX TO PAY BY ${r.dueOn}` : 'CREDIT TO CARRY FORWARD', left + 14, y + 10);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(owe ? '#4a1b66' : '#0f5a1b').text(`BZ$ ${formatAmount(r.toPay.replace('-', ''))}`, left + 14, y + 22);
  y += 70;

  if (r.warnings.length) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#9c2a1d').text('Check before filing', left, y);
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(9).fillColor('#3b3342');
    for (const w of r.warnings) {
      doc.text(`• ${w}`, left, y, { width });
      y = doc.y + 3;
    }
  }
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text(
    'Receipts are taken from the electronic tax documents authorized by BTS (credit notes subtract, debit notes add), before GST, by issue date. If you sell on account, ask your accountant whether to count a sale when it is invoiced or when it is paid. The rates are the ones you set; check them against what BTS publishes for your kind of business. This worksheet helps you fill in the business tax return; the return filed with the Belize Tax Service is what counts.',
    left, doc.page.height - 100, { width, align: 'center' },
  );
  doc.end();
  return done;
}
