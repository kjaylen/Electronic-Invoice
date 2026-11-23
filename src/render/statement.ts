/**
 * A customer's statement of account (A4 portrait): who owes what, invoice by
 * invoice, with how late each is, recent payments, and the total due.
 */

import PDFDocument from 'pdfkit';
import { fitLogo, formatAmount } from './pdf.ts';

export interface StatementInput {
  business: { name: string; tin: string; address: string; telephone: string; email: string };
  /** The business's logo (PNG or JPEG), top right. */
  logo?: Buffer;
  customer: { name: string; tin: string | null };
  asOf: string;
  open: Array<{ type: string; number: string; issueDate: string; dueDate: string; daysOverdue: number; total: string; paid: string; credited: string; balance: string }>;
  payments: Array<{ number: string; paidOn: string; method: string; reference: string | null; amount: string }>;
  totalDue: string;
  overdue: string;
  payUrl?: string | null;
  note?: string | null;
}

const TYPE: Record<string, string> = { '01': 'Tax invoice', '03': 'Debit note' };
const METHOD: Record<string, string> = { cash: 'Cash', cheque: 'Cheque', bank_transfer: 'Bank transfer', card: 'Card', online: 'Online', refund: 'Refund', other: 'Other' };

export function renderStatement(s: StatementInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Statement for ${s.customer.name}`, Author: s.business.name } });
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
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#160923').text('Statement of account', left, 42);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`As of ${s.asOf}`);
  // The logo, top right, above the business's name.
  const logo = fitLogo(s.logo, 140, 40);
  if (logo) doc.image(logo.data, left + width - logo.w, 42, { width: logo.w, height: logo.h });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(s.business.name, left, logo ? 42 + logo.h + 6 : 42, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342')
    .text(`TIN ${s.business.tin}`, { width, align: 'right' })
    .text(s.business.address, { width, align: 'right' })
    .text(`${s.business.telephone} · ${s.business.email}`, { width, align: 'right' });

  let y = Math.max(120, doc.y + 12);
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#e6e1ea').lineWidth(1).stroke();
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('STATEMENT FOR', left, y);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#160923').text(s.customer.name, left, y + 11);
  if (s.customer.tin) doc.font('Helvetica').fontSize(10).fillColor('#3b3342').text(`TIN ${s.customer.tin}`);

  // The amount due, boxed.
  const boxW = 190;
  const bx = left + width - boxW;
  doc.roundedRect(bx, y - 4, boxW, 58, 6).fillColor('#f6f1fa').fill();
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('TOTAL DUE (BZD)', bx + 12, y + 4);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(brand).text(formatAmount(s.totalDue), bx + 12, y + 16, { width: boxW - 24 });
  if (s.overdue !== '0.00') doc.font('Helvetica').fontSize(8).fillColor('#9c2a1d').text(`of which overdue: ${formatAmount(s.overdue)}`, bx + 12, y + 40, { width: boxW - 24 });
  y += 74;

  // ---- open invoices ----
  const cols = [
    { title: 'Document', w: 120, align: 'left' as const },
    { title: 'Issued', w: 62, align: 'left' as const },
    { title: 'Due', w: 62, align: 'left' as const },
    { title: 'Late', w: 46, align: 'right' as const },
    { title: 'Amount', w: 72, align: 'right' as const },
    { title: 'Paid/credited', w: 78, align: 'right' as const },
    { title: 'Balance', w: width - 440, align: 'right' as const },
  ];
  const row = (cells: string[], bold = false, color = '#160923') => {
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
    cells.forEach((c, i) => {
      doc.text(c, x + 3, y, { width: cols[i]!.w - 6, align: cols[i]!.align, lineBreak: false });
      x += cols[i]!.w;
    });
    y += 16;
  };
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text('Open invoices', left, y);
  y += 16;
  row(cols.map((c) => c.title.toUpperCase()), true, '#635b68');
  doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#160923').lineWidth(1).stroke();
  if (!s.open.length) row(['Nothing open. Thank you.', '', '', '', '', '', '']);
  for (const r of s.open) {
    if (y > doc.page.height - 120) {
      doc.addPage();
      y = 42;
    }
    const paid = (Number(r.paid) + Number(r.credited)).toFixed(2);
    row([`${TYPE[r.type] ?? 'Document'} ${r.number}`, r.issueDate, r.dueDate, r.daysOverdue > 0 ? `${r.daysOverdue} d` : '', formatAmount(r.total), formatAmount(paid), formatAmount(r.balance)], false, r.daysOverdue > 30 ? '#9c2a1d' : '#160923');
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#e6e1ea').lineWidth(0.5).stroke();
  }
  y += 4;
  row(['', '', '', '', '', 'Total due', formatAmount(s.totalDue)], true);

  // ---- recent payments ----
  if (s.payments.length) {
    y += 14;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text('Payments received (last 90 days)', left, y);
    y += 16;
    for (const p of s.payments.slice(0, 20)) {
      doc.font('Helvetica').fontSize(9).fillColor('#3b3342')
        .text(`${p.paidOn}   ${METHOD[p.method] ?? p.method}${p.reference ? ` (${p.reference})` : ''} · ${p.number}`, left + 3, y, { width: width - 90, lineBreak: false })
        .text(formatAmount(p.amount), left + width - 87, y, { width: 84, align: 'right' });
      y += 14;
    }
  }

  // ---- how to pay ----
  y += 18;
  if (s.payUrl || s.note) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text('How to pay', left, y);
    y += 14;
    if (s.note) {
      doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(s.note, left, y, { width });
      y = doc.y + 6;
    }
    if (s.payUrl) doc.font('Helvetica').fontSize(9).fillColor(brand).text(`Pay online: ${s.payUrl}`, left, y, { width, link: s.payUrl, underline: true });
  }
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text(`Questions about this statement? ${s.business.email} · ${s.business.telephone}`, left, doc.page.height - 60, { width, align: 'center' });
  doc.end();
  return done;
}
