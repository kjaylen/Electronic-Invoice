/**
 * What a till prints, and how. A ticket is a list of lines (text, a label
 * and an amount, a rule, a QR code); it renders as ESC/POS bytes for
 * thermal receipt printers (network, Bluetooth) or as an HTML page for
 * installed printers and the browser.
 *
 * The tax receipt follows the printed copy the server's PDF makes (manual
 * 3.4): only what is in the signed document, plus the business's message.
 * The QR code is 22 mm with error correction M (manual 3.5).
 *
 * Pure: no DOM, so the tests run it in Node.
 */

import QRCode from 'qrcode';

export type Align = 'left' | 'center' | 'right';
export type TicketLine =
  | { kind: 'text'; text: string; align?: Align; bold?: boolean; size?: 'normal' | 'large' | 'small' }
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'rule' }
  | { kind: 'qr'; data: string }
  | { kind: 'feed'; lines: number }
  | TicketImage;
export type Ticket = TicketLine[];

/** A picture (the logo): 1-bit rows for ESC/POS (MSB first, 1 = black), and an image for system printers. */
export interface TicketImage { kind: 'image'; width: number; height: number; bits: Uint8Array; src: string }

export interface PrintOptions {
  /** Paper width: 58 mm (32 characters) or 80 mm (48). */
  paperWidth: 58 | 80;
  /** How accented letters are sent: plain ASCII (any printer), or a code page the printer has. */
  codepage: 'ascii' | 'cp850' | 'cp1252';
  /** The printer draws the QR code itself, or it is sent as a picture (older printers). */
  qr: 'native' | 'image';
  cut: boolean;
  /** Kick the cash drawer plugged into the printer. */
  openDrawer?: boolean;
}

// ---------- building tickets ----------

export function formatAmount(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${(fraction + '00').slice(0, Math.max(2, fraction.length))}`;
}

/** What GET /v1/documents/:id/view returns (the parts a receipt needs). */
export interface DocumentView {
  view: {
    typeName: string;
    etdui: string;
    number: string;
    series: string;
    issueDate: string;
    issueTime: string;
    issuer: { name?: string; tin?: string; addressLines: string[]; telephone?: string; email?: string };
    customer?: { name?: string; tin?: string; otherId?: string };
    lines: Array<{ description: string; quantity: string; unitCode: string; unitPrice: string; net: string; tax: string; adjustments: Array<{ reason: string; amount: string; isCharge: boolean }> }>;
    totals: { taxExclusive: string; gst: string; otherTaxes: Array<{ scheme: string; amount: string }>; taxInclusive: string; prepaid?: string; payable: string };
  };
  qr: { url: string };
  printed: { printable: boolean; authorization: string; regulatory: string[]; info: string[] };
  /** The business's logo (its address), printed at the top. */
  logo?: string | null;
}

const digits = (s: string) => s.match(/.{1,22}/g) ?? [s];

/** A tax document (receipt, invoice, credit note) as the receipt printer prints it. */
export function documentTicket(d: DocumentView, options: { message?: string; copy?: boolean; logo?: TicketImage | null } = {}): Ticket {
  const v = d.view;
  const t: Ticket = [];
  if (options.logo) t.push(options.logo, { kind: 'feed', lines: 1 });
  const text = (s: string, o: Omit<Extract<TicketLine, { kind: 'text' }>, 'kind' | 'text'> = {}) => t.push({ kind: 'text', text: s, ...o });
  const pair = (left: string, right: string, bold = false) => t.push({ kind: 'pair', left, right, bold });
  const rule = () => t.push({ kind: 'rule' });

  if (options.copy) text('COPY', { align: 'center', bold: true });
  text(v.issuer.name ?? '', { align: 'center', bold: true, size: 'large' });
  if (v.issuer.tin) text(`TIN ${v.issuer.tin}`, { align: 'center' });
  for (const a of v.issuer.addressLines) text(a, { align: 'center' });
  const contact = [v.issuer.telephone, v.issuer.email].filter(Boolean).join('  ');
  if (contact) text(contact, { align: 'center', size: 'small' });
  rule();
  text(v.typeName.toUpperCase(), { align: 'center', bold: true });
  text(`No. ${v.number}   Series ${v.series}`, { align: 'center' });
  text(`${v.issueDate}  ${v.issueTime}`, { align: 'center' });
  if (v.customer && (v.customer.name || v.customer.tin || v.customer.otherId)) {
    rule();
    if (v.customer.name) text(v.customer.name);
    if (v.customer.tin) text(`TIN ${v.customer.tin}`);
    if (v.customer.otherId) text(v.customer.otherId);
  }
  rule();
  for (const l of v.lines) {
    text(l.description);
    pair(`  ${l.quantity} ${l.unitCode} x ${formatAmount(l.unitPrice)}`, formatAmount(l.net));
    for (const a of l.adjustments) pair(`  ${a.reason}`, `${a.isCharge ? '+' : '-'}${formatAmount(a.amount)}`);
    if (l.tax !== '0.00') pair('  Tax', formatAmount(l.tax));
  }
  rule();
  pair('Price (excl. taxes)', formatAmount(v.totals.taxExclusive));
  for (const x of v.totals.otherTaxes) pair(x.scheme === 'EXC' ? 'Excise duty' : x.scheme === 'ENV' ? 'Environmental tax' : x.scheme, formatAmount(x.amount));
  pair('GST', formatAmount(v.totals.gst));
  pair('TOTAL', formatAmount(v.totals.taxInclusive), true);
  if (v.totals.prepaid) pair('Prepaid', formatAmount(v.totals.prepaid));
  if (v.totals.payable !== v.totals.taxInclusive) pair('Amount due', formatAmount(v.totals.payable), true);
  rule();
  t.push({ kind: 'qr', data: d.qr.url });
  text('ETDUI', { align: 'center', size: 'small' });
  for (const part of digits(v.etdui)) text(part, { align: 'center' });
  text('Authorization', { align: 'center', size: 'small' });
  const auth = d.printed.authorization;
  for (const part of /^\d{44}$/.test(auth) ? digits(auth) : [auth]) text(part, { align: 'center', bold: !/^\d{44}$/.test(auth) });
  if (d.printed.regulatory.length) {
    rule();
    for (const m of d.printed.regulatory) text(m, { align: 'center', bold: true });
  }
  if (d.printed.info.length) {
    rule();
    for (const m of d.printed.info) text(m, { size: 'small' });
  }
  if (options.message?.trim()) {
    rule();
    text(options.message.trim(), { align: 'center', size: 'small' });
  }
  return t;
}

type Means = 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'cheque' | 'other';
const MEANS_NAME: Record<Means, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', wallet: 'Mobile wallet', cheque: 'Cheque', other: 'Other' };

export interface ZReportData {
  business: { name: string; tin: string };
  till: string;
  shift: { number: number; register: { name: string }; openedBy: { name: string }; openedAt: string; closedAt: string | null; closedBy: string | null; status: 'open' | 'closed'; note: string | null };
  report: {
    documents: Array<{ name: string; count: number; total: string }>;
    gst: string;
    takings: Record<Means, string>;
    giftCards?: { sold: { count: number; total: string }; used: string };
    totalTakings: string;
    invoicePayments: Record<Means, string>;
    refunds: Record<Means, string>;
    refundCount: number;
    voided: { count: number; total: string };
    discounts?: { count: number; total: string };
    serviceCharge?: { count: number; total: string };
    tips?: { count: number; total: string };
    cash: { float: string; in: string; payIn: string; payOut: string; expected: string; counted: string | null; difference: string | null };
    movements: Array<{ kind: 'pay_in' | 'pay_out'; amount: string; reason: string; at: string }>;
  };
}

const belize = (iso: string) => new Date(new Date(iso).getTime() - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/** The end-of-day (Z) report, or the running (X) report of an open shift. */
export function zReportTicket(z: ZReportData, now = new Date()): Ticket {
  const t: Ticket = [];
  const text = (s: string, o: Omit<Extract<TicketLine, { kind: 'text' }>, 'kind' | 'text'> = {}) => t.push({ kind: 'text', text: s, ...o });
  const pair = (left: string, right: string, bold = false) => t.push({ kind: 'pair', left, right, bold });
  const rule = () => t.push({ kind: 'rule' });
  const r = z.report;
  const means = Object.keys(MEANS_NAME) as Means[];
  text(z.shift.status === 'closed' ? 'END-OF-DAY REPORT (Z)' : 'SHIFT REPORT (X, STILL OPEN)', { align: 'center', bold: true });
  text(z.business.name, { align: 'center', bold: true });
  text(`TIN ${z.business.tin}`, { align: 'center' });
  pair('Till', z.till);
  pair('Register', z.shift.register.name);
  pair('Shift', z.shift.number ? `#${z.shift.number}` : 'New (not sent yet)');
  pair(`Opened ${belize(z.shift.openedAt)}`, z.shift.openedBy.name);
  if (z.shift.closedAt) pair(`Closed ${belize(z.shift.closedAt)}`, z.shift.closedBy ?? '');
  rule();
  text('SALES', { bold: true });
  if (!r.documents.length) text('No documents');
  for (const d of r.documents) pair(`${d.name} (${d.count})`, formatAmount(d.total));
  pair('GST', formatAmount(r.gst));
  if (r.voided.count) pair(`Cancelled (${r.voided.count})`, formatAmount(r.voided.total));
  if (r.discounts?.count) pair(`Discounts given (${r.discounts.count})`, `-${formatAmount(r.discounts.total)}`);
  if (r.serviceCharge?.count) pair(`Service charge (${r.serviceCharge.count}, before GST)`, formatAmount(r.serviceCharge.total));
  if (r.tips?.count) pair(`Tips for the staff (${r.tips.count})`, formatAmount(r.tips.total));
  rule();
  text('TAKINGS BY PAYMENT', { bold: true });
  for (const m of means) if (r.takings[m] !== '0.00') pair(MEANS_NAME[m], formatAmount(r.takings[m]));
  pair('Total', formatAmount(r.totalTakings), true);
  if (means.some((m) => r.invoicePayments[m] !== '0.00')) {
    text('of which invoice payments:');
    for (const m of means) if (r.invoicePayments[m] !== '0.00') pair(`  ${MEANS_NAME[m]}`, formatAmount(r.invoicePayments[m]));
  }
  if (r.refundCount) {
    text(`after refunds (${r.refundCount}):`);
    for (const m of means) if (r.refunds[m] !== '0.00') pair(`  ${MEANS_NAME[m]}`, `-${formatAmount(r.refunds[m])}`);
  }
  rule();
  text('CASH DRAWER', { bold: true });
  pair('Opening float', formatAmount(r.cash.float));
  if (r.giftCards && r.giftCards.sold.count > 0) pair(`Gift cards sold (${r.giftCards.sold.count})`, formatAmount(r.giftCards.sold.total));
  if (r.giftCards && r.giftCards.used !== '0.00') pair('Paid with gift cards', formatAmount(r.giftCards.used));
  pair('Cash takings', formatAmount(r.cash.in));
  if (r.cash.payIn !== '0.00') pair('Paid in', formatAmount(r.cash.payIn));
  if (r.cash.payOut !== '0.00') pair('Paid out', `-${formatAmount(r.cash.payOut)}`);
  pair('Expected in drawer', formatAmount(r.cash.expected), true);
  if (r.cash.counted !== null) {
    pair('Counted', formatAmount(r.cash.counted), true);
    const d = r.cash.difference ?? '0.00';
    t.push({ kind: 'text', text: d === '0.00' ? 'BALANCED' : `${d.startsWith('-') ? 'SHORT' : 'OVER'} ${formatAmount(d.replace('-', ''))}`, align: 'center', bold: true, size: 'large' });
  }
  if (r.movements.length) {
    rule();
    text('CASH IN AND OUT', { bold: true });
    for (const m of r.movements) pair(`${belize(m.at).slice(11)} ${m.reason}`, `${m.kind === 'pay_out' ? '-' : ''}${formatAmount(m.amount)}`);
  }
  if (z.shift.note) {
    rule();
    text(`Note: ${z.shift.note}`);
  }
  rule();
  text(`Printed ${belize(now.toISOString())}`, { size: 'small' });
  return t;
}

/** A test page: proves the printer, the paper width, accents and the QR code. */
export function testTicket(info: { printer: string; till: string; business: string; options: PrintOptions }): Ticket {
  return [
    { kind: 'text', text: 'TEST PAGE', align: 'center', bold: true, size: 'large' },
    { kind: 'text', text: info.business, align: 'center' },
    { kind: 'rule' },
    { kind: 'pair', left: 'Printer', right: info.printer },
    { kind: 'pair', left: 'Till', right: info.till },
    { kind: 'pair', left: 'Paper', right: `${info.options.paperWidth} mm` },
    { kind: 'pair', left: 'Accents', right: 'á é í ó ú ñ ¿¡' },
    { kind: 'rule' },
    { kind: 'text', text: 'Left' },
    { kind: 'text', text: 'Centre', align: 'center' },
    { kind: 'text', text: 'Right', align: 'right' },
    { kind: 'text', text: 'Bold', bold: true },
    { kind: 'pair', left: 'TOTAL', right: formatAmount('1234.5'), bold: true },
    { kind: 'qr', data: 'https://portal.prod.bz.efdrciat.org/QRCode?UUID=0000000000000000000000000000000000000000000' },
    { kind: 'text', text: 'If the QR code above scans, receipts will too.', align: 'center', size: 'small' },
  ];
}

// ---------- text layout ----------

export const columns = (paperWidth: 58 | 80) => (paperWidth === 58 ? 32 : 48);

/** Word-wrap to a width; long words are cut. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** A label on the left and an amount on the right; the label wraps when they do not fit. */
export function pairLines(left: string, right: string, width: number): string[] {
  if (left.length + 1 + right.length <= width) return [left + ' '.repeat(width - left.length - right.length) + right];
  const lines = wrap(left, width);
  const last = lines[lines.length - 1]!;
  if (last.length + 1 + right.length <= width) lines[lines.length - 1] = last + ' '.repeat(width - last.length - right.length) + right;
  else lines.push(' '.repeat(Math.max(0, width - right.length)) + right);
  return lines;
}

// ---------- ESC/POS ----------

const ESC = 0x1b;
const GS = 0x1d;

/** Spanish letters in code page 850. */
const CP850: Record<string, number> = {
  'á': 0xa0, 'é': 0x82, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ü': 0x81, 'Ü': 0x9a, '¿': 0xa8, '¡': 0xad,
  'Á': 0xb5, 'É': 0x90, 'Í': 0xd6, 'Ó': 0xe0, 'Ú': 0xe9, 'ç': 0x87, 'Ç': 0x80, '°': 0xf8, '€': 0xd5,
};

function encodeText(s: string, codepage: PrintOptions['codepage']): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (codepage === 'cp850' && CP850[ch] !== undefined) out.push(CP850[ch]!);
    else if (codepage === 'cp1252' && code < 0x100) out.push(code);
    else {
      // Plain letters for anything the printer may not have: "á" -> "a", "¿" -> "?".
      const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      const ascii = plain.codePointAt(0)! < 0x80 ? plain : ch === '¿' ? '?' : ch === '¡' ? '!' : '?';
      for (const c of ascii) out.push(c.codePointAt(0)!);
    }
  }
  return out;
}

/** QR module size in printer dots, for a code about 22 mm wide at 203 dpi (8 dots per mm). */
function qrModule(data: string) {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  return { qr, size, dots: Math.max(3, Math.min(8, Math.round(176 / size))) };
}

export function toEscPos(ticket: Ticket, o: PrintOptions): Uint8Array {
  const width = columns(o.paperWidth);
  const b: number[] = [ESC, 0x40]; // initialize
  if (o.codepage !== 'ascii') b.push(ESC, 0x74, o.codepage === 'cp850' ? 2 : 16);
  const align = (a: Align = 'left') => b.push(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0);
  const bold = (on: boolean) => b.push(ESC, 0x45, on ? 1 : 0);
  const line = (s: string) => b.push(...encodeText(s, o.codepage), 0x0a);
  for (const l of ticket) {
    switch (l.kind) {
      case 'text': {
        align(l.align);
        bold(Boolean(l.bold));
        const large = l.size === 'large';
        if (large) b.push(GS, 0x21, 0x01); // double height
        if (l.size === 'small') b.push(ESC, 0x4d, 1); // font B
        for (const part of wrap(l.text, l.size === 'small' ? Math.floor(width * 1.33) : width)) line(part);
        if (large) b.push(GS, 0x21, 0x00);
        if (l.size === 'small') b.push(ESC, 0x4d, 0);
        bold(false);
        break;
      }
      case 'pair':
        align('left');
        bold(Boolean(l.bold));
        for (const part of pairLines(l.left, l.right, width)) line(part);
        bold(false);
        break;
      case 'rule':
        align('left');
        line('-'.repeat(width));
        break;
      case 'feed':
        b.push(ESC, 0x64, Math.max(0, Math.min(10, l.lines)));
        break;
      case 'image': {
        // A raster picture, centred (GS v 0).
        align('center');
        const rowBytes = Math.ceil(l.width / 8);
        b.push(GS, 0x76, 0x30, 0, rowBytes & 0xff, rowBytes >> 8, l.height & 0xff, l.height >> 8);
        for (const byte of l.bits) b.push(byte);
        b.push(0x0a);
        align('left');
        break;
      }
      case 'qr': {
        align('center');
        const { qr, size, dots } = qrModule(l.data);
        b.push(0x0a);
        if (o.qr === 'native') {
          const data = encodeText(l.data, 'ascii');
          const store = data.length + 3;
          b.push(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // model 2
          b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, dots); // module size
          b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
          b.push(GS, 0x28, 0x6b, store & 0xff, store >> 8, 0x31, 0x50, 0x30, ...data); // store
          b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
        } else {
          // A raster picture: each module is dots x dots.
          const px = size * dots;
          const rowBytes = Math.ceil(px / 8);
          b.push(GS, 0x76, 0x30, 0, rowBytes & 0xff, rowBytes >> 8, px & 0xff, px >> 8);
          for (let y = 0; y < px; y++) {
            const row = new Array<number>(rowBytes).fill(0);
            const my = Math.floor(y / dots);
            for (let x = 0; x < px; x++) {
              if (qr.modules.get(my, Math.floor(x / dots))) row[x >> 3]! |= 0x80 >> (x & 7);
            }
            b.push(...row);
          }
        }
        b.push(0x0a);
        align('left');
        break;
      }
    }
  }
  b.push(ESC, 0x64, 4); // feed past the cutter
  if (o.cut) b.push(GS, 0x56, 0x01); // partial cut
  if (o.openDrawer) b.push(...DRAWER_KICK);
  return Uint8Array.from(b);
}

/** Open the cash drawer plugged into the printer (pin 2, then pin 5 for drawers wired the other way). */
export const DRAWER_KICK = [ESC, 0x70, 0x00, 0x19, 0xfa, ESC, 0x70, 0x01, 0x19, 0xfa];
export const drawerKick = () => Uint8Array.from([ESC, 0x40, ...DRAWER_KICK]);

// ---------- HTML (installed printers, the browser) ----------

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The QR code as an SVG, 22 mm wide. */
export function qrSvg(data: string, sizeMm = 22): string {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) path += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges"><path d="${path}" fill="#000"/></svg>`;
}

export function toHtml(ticket: Ticket, o: Pick<PrintOptions, 'paperWidth'>, title = 'Receipt'): string {
  const body = ticket.map((l) => {
    switch (l.kind) {
      case 'text': return `<div class="t ${l.align ?? 'left'}${l.bold ? ' b' : ''}${l.size ? ` ${l.size}` : ''}">${escapeHtml(l.text) || '&nbsp;'}</div>`;
      case 'pair': return `<div class="p${l.bold ? ' b' : ''}"><span>${escapeHtml(l.left)}</span><span>${escapeHtml(l.right)}</span></div>`;
      case 'rule': return '<hr>';
      case 'feed': return `<div style="height:${l.lines * 4}mm"></div>`;
      case 'qr': return `<div class="qr">${qrSvg(l.data)}</div>`;
      case 'image': return `<div class="img"><img src="${escapeHtml(l.src)}" alt=""></div>`;
    }
  }).join('');
  const printable = o.paperWidth === 58 ? 48 : 72;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { size: ${o.paperWidth}mm auto; margin: 0 }
* { box-sizing: border-box }
html, body { margin: 0; background: #fff; color: #000 }
body { width: ${printable}mm; margin: 0 auto; padding: 3mm 0 6mm; font: 9pt/1.3 "Helvetica Neue", Arial, sans-serif }
.t { white-space: pre-wrap; overflow-wrap: anywhere }
.center { text-align: center } .right { text-align: right } .b { font-weight: 700 }
.large { font-size: 12pt } .small { font-size: 7.5pt }
.p { display: flex; justify-content: space-between; gap: 2mm } .p span:last-child { white-space: nowrap; text-align: right }
hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0 }
.qr { display: flex; justify-content: center; padding: 3mm 0 }
.img { display: flex; justify-content: center; padding-bottom: 1mm } .img img { max-width: 100%; max-height: 24mm; filter: grayscale(1) }
</style></head><body>${body}</body></html>`;
}
