/**
 * A quotation (A4 portrait): what the business offers, line by line, with
 * GST, and until when. Not a tax document: it says so, and carries no BTS
 * number. The tax invoice is issued when the customer accepts.
 */

import PDFDocument from 'pdfkit';
import { fitLogo, formatAmount } from './pdf.ts';

export interface QuoteInput {
  business: { name: string; tin: string; address: string; telephone: string; email: string };
  /** The business's logo (PNG or JPEG), top right. */
  logo?: Buffer;
  customer: { name: string; tin: string | null; addressLines: string[]; email: string | null };
  number: string;
  date: string;
  validUntil: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'invoiced' | 'cancelled';
  expired: boolean;
  lines: Array<{ description: string; quantity: string; unit: string; unitPrice: string; gst: string; total: string }>;
  totals: { subtotal: string; gst: string; total: string };
  terms: string | null;
  note: string | null;
  acceptedBy: string | null;
}

const STAMP: Partial<Record<QuoteInput['status'], [string, string]>> = {
  accepted: ['ACCEPTED', '#0f5a1b'],
  invoiced: ['INVOICED', '#0f5a1b'],
  declined: ['DECLINED', '#9c2a1d'],
  cancelled: ['CANCELLED', '#635b68'],
};

export function renderQuote(q: QuoteInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Quotation ${q.number}`, Author: q.business.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const brand = '#4a1b66';

  // ---- header ----
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#160923').text('Quotation', left, 42);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`${q.number} · ${q.date}`);
  // The logo, top right, above the business's name.
  const logo = fitLogo(q.logo, 140, 40);
  if (logo) doc.image(logo.data, left + width - logo.w, 42, { width: logo.w, height: logo.h });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(q.business.name, left, logo ? 42 + logo.h + 6 : 42, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342')
    .text(`TIN ${q.business.tin}`, { width, align: 'right' })
    .text(q.business.address, { width, align: 'right' })
    .text(`${q.business.telephone} · ${q.business.email}`, { width, align: 'right' });

  let y = Math.max(120, doc.y + 12);
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#e6e1ea').lineWidth(1).stroke();
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('PREPARED FOR', left, y);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#160923').text(q.customer.name, left, y + 11, { width: width - 210 });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342');
  if (q.customer.tin) doc.text(`TIN ${q.customer.tin}`, { width: width - 210 });
  for (const l of q.customer.addressLines) doc.text(l, { width: width - 210 });
  if (q.customer.email) doc.text(q.customer.email, { width: width - 210 });
  const afterCustomer = doc.y;

  // Validity, boxed.
  const boxW = 190;
  const bx = left + width - boxW;
  doc.roundedRect(bx, y - 4, boxW, 58, 6).fillColor('#f6f1fa').fill();
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('TOTAL (BZD, GST INCLUDED)', bx + 12, y + 4);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(brand).text(formatAmount(q.totals.total), bx + 12, y + 16, { width: boxW - 24 });
  doc.font('Helvetica').fontSize(8).fillColor(q.expired ? '#9c2a1d' : '#635b68').text(q.expired ? `Expired on ${q.validUntil}` : `Valid until ${q.validUntil}`, bx + 12, y + 40, { width: boxW - 24 });
  y = Math.max(afterCustomer, y + 58) + 18;

  const stamp = STAMP[q.status];
  if (stamp) {
    doc.save().rotate(-12, { origin: [left + width - 110, y - 6] });
    doc.roundedRect(left + width - 190, y - 22, 150, 30, 4).lineWidth(2).strokeColor(stamp[1]).stroke();
    doc.font('Helvetica-Bold').fontSize(14).fillColor(stamp[1]).text(stamp[0], left + width - 190, y - 14, { width: 150, align: 'center' });
    doc.restore();
  }

  // ---- lines ----
  const cols = [
    { title: 'Description', w: width - 330, align: 'left' as const },
    { title: 'Qty', w: 50, align: 'right' as const },
    { title: 'Unit', w: 50, align: 'left' as const },
    { title: 'Unit price', w: 80, align: 'right' as const },
    { title: 'GST', w: 60, align: 'right' as const },
    { title: 'Total', w: 90, align: 'right' as const },
  ];
  const row = (cells: string[], bold = false, color = '#160923') => {
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i]!.w - 6 })));
    cells.forEach((c, i) => {
      doc.text(c, x + 3, y, { width: cols[i]!.w - 6, align: cols[i]!.align });
      x += cols[i]!.w;
    });
    y += Math.max(14, h) + 4;
  };
  row(cols.map((c) => c.title.toUpperCase()), true, '#635b68');
  doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#160923').lineWidth(1).stroke();
  for (const l of q.lines) {
    if (y > doc.page.height - 160) {
      doc.addPage();
      y = 42;
    }
    row([l.description, l.quantity, l.unit, formatAmount(l.unitPrice), formatAmount(l.gst), formatAmount(l.total)]);
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#e6e1ea').lineWidth(0.5).stroke();
  }
  y += 6;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor('#160923')
      .text(label, left + width - 240, y, { width: 140, align: 'right' })
      .text(formatAmount(value), left + width - 95, y, { width: 92, align: 'right' });
    y += bold ? 18 : 14;
  };
  totalRow('Subtotal', q.totals.subtotal);
  totalRow('GST', q.totals.gst);
  totalRow('Total BZ$', q.totals.total, true);

  // ---- terms and notes ----
  y += 12;
  if (q.terms) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#160923').text('Payment terms', left, y);
    doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(q.terms, left, doc.y + 2, { width });
    y = doc.y + 10;
  }
  if (q.note) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#160923').text('Notes', left, y);
    doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(q.note, left, doc.y + 2, { width });
    y = doc.y + 10;
  }
  if (q.acceptedBy && (q.status === 'accepted' || q.status === 'invoiced')) {
    doc.font('Helvetica').fontSize(9).fillColor('#0f5a1b').text(`Accepted by ${q.acceptedBy}.`, left, y, { width });
  }
  doc.font('Helvetica').fontSize(8).fillColor('#635b68')
    .text('This is a quotation, not a tax invoice. A tax invoice authorized by the Belize Tax Service is issued when the quotation is accepted.', left, doc.page.height - 70, { width, align: 'center' })
    .text(`Questions? ${q.business.email} · ${q.business.telephone}`, { width, align: 'center' });
  doc.end();
  return done;
}
