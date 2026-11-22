/**
 * Printed copies (graphical representation, manual 3.4 and 3.5).
 *
 *   renderSheet:   A4 or Letter, any document type. Multiple sheets carry
 *                  "Sheet n of m"; every sheet repeats the fields before the
 *                  items, only the last carries the totals.
 *   renderReceipt: thermal roll, 56 to 80 mm wide (Tax Invoices and Tax
 *                  Receipts only), sized to its content.
 *
 * Rules applied: font sizes of at least 11 pt for parties, items and numbers
 * and 9 pt for everything else; QR code of 22 mm inside a 3 mm quiet zone,
 * error correction M; the table 3-3 messages for test documents and
 * subsequent authorization; BTS's authorization protocol on every
 * previous-authorization document (3.3.4).
 *
 * The built-in PDF fonts cover Latin-1, enough for English and Spanish names.
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { type PrintView, PrintError, qrUrl, REGULATORY_MESSAGES } from './view.ts';

export interface RenderOptions {
  /** BTS's authorization protocol (the ETDUI of its reply). Required for previous-authorization documents unless draft. */
  protocolNumber?: string;
  /** Allow rendering before authorization; prints "DRAFT - NOT AUTHORIZED BY BTS". */
  draft?: boolean;
  /** Text for the "Issuer's message" space (promotions, thanks, return policy). */
  issuerMessage?: string;
  /** Override the QR lookup URL base. */
  qrBaseUrl?: string;
}

export interface SheetOptions extends RenderOptions {
  paper?: 'A4' | 'LETTER';
  /** The manual's standard is landscape (figures 3-3 to 3-5); portrait fits more lines per sheet. Default landscape. */
  orientation?: 'landscape' | 'portrait';
}

export interface ReceiptOptions extends RenderOptions {
  /** Paper width, 56 to 80 mm. Default 80. */
  widthMm?: number;
}

const mm = (v: number) => (v * 72) / 25.4;
const BODY = 11; // parties, items, numbers (minimum per manual 3.4.3)
const SMALL = 9; // everything else (minimum)
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const QR_SIZE = mm(22);
const QR_QUIET = mm(3);

type Doc = PDFKit.PDFDocument;

function checkPrintable(view: PrintView, options: RenderOptions): void {
  if (!view.pendingAuthorization && !options.protocolNumber && !options.draft) {
    throw new PrintError("A previous-authorization document must show BTS's authorization protocol (manual 3.3.4); pass protocolNumber, or draft: true");
  }
}

/** 17206.2 -> "17,206.20"; keeps the sign. */
export function formatAmount(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${(fraction + '00').slice(0, Math.max(2, fraction.length))}`;
}

/** The QR code image for a document: BTS's lookup URL, error correction M, no built-in margin. */
export async function qrCodePng(etdui: string, options: { qrBaseUrl?: string } = {}): Promise<Buffer> {
  return QRCode.toBuffer(qrUrl(etdui, options.qrBaseUrl ? { baseUrl: options.qrBaseUrl } : {}), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 0, // the quiet zone is laid out around the image
    width: 600,
  });
}

const qrPng = (view: PrintView, options: RenderOptions) => qrCodePng(view.etdui, options);

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export function authorizationText(view: PrintView, options: RenderOptions): string {
  if (view.pendingAuthorization) return REGULATORY_MESSAGES.pendingAuthorization;
  return options.protocolNumber ?? 'DRAFT - NOT AUTHORIZED BY BTS';
}

export function regulatoryLines(view: PrintView, options: RenderOptions): string[] {
  const lines = [...view.regulatory];
  if (!view.pendingAuthorization && !options.protocolNumber && options.draft) lines.unshift('DRAFT - NOT AUTHORIZED BY BTS');
  if (view.contingency) lines.push(`Contingency since ${view.contingency.initDate} ${view.contingency.initTime}: ${view.contingency.reason}`);
  if (view.reference) lines.push(`${view.typeName} for ${view.reference.documentType} ${view.reference.etdui}: ${view.reference.reason}`);
  return lines;
}

export function infoLines(view: PrintView): string[] {
  const lines: string[] = [];
  if (view.payment?.dueDate) lines.push(`Payment due ${view.payment.dueDate}`);
  if (view.payment?.terms) lines.push(`Terms: ${view.payment.terms}`);
  if (view.note) lines.push(view.note);
  return lines;
}

// =====================================================================
// Single sheets (A4 / Letter)
// =====================================================================

interface Column {
  title: string;
  width: number;
  align: 'left' | 'right';
  cell: (l: PrintView['lines'][number]) => string[];
}

export async function renderSheet(view: PrintView, options: SheetOptions = {}): Promise<Buffer> {
  checkPrintable(view, options);
  const qr = await qrPng(view, options);
  const layout = options.orientation ?? 'landscape';
  const doc = new PDFDocument({ size: options.paper ?? 'A4', layout, margin: 36, autoFirstPage: false, info: { Title: `${view.typeName} ${view.series}-${view.number}`, Author: view.issuer.name ?? '' } });
  const done = collect(doc);
  doc.addPage();
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // ---- columns (unused ones suppressed, as the manual allows) ----
  const anyCode = view.lines.some((l) => l.code);
  const anyAdj = view.lines.some((l) => l.adjustments.length > 0);
  const fixed: Column[] = [
    { title: '#', width: 22, align: 'left', cell: (l) => [l.number] },
    { title: 'Qty', width: 52, align: 'right', cell: (l) => [l.quantity] },
    { title: 'Unit', width: 34, align: 'left', cell: (l) => [l.unitCode] },
  ];
  const tail: Column[] = [
    ...(anyCode ? [{ title: 'Code', width: 58, align: 'left' as const, cell: (l: PrintView['lines'][number]) => [l.code ?? ''] }] : []),
    { title: 'Unit price', width: 64, align: 'right', cell: (l) => [formatAmount(l.unitPrice)] },
    ...(anyAdj
      ? [{ title: 'Disc./charge', width: 70, align: 'right' as const, cell: (l: PrintView['lines'][number]) => ['', ...l.adjustments.map((a) => `${a.isCharge ? '+' : '-'}${formatAmount(a.amount)}`)] }]
      : []),
    { title: 'Tax', width: 62, align: 'right', cell: (l) => [formatAmount(l.tax)] },
    { title: 'Total', width: 72, align: 'right', cell: (l) => [formatAmount(l.total)] },
  ];
  const descWidth = width - [...fixed, ...tail].reduce((a, c) => a + c.width, 0);
  const columns: Column[] = [...fixed, { title: 'Description', width: descWidth, align: 'left', cell: (l) => [l.description, ...l.adjustments.map((a) => `  ${a.reason}`)] }, ...tail];

  const cellHeight = (text: string, w: number) => doc.font(FONT).fontSize(BODY).heightOfString(text || ' ', { width: w - 6 });
  const rowHeight = (l: PrintView['lines'][number]) =>
    Math.max(...columns.map((c) => c.cell(l).reduce((h, t) => h + cellHeight(t, c.width), 0))) + 6;

  // ---- header, drawn on every sheet: one row of issuer | customer | document | QR ----
  const qrBox = QR_SIZE + 2 * QR_QUIET;
  const gap = 14;
  const blocksW = width - qrBox - gap;
  const docW = Math.min(140, blocksW * 0.22);
  const partyW = (blocksW - docW - 2 * gap) / 2;
  const isStrong = (i: number) => i < view.regulatory.length + (options.draft && !options.protocolNumber && !view.pendingAuthorization ? 1 : 0);

  const drawHeader = (d: Doc, sheet: number, sheets: number): number => {
    let y = top;
    d.font(BOLD).fontSize(16).fillColor('black').text(view.typeName.toUpperCase(), left, y, { width: width * 0.6 });
    if (sheets > 1) d.font(FONT).fontSize(SMALL).text(`Sheet ${sheet} of ${sheets}`, left, y + 4, { width, align: 'right' });
    y += 24;

    const partyBlock = (label: string, p: PrintView['issuer'], x: number): number => {
      d.font(FONT).fontSize(SMALL).text(label, x, y, { width: partyW });
      d.font(BOLD).fontSize(BODY).text(p.name ?? '', { width: partyW });
      d.font(FONT).fontSize(BODY);
      if (p.tin) d.text(`TIN ${p.tin}`, { width: partyW });
      if (p.otherId) d.text(p.otherId, { width: partyW });
      for (const a of p.addressLines) d.text(a, { width: partyW });
      if (p.telephone) d.fontSize(SMALL).text(`Tel. ${p.telephone}`, { width: partyW });
      if (p.email) d.fontSize(SMALL).text(p.email, { width: partyW });
      return d.y;
    };
    const ends = [partyBlock('Issuer', view.issuer, left)];
    if (view.customer) ends.push(partyBlock('Customer', view.customer, left + partyW + gap));

    const dx = left + 2 * (partyW + gap);
    const field = (label: string, value: string, first = false, bold = false) => {
      d.font(FONT).fontSize(SMALL);
      if (first) d.text(label, dx, y, { width: docW });
      else d.text(label, { width: docW });
      d.font(bold ? BOLD : FONT).fontSize(BODY).text(value, { width: docW });
    };
    field('Number', view.number, true, true);
    field('Series', view.series);
    field('Date', `${view.issueDate} ${view.issueTime}`);
    ends.push(d.y);

    d.image(qr, left + width - qrBox + QR_QUIET, y + QR_QUIET, { width: QR_SIZE, height: QR_SIZE });
    ends.push(y + qrBox);
    y = Math.max(...ends) + 4;

    // ETDUI and authorization: side by side when there is room, else stacked.
    const sideBySide = width / 2 >= 300;
    const idW = sideBySide ? width / 2 - 8 : width;
    const idPair = (label: string, value: string, x: number, yy: number, bold = false): number => {
      d.font(FONT).fontSize(SMALL).text(label, x, yy, { width: idW });
      d.font(bold ? BOLD : FONT).fontSize(BODY).text(value, { width: idW });
      return d.y;
    };
    const e1 = idPair('ETDUI', view.etdui, left, y);
    const e2 = sideBySide
      ? idPair('Authorization', authorizationText(view, options), left + width / 2, y, view.pendingAuthorization)
      : idPair('Authorization', authorizationText(view, options), left, e1 + 2, view.pendingAuthorization);
    y = Math.max(e1, e2) + 6;

    // Table header.
    d.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).stroke();
    let x = left;
    for (const c of columns) {
      d.font(BOLD).fontSize(SMALL).text(c.title, x + 3, y + 3, { width: c.width - 6, align: c.align });
      x += c.width;
    }
    y += 16;
    d.moveTo(left, y).lineTo(left + width, y).stroke();
    return y + 2;
  };

  // ---- footer, last sheet only: messages (left) beside totals (right) ----
  const totals: Array<[string, string, boolean]> = [
    ['Total price (excluding taxes)', view.totals.taxExclusive, false],
    ...view.totals.otherTaxes.map((t): [string, string, boolean] => [t.scheme === 'EXC' ? 'Excise duty' : t.scheme === 'ENV' ? 'Environmental tax' : t.scheme, t.amount, false]),
    ['GST', view.totals.gst, false],
    ['Total', view.totals.taxInclusive, true],
    ...(view.totals.prepaid ? [['Prepaid', view.totals.prepaid, false] as [string, string, boolean]] : []),
    ['Amount due', view.totals.payable, true],
  ];
  const regulatory = regulatoryLines(view, options);
  const info = infoLines(view);
  const totalsW = Math.min(300, width * 0.42);
  const messagesW = width - totalsW - gap;
  const boxes: Array<[string, string[], boolean]> = [
    ['Regulatory information', regulatory, true],
    ['Information', info, false],
    ["Issuer's message", options.issuerMessage ? [options.issuerMessage] : [], false],
  ];
  const drawFooter = (d: Doc, yStart: number): number => {
    let ly = yStart + 10;
    for (const [label, lines, strong] of boxes) {
      if (lines.length === 0) continue;
      d.font(FONT).fontSize(SMALL).text(label, left, ly, { width: messagesW });
      ly = d.y + 1;
      lines.forEach((l, i) => {
        d.font(strong && isStrong(i) ? BOLD : FONT).fontSize(BODY).text(l, left, ly, { width: messagesW });
        ly = d.y + 1;
      });
      ly += 6;
    }
    let ry = yStart + 10;
    const tx = left + width - totalsW;
    for (const [label, amount, strong] of totals) {
      d.font(strong ? BOLD : FONT).fontSize(BODY).text(label, tx, ry, { width: totalsW - 100 });
      d.text(formatAmount(amount), tx + totalsW - 100, ry, { width: 100, align: 'right' });
      ry += BODY + 5;
    }
    return Math.max(ly, ry) - yStart;
  };

  // ---- paginate: measure first so "Sheet n of m" is known before drawing ----
  // Measure the header on a scratch document, so nothing is drawn twice.
  const scratch = new PDFDocument({ size: options.paper ?? 'A4', layout, margin: 36 });
  scratch.on('data', () => {});
  const tableTop = drawHeader(scratch, 1, 1);
  const footerH = drawFooter(scratch, tableTop);
  scratch.end();
  const heights = view.lines.map(rowHeight);
  const pages: number[][] = [[]];
  let y = tableTop;
  heights.forEach((h, i) => {
    if (y + h > bottom && pages.at(-1)!.length > 0) {
      pages.push([]);
      y = tableTop;
    }
    pages.at(-1)!.push(i);
    y += h;
  });
  if (y + footerH > bottom) pages.push([]); // totals go on a sheet of their own
  const sheets = pages.length;

  pages.forEach((rows, p) => {
    if (p > 0) doc.addPage();
    let ry = drawHeader(doc, p + 1, sheets);
    for (const i of rows) {
      const line = view.lines[i]!;
      let x = left;
      for (const c of columns) {
        let cy = ry + 3;
        for (const t of c.cell(line)) {
          doc.font(FONT).fontSize(BODY).text(t, x + 3, cy, { width: c.width - 6, align: c.align });
          cy += cellHeight(t, c.width);
        }
        x += c.width;
      }
      ry += heights[i]!;
      doc.moveTo(left, ry).lineTo(left + width, ry).lineWidth(0.25).strokeColor('#999999').stroke().strokeColor('black');
    }
    if (p === sheets - 1) drawFooter(doc, ry);
  });

  doc.end();
  return done;
}

// =====================================================================
// Thermal receipts
// =====================================================================

export async function renderReceipt(view: PrintView, options: ReceiptOptions = {}): Promise<Buffer> {
  checkPrintable(view, options);
  if (view.etdType !== '01' && view.etdType !== '02') {
    throw new PrintError('Thermal rolls are allowed only for Tax Invoices and Tax Receipts (manual 3.4.1)');
  }
  const widthMm = options.widthMm ?? 80;
  if (widthMm < 56 || widthMm > 80) throw new PrintError('Thermal paper width must be 56 to 80 mm (manual 3.4.4)');
  const qr = await qrPng(view, options);
  const pageW = mm(widthMm);
  const margin = mm(3); // at least 2 mm each side
  const w = pageW - 2 * margin;

  // Lay out twice: once to measure the height, once to draw on a page of exactly that height.
  const layout = (doc: Doc, draw: boolean): number => {
    let y = margin;
    const textLine = (t: string, o: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right' } = {}) => {
      doc.font(o.bold ? BOLD : FONT).fontSize(o.size ?? BODY);
      const h = doc.heightOfString(t || ' ', { width: w, align: o.align ?? 'left' });
      if (draw) doc.text(t, margin, y, { width: w, align: o.align ?? 'left' });
      y += h + 1;
    };
    const pair = (label: string, value: string, bold = false) => {
      doc.font(bold ? BOLD : FONT).fontSize(BODY);
      const vw = doc.widthOfString(value) + 2;
      const h = Math.max(doc.heightOfString(label, { width: w - vw - 4 }), BODY);
      if (draw) {
        doc.text(label, margin, y, { width: w - vw - 4 });
        doc.text(value, margin + w - vw, y, { width: vw, align: 'right' });
      }
      y += h + 1;
    };
    const rule = () => {
      y += 3;
      if (draw) doc.moveTo(margin, y).lineTo(margin + w, y).dash(2, { space: 2 }).lineWidth(0.5).stroke().undash();
      y += 4;
    };
    const digits = (s: string) => s.match(/.{1,22}/g)!.join('\n');

    textLine(view.issuer.name ?? '', { bold: true, align: 'center' });
    if (view.issuer.tin) textLine(`TIN ${view.issuer.tin}`, { align: 'center' });
    for (const a of view.issuer.addressLines) textLine(a, { align: 'center' });
    const contact = [view.issuer.telephone, view.issuer.email].filter(Boolean).join('  ');
    if (contact) textLine(contact, { size: SMALL, align: 'center' });
    rule();
    textLine(view.typeName.toUpperCase(), { bold: true, align: 'center' });
    textLine(`No. ${view.number}   Series ${view.series}`, { align: 'center' });
    textLine(`${view.issueDate}  ${view.issueTime}`, { align: 'center' });
    if (view.customer) {
      rule();
      if (view.customer.name) textLine(view.customer.name);
      if (view.customer.tin) textLine(`TIN ${view.customer.tin}`);
      if (view.customer.otherId) textLine(view.customer.otherId);
    }
    rule();
    for (const l of view.lines) {
      textLine(l.description);
      pair(`  ${l.quantity} ${l.unitCode} x ${formatAmount(l.unitPrice)}`, formatAmount(l.net));
      for (const a of l.adjustments) pair(`  ${a.reason}`, `${a.isCharge ? '+' : '-'}${formatAmount(a.amount)}`);
      if (l.tax !== '0.00') pair('  Tax', formatAmount(l.tax));
    }
    rule();
    pair('Price (excl. taxes)', formatAmount(view.totals.taxExclusive));
    for (const t of view.totals.otherTaxes) pair(t.scheme === 'EXC' ? 'Excise duty' : t.scheme === 'ENV' ? 'Environmental tax' : t.scheme, formatAmount(t.amount));
    pair('GST', formatAmount(view.totals.gst));
    pair('TOTAL', formatAmount(view.totals.taxInclusive), true);
    if (view.totals.prepaid) pair('Prepaid', formatAmount(view.totals.prepaid));
    if (view.totals.payable !== view.totals.taxInclusive) pair('Amount due', formatAmount(view.totals.payable), true);
    rule();

    // QR code with its quiet zone, centred.
    y += QR_QUIET;
    if (draw) doc.image(qr, margin + (w - QR_SIZE) / 2, y, { width: QR_SIZE, height: QR_SIZE });
    y += QR_SIZE + QR_QUIET;
    textLine('ETDUI', { size: SMALL, align: 'center' });
    textLine(digits(view.etdui), { align: 'center' });
    textLine('Authorization', { size: SMALL, align: 'center' });
    const auth = authorizationText(view, options);
    textLine(view.pendingAuthorization ? auth : /^\d{44}$/.test(auth) ? digits(auth) : auth, { align: 'center', bold: view.pendingAuthorization });
    const regulatory = regulatoryLines(view, options);
    if (regulatory.length > 0) {
      rule();
      regulatory.forEach((m, i) => textLine(m, { bold: i < view.regulatory.length + (options.draft && !options.protocolNumber && !view.pendingAuthorization ? 1 : 0), align: 'center' }));
    }
    const info = infoLines(view);
    if (info.length > 0) {
      rule();
      for (const m of info) textLine(m, { size: SMALL });
    }
    if (options.issuerMessage) {
      rule();
      textLine(options.issuerMessage, { size: SMALL, align: 'center' });
    }
    return y + margin;
  };

  const measure = new PDFDocument({ size: [pageW, 20_000], margin: 0 });
  measure.on('data', () => {});
  const height = Math.ceil(layout(measure, false));
  measure.end();

  const doc = new PDFDocument({ size: [pageW, height], margin: 0, info: { Title: `${view.typeName} ${view.series}-${view.number}`, Author: view.issuer.name ?? '' } });
  const done = collect(doc);
  layout(doc, true);
  doc.end();
  return done;
}
