/**
 * A price list (A4 portrait): the business's items by category, with their prices (retail or
 * wholesale, with or without GST) and quantity prices. For wholesale customers and the counter.
 */

import PDFDocument from 'pdfkit';
import { fitLogo, formatAmount } from './pdf.ts';

export interface PriceListInput {
  business: { name: string; tin: string; address: string; telephone: string; email: string };
  logo?: Buffer;
  title: string;
  date: string;
  /** "Prices include GST" or "Prices before GST". */
  basis: string;
  groups: Array<{ name: string; items: Array<{ name: string; code: string | null; unit: string; price: string; deals: string[] }> }>;
  note?: string | null;
}

export function renderPriceList(p: PriceListInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: p.title, Author: p.business.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - 70;
  const brand = '#4a1b66';

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#160923').text(p.title, left, 42);
  doc.font('Helvetica').fontSize(10).fillColor('#635b68').text(`${p.date} · ${p.basis} · BZD`);
  const logo = fitLogo(p.logo, 140, 40);
  if (logo) doc.image(logo.data, left + width - logo.w, 42, { width: logo.w, height: logo.h });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#160923').text(p.business.name, left, logo ? 42 + logo.h + 6 : 42, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#3b3342')
    .text(p.business.address, { width, align: 'right' })
    .text(`${p.business.telephone} · ${p.business.email}`, { width, align: 'right' });

  let y = Math.max(118, doc.y + 14);
  const cols = { name: width - 230, code: 70, unit: 60, price: 100 };
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#635b68');
    doc.text('ITEM', left, y, { width: cols.name }).text('CODE', left + cols.name, y, { width: cols.code })
      .text('UNIT', left + cols.name + cols.code, y, { width: cols.unit }).text('PRICE', left + width - cols.price, y, { width: cols.price, align: 'right' });
    y += 13;
    doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor('#160923').lineWidth(0.8).stroke();
  };
  const room = (h: number, continuing?: string) => {
    if (y + h > bottom) {
      doc.addPage();
      y = 42;
      header();
      // A category carried over to the new page says so.
      if (continuing) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(brand).text(`${continuing} (continued)`, left, y + 2, { width });
        y = doc.y + 3;
      }
    }
  };
  header();
  for (const g of p.groups) {
    room(40);
    y += 6;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text(g.name, left, y, { width });
    y = doc.y + 4;
    for (const it of g.items) {
      const nameH = doc.font('Helvetica').fontSize(9.5).heightOfString(it.name, { width: cols.name - 6 });
      const dealsH = it.deals.length ? it.deals.length * 11 : 0;
      room(Math.max(14, nameH) + dealsH + 6, g.name);
      doc.font('Helvetica').fontSize(9.5).fillColor('#160923').text(it.name, left, y, { width: cols.name - 6 });
      doc.fontSize(8.5).fillColor('#635b68').text(it.code ?? '', left + cols.name, y + 1, { width: cols.code - 4, lineBreak: false })
        .text(it.unit, left + cols.name + cols.code, y + 1, { width: cols.unit - 4, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#160923').text(formatAmount(it.price), left + width - cols.price, y, { width: cols.price, align: 'right' });
      y += Math.max(14, nameH) + 1;
      for (const d of it.deals) {
        doc.font('Helvetica').fontSize(8.5).fillColor(brand).text(d, left + width - 200, y, { width: 200, align: 'right' });
        y += 11;
      }
      doc.moveTo(left, y + 1).lineTo(left + width, y + 1).strokeColor('#eee9f2').lineWidth(0.5).stroke();
      y += 5;
    }
  }
  if (p.note) {
    room(40);
    y += 10;
    doc.font('Helvetica').fontSize(9).fillColor('#3b3342').text(p.note, left, y, { width });
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.font('Helvetica').fontSize(8).fillColor('#635b68').text(`${p.business.name} · prices may change without notice · page ${i + 1} of ${pages.count}`, left, doc.page.height - 58, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
