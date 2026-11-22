/**
 * The end-of-day (Z) report of a register shift: what was sold, how it was
 * paid, refunds, cash in and out, and the drawer count against what should
 * be in it. On the receipt printer (80 mm) or an A4 sheet.
 */

import PDFDocument from 'pdfkit';
import { formatAmount } from './pdf.ts';

type Means = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';
const MEANS_NAME: Record<Means, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };

export interface ZReportInput {
  business: { name: string; tin: string };
  shift: {
    number: number; register: { name: string }; openedBy: { name: string }; openedAt: string; closedAt: string | null; closedBy: string | null;
    status: 'open' | 'closed'; note: string | null;
  };
  report: {
    documents: Array<{ name: string; count: number; total: string; gst: string }>;
    gst: string;
    takings: Record<Means, string>;
    totalTakings: string;
    sales: Record<Means, string>;
    invoicePayments: Record<Means, string>;
    refunds: Record<Means, string>;
    refundCount: number;
    voided: { count: number; total: string };
    cash: { float: string; in: string; payIn: string; payOut: string; expected: string; counted: string | null; difference: string | null };
    movements: Array<{ kind: 'pay_in' | 'pay_out'; amount: string; reason: string; at: string; by: string | null }>;
  };
  format: 'receipt' | 'sheet';
}

const belizeTime = (iso: string) => new Date(new Date(iso).getTime() - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

export function renderZReport(z: ZReportInput): Promise<Buffer> {
  const receipt = z.format === 'receipt';
  const width = receipt ? 226 : 595;
  const margin = receipt ? 10 : 48;
  const rows: Array<{ kind: 'title' | 'line' | 'rule' | 'gap' | 'big'; left?: string; right?: string; bold?: boolean }> = [];
  const title = (t: string) => rows.push({ kind: 'title', left: t });
  const line = (left: string, right = '', bold = false) => rows.push({ kind: 'line', left, right, bold });
  const rule = () => rows.push({ kind: 'rule' });
  const gap = () => rows.push({ kind: 'gap' });
  const r = z.report;
  const means = (Object.keys(MEANS_NAME) as Means[]);

  line(z.shift.status === 'closed' ? 'END-OF-DAY REPORT (Z)' : 'SHIFT REPORT (X, STILL OPEN)', '', true);
  line(z.business.name, '', true);
  line(`TIN ${z.business.tin}`);
  line(`Register: ${z.shift.register.name}`);
  line(`Shift #${z.shift.number}`, '');
  line(`Opened ${belizeTime(z.shift.openedAt)}`, z.shift.openedBy.name);
  if (z.shift.closedAt) line(`Closed ${belizeTime(z.shift.closedAt)}`, z.shift.closedBy ?? '');
  rule();
  title('Sales');
  if (!r.documents.length) line('No documents');
  for (const d of r.documents) line(`${d.name} (${d.count})`, formatAmount(d.total));
  line('GST', formatAmount(r.gst));
  if (r.voided.count) line(`Cancelled (${r.voided.count})`, formatAmount(r.voided.total));
  rule();
  title('Takings by payment');
  for (const m of means) if (r.takings[m] !== '0.00') line(MEANS_NAME[m], formatAmount(r.takings[m]));
  line('Total', formatAmount(r.totalTakings), true);
  if (means.some((m) => r.invoicePayments[m] !== '0.00')) {
    gap();
    line('of which invoice payments:');
    for (const m of means) if (r.invoicePayments[m] !== '0.00') line(`  ${MEANS_NAME[m]}`, formatAmount(r.invoicePayments[m]));
  }
  if (r.refundCount) {
    gap();
    line(`after refunds (${r.refundCount}):`);
    for (const m of means) if (r.refunds[m] !== '0.00') line(`  ${MEANS_NAME[m]}`, `-${formatAmount(r.refunds[m])}`);
  }
  rule();
  title('Cash drawer');
  line('Opening float', formatAmount(r.cash.float));
  line('Cash takings', formatAmount(r.cash.in));
  if (r.cash.payIn !== '0.00') line('Paid in', formatAmount(r.cash.payIn));
  if (r.cash.payOut !== '0.00') line('Paid out', `-${formatAmount(r.cash.payOut)}`);
  line('Expected in drawer', formatAmount(r.cash.expected), true);
  if (r.cash.counted !== null) {
    line('Counted', formatAmount(r.cash.counted), true);
    const d = r.cash.difference ?? '0.00';
    rows.push({ kind: 'big', left: d === '0.00' ? 'Balanced' : d.startsWith('-') ? 'Short' : 'Over', right: d === '0.00' ? '0.00' : formatAmount(d.replace('-', '')) });
  }
  if (r.movements.length) {
    rule();
    title('Cash in and out');
    for (const m of r.movements) line(`${belizeTime(m.at).slice(11)} ${m.reason}`, `${m.kind === 'pay_out' ? '-' : ''}${formatAmount(m.amount)}`);
  }
  if (z.shift.note) {
    rule();
    line(`Note: ${z.shift.note}`);
  }
  rule();
  line(`Printed ${belizeTime(new Date().toISOString())}`);

  const fs = receipt ? 8 : 10;
  const lh = fs + (receipt ? 4 : 6);
  const height = receipt ? Math.max(200, margin * 2 + rows.length * 3 + rows.reduce((a, x) => a + (x.kind === 'rule' ? 8 : x.kind === 'gap' ? 4 : x.kind === 'big' ? lh * 1.8 : x.kind === 'title' ? lh + 2 : lh * (receipt && (x.left?.length ?? 0) > 34 ? 2 : 1)), 0) + 20) : 842;
  const doc = new PDFDocument({ size: [width, height], margin, info: { Title: `Shift ${z.shift.number} report`, Author: z.business.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const inner = width - margin * 2;
  let y = margin;
  for (const x of rows) {
    if (!receipt && y > height - margin - 30) {
      doc.addPage();
      y = margin;
    }
    if (x.kind === 'rule') {
      doc.moveTo(margin, y + 3).lineTo(margin + inner, y + 3).dash(2, { space: 2 }).strokeColor('#000').lineWidth(0.5).stroke().undash();
      y += 8;
    } else if (x.kind === 'gap') {
      y += 4;
    } else if (x.kind === 'title') {
      doc.font('Helvetica-Bold').fontSize(fs + 1).fillColor('#000').text(x.left!.toUpperCase(), margin, y, { width: inner });
      y += lh + 2;
    } else if (x.kind === 'big') {
      doc.font('Helvetica-Bold').fontSize(fs + 4).fillColor('#000').text(x.left!, margin, y, { width: inner / 2 }).text(x.right!, margin + inner / 2, y, { width: inner / 2, align: 'right' });
      y += lh * 1.8;
    } else {
      doc.font(x.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor('#000');
      const rightW = x.right ? Math.min(inner * 0.42, doc.widthOfString(x.right) + 4) : 0;
      doc.text(x.left ?? '', margin, y, { width: inner - rightW - 4 });
      const used = doc.y - y;
      if (x.right) doc.text(x.right, margin + inner - rightW, y, { width: rightW, align: 'right' });
      y += Math.max(lh, used + 2);
    }
  }
  doc.end();
  return done;
}
