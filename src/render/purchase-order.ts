/**
 * A purchase order (A4 portrait) for a supplier: what is ordered, at what cost, and when it is
 * expected. Not a tax document.
 */

import PDFDocument from 'pdfkit';
import { fitLogo, formatAmount } from './pdf.ts';

export interface PurchaseOrderInput {
  business: { name: string; tin: string; address: string; telephone: string; email: string };
  /** The business's logo (PNG or JPEG), top right. */
  logo?: Buffer;
  number: string;
  date: string;
  expectedOn: string | null;
  supplier: { name: string; email: string | null; telephone?: string | null; address?: string | null };
  lines: Array<{ description: string; code: string | null; quantity: string; unit: string; unitCost: string; total: string }>;
  total: string;
  note: string | null;
}

export function renderPurchaseOrder(po: PurchaseOrderInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Purchase order ${po.number}`, Author: po.business.name } });
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
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#160923').text('Purchase order', left, 42);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(brand).text(po.number);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`Date ${po.date}`);
  if (po.expectedOn) doc.text(`Wanted by ${po.expectedOn}`);
  const logo = fitLogo(po.logo, 140, 40);
  if (logo) doc.image(logo.data, left + width - logo.w, 42, { width: logo.w, height: logo.h });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(po.business.name, left, logo ? 42 + logo.h + 6 : 42, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342')
    .text(`TIN ${po.business.tin}`, { width, align: 'right' })
    .text(po.business.address, { width, align: 'right' })
    .text(`${po.business.telephone} · ${po.business.email}`, { width, align: 'right' });

  let y = Math.max(132, doc.y + 12);
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#e6e1ea').lineWidth(1).stroke();
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('SUPPLIER', left, y);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#160923').text(po.supplier.name, left, y + 11, { width: width / 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342');
  for (const line of [po.supplier.address, po.supplier.telephone, po.supplier.email]) if (line) doc.text(line, { width: width / 2 });
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('DELIVER TO', left + width / 2, y, { width: width / 2, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text(po.business.name, left + width / 2, y + 11, { width: width / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(po.business.address, { width: width / 2, align: 'right' });
  y = Math.max(doc.y, y + 50) + 18;

  // ---- lines ----
  const cols = [
    { title: 'Item', w: width - 300, align: 'left' as const },
    { title: 'Code', w: 70, align: 'left' as const },
    { title: 'Quantity', w: 70, align: 'right' as const },
    { title: 'Unit cost', w: 75, align: 'right' as const },
    { title: 'Total', w: 85, align: 'right' as const },
  ];
  const row = (cells: string[], bold = false, color = '#160923') => {
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
    let h = 0;
    cells.forEach((c, i) => {
      doc.text(c, x + 3, y, { width: cols[i]!.w - 6, align: cols[i]!.align });
      h = Math.max(h, doc.y - y);
      x += cols[i]!.w;
    });
    y += Math.max(16, h + 5);
  };
  row(cols.map((c) => c.title.toUpperCase()), true, '#635b68');
  doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#160923').lineWidth(1).stroke();
  for (const l of po.lines) {
    if (y > doc.page.height - 140) {
      doc.addPage();
      y = 42;
    }
    row([l.description, l.code ?? '', `${l.quantity} ${l.unit}`.trim(), formatAmount(l.unitCost), formatAmount(l.total)]);
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#e6e1ea').lineWidth(0.5).stroke();
  }
  y += 6;
  row(['', '', '', 'Total', formatAmount(po.total)], true);
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text('Costs before GST, in Belize dollars (BZD).', left, y, { width, align: 'right' });
  y = doc.y + 16;

  if (po.note) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text('Notes', left, y);
    doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(po.note, left, doc.y + 2, { width });
  }
  doc.font('Helvetica').fontSize(8).fillColor('#635b68').text(`Please quote ${po.number} on your delivery note and invoice. Questions: ${po.business.email} · ${po.business.telephone}`, left, doc.page.height - 60, { width, align: 'center' });
  doc.end();
  return done;
}
