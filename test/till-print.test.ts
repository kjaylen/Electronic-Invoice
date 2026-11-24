/**
 * What tills print: a real issued receipt, read back from the server's
 * document view, laid out as a ticket and encoded for ESC/POS printers
 * (native QR or as a picture, accents per code page, cut, drawer) and as HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { columns, type DocumentView, documentTicket, DRAWER_KICK, pairLines, testTicket, toEscPos, toHtml, wrap, zReportTicket } from '../web/src/pos/ticket.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

const includes = (hay: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

async function issuedReceiptView(): Promise<DocumentView> {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const cookie = /(etd_s_[a-z0-9-]+=[^;]+)/.exec(String(login.headers['set-cookie']))![1]!;
    const headers = { ...CSRF, cookie, 'x-business': slug };
    const doc = await app.inject({
      method: 'POST', url: '/v1/documents', headers,
      payload: { type: '02', lines: [{ description: 'Café con leche grande', quantity: '2', unitCode: 'H87', unitPrice: '6.50', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Paid' } },
    });
    assert.equal(doc.statusCode, 201, doc.body);
    const view = await app.inject({ method: 'GET', url: `/v1/documents/${doc.json().id}/view`, headers });
    return view.json();
  } finally {
    await app.close();
    await f.close();
  }
}

test('text layout: wrapping and label/amount pairs fit the paper', () => {
  assert.equal(columns(58), 32);
  assert.equal(columns(80), 48);
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('abcdefghijkl', 5), ['abcde', 'fghij', 'kl']);
  assert.deepEqual(pairLines('GST', '1.63', 12), ['GST     1.63']);
  assert.deepEqual(pairLines('A long label here', '100.00', 16), ['A long label', 'here      100.00']);
});

test('a real receipt prints with its QR code, ETDUI and authorization, on ESC/POS and HTML', async () => {
  const d = await issuedReceiptView();
  const ticket = documentTicket(d, { message: 'Gracias por su compra' });
  const texts = ticket.flatMap((l) => (l.kind === 'text' ? [l.text] : l.kind === 'pair' ? [`${l.left}|${l.right}`] : []));
  assert.ok(texts.includes('TAX RECEIPT'));
  assert.ok(texts.includes('TOTAL|14.63'), texts.join('\n'));
  assert.ok(texts.includes('GST|1.63'));
  assert.ok(texts.includes('Gracias por su compra'));
  assert.equal(texts.filter((x) => /^\d{22}$/.test(x)).length >= 2, true, 'the ETDUI in two lines of 22 digits');
  const qr = ticket.find((l) => l.kind === 'qr');
  assert.ok(qr && qr.kind === 'qr' && qr.data === d.qr.url);

  const native = toEscPos(ticket, { paperWidth: 80, codepage: 'cp850', qr: 'native', cut: true, openDrawer: true });
  assert.deepEqual([...native.subarray(0, 2)], [0x1b, 0x40], 'starts by resetting the printer');
  assert.ok(includes(native, [0x1b, 0x74, 2]), 'selects code page 850');
  assert.ok(includes(native, [...ascii('Caf'), 0x82]), 'é in code page 850');
  assert.ok(includes(native, [0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31]), 'QR error correction M');
  assert.ok(includes(native, ascii(d.qr.url)), 'the QR holds the BTS lookup URL');
  assert.ok(includes(native, [0x1d, 0x56, 0x01]), 'cuts');
  assert.ok(includes(native, DRAWER_KICK), 'kicks the drawer');

  const plain = toEscPos(ticket, { paperWidth: 58, codepage: 'ascii', qr: 'image', cut: false });
  assert.ok(includes(plain, ascii('Cafe con leche')), 'plain letters without a code page');
  assert.ok(!includes(plain, [0x1b, 0x74]), 'no code page selected');
  assert.ok(includes(plain, [0x1d, 0x76, 0x30, 0]), 'the QR as a raster picture');
  assert.ok(!includes(plain, [0x1d, 0x56, 0x01]) && !includes(plain, DRAWER_KICK));
  const lines = new TextDecoder('latin1').decode(plain).split('\n').filter((l) => /^[ -~]+$/.test(l));
  assert.ok(lines.every((l) => l.replace(/^\x1b.*?(?=[ -~])/, '').length <= 32 + 8), 'nothing wider than the paper');

  const html = toHtml(ticket, { paperWidth: 80 }, 'Receipt');
  assert.match(html, /<svg[^>]+width="22mm"/);
  assert.match(html, /14\.63/);
  assert.match(html, /@page \{ size: 80mm auto/);
});

test('the Z report and the test page', () => {
  const z = zReportTicket({
    business: { name: 'Cayo Coffee', tin: '123456' },
    till: 'Front till',
    shift: { number: 4, register: { name: 'Front till' }, openedBy: { name: 'Cash' }, openedAt: '2026-11-22T14:00:00Z', closedAt: '2026-11-22T23:00:00Z', closedBy: 'Manny', status: 'closed', note: null },
    report: {
      documents: [{ name: 'Tax receipts', count: 3, total: '67.50' }], gst: '7.50',
      takings: { cash: '45.00', card: '22.50', bank_transfer: '0.00', wallet: '0.00', cheque: '0.00', other: '0.00' }, totalTakings: '67.50',
      invoicePayments: { cash: '0.00', card: '0.00', bank_transfer: '0.00', wallet: '0.00', cheque: '0.00', other: '0.00' },
      refunds: { cash: '0.00', card: '0.00', bank_transfer: '0.00', wallet: '0.00', cheque: '0.00', other: '0.00' }, refundCount: 0,
      voided: { count: 0, total: '0.00' },
      cash: { float: '50.00', in: '45.00', payIn: '0.00', payOut: '5.00', expected: '90.00', counted: '89.00', difference: '-1.00' },
      movements: [{ kind: 'pay_out', amount: '5.00', reason: 'Ice', at: '2026-11-22T16:00:00Z' }],
    },
  }, new Date('2026-11-22T23:05:00Z'));
  const texts = z.flatMap((l) => (l.kind === 'text' ? [l.text] : l.kind === 'pair' ? [`${l.left}|${l.right}`] : []));
  assert.equal(texts[0], 'END-OF-DAY REPORT (Z)');
  assert.ok(texts.includes('Expected in drawer|90.00'));
  assert.ok(texts.includes('SHORT 1.00'));
  assert.ok(texts.includes('10:00 Ice|-5.00'), 'Belize time');
  const page = toEscPos(testTicket({ printer: 'Bar', till: 'Front till', business: 'Cayo Coffee', options: { paperWidth: 80, codepage: 'cp1252', qr: 'native', cut: true } }), { paperWidth: 80, codepage: 'cp1252', qr: 'native', cut: true });
  assert.ok(includes(page, [0x1b, 0x74, 16]) && includes(page, [0xf1]), 'ñ in Windows-1252');
});
