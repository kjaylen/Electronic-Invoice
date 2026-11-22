/**
 * The GST worksheet for a period (A4): GST charged on sales from the
 * business's own e-invoices, GST paid on purchases from its recorded
 * expenses, and the difference to pay or carry forward. A working paper for
 * filing the return with the Belize Tax Service, not the return itself.
 */

import PDFDocument from 'pdfkit';
import { formatAmount } from './pdf.ts';

export interface GstReturnInput {
  business: { name: string; tin: string };
  period: { from: string; to: string };
  environment: 'test' | 'production';
  sales: { standard: { net: string; gst: string }; zero: { net: string }; exempt: { net: string }; documents: number };
  purchases: { claimable: { net: string; gst: string }; notClaimable: { net: string; gst: string }; zero: { net: string }; exempt: { net: string }; noGst: { net: string }; expenses: number };
  outputGst: string;
  inputGst: string;
  net: string;
  warnings: string[];
}

export function renderGstReturn(r: GstReturnInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `GST worksheet ${r.period.from} to ${r.period.to}`, Author: r.business.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#160923').text('GST worksheet', left, 48);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`${r.period.from} to ${r.period.to}`);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(r.business.name, left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(`TIN ${r.business.tin}`, { width, align: 'right' });
  if (r.environment === 'test') doc.fillColor('#9c2a1d').text('TEST ENVIRONMENT: no tax value', { width, align: 'right' });

  let y = 110;
  const section = (title: string) => {
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(title, left, y);
    y += 18;
    doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor('#160923').lineWidth(1).stroke();
  };
  const row = (label: string, net: string | null, gst: string | null, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#160923')
      .text(label, left, y, { width: width - 220 })
      .text(net === null ? '' : formatAmount(net), left + width - 220, y, { width: 105, align: 'right' })
      .text(gst === null ? '' : formatAmount(gst), left + width - 105, y, { width: 105, align: 'right' });
    y += 18;
    doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor('#e6e1ea').lineWidth(0.5).stroke();
  };
  const head = () => {
    doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('NET (BZD)', left + width - 220, y, { width: 105, align: 'right' }).text('GST (BZD)', left + width - 105, y, { width: 105, align: 'right' });
    y += 14;
  };

  section(`Sales (${r.sales.documents} documents)`);
  head();
  row('Standard-rated sales (12.5%)', r.sales.standard.net, r.sales.standard.gst);
  row('Zero-rated sales', r.sales.zero.net, '0.00');
  row('Exempt sales', r.sales.exempt.net, null);
  row('GST charged on sales (output tax)', null, r.outputGst, true);

  section(`Purchases and expenses (${r.purchases.expenses} recorded)`);
  head();
  row('Standard-rated, with a tax invoice (GST claimable)', r.purchases.claimable.net, r.purchases.claimable.gst);
  row('Standard-rated, GST not claimable', r.purchases.notClaimable.net, r.purchases.notClaimable.gst);
  row('Zero-rated purchases', r.purchases.zero.net, '0.00');
  row('Exempt purchases', r.purchases.exempt.net, null);
  row('From suppliers not charging GST', r.purchases.noGst.net, null);
  row('GST paid on purchases you can claim (input tax)', null, r.inputGst, true);

  y += 16;
  const owe = !r.net.startsWith('-');
  doc.roundedRect(left, y, width, 52, 6).fillColor(owe ? '#f6f1fa' : '#e3fbe5').fill();
  doc.font('Helvetica').fontSize(9).fillColor('#635b68').text(owe ? 'GST TO PAY FOR THE PERIOD' : 'GST CREDIT FOR THE PERIOD', left + 14, y + 10);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(owe ? '#4a1b66' : '#0f5a1b').text(`BZ$ ${formatAmount(r.net.replace('-', ''))}`, left + 14, y + 22);
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
    'Sales are taken from the electronic tax documents authorized by BTS (credit notes subtract, debit notes add), by issue date. Purchases are the expenses recorded in the period, by their date. This worksheet helps you fill in the GST return; the return filed with the Belize Tax Service is what counts.',
    left, doc.page.height - 84, { width, align: 'center' },
  );
  doc.end();
  return done;
}
