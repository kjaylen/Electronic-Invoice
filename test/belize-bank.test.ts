/**
 * Belize Bank: card payments on the bank's page, E-Kyash wallet payments,
 * and bill payments from online banking applied to invoices. The bank's APIs
 * are stand-ins that follow its integration guides.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { ekyashJwt, verifyEKyashCallback } from '../src/commerce/ekyash.ts';
import { parseInvoiceNumber } from '../src/receivables/billpay.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const EKYASH_URL = 'https://ekyash.bank.test/api';
const EKYASH = { sid: '1092037465', pinHash: 'a'.repeat(64), apiKey: 'APPKEY17-02A8-4BAF', apiPassword: '82069ffbb5fc0627b91829f1215fcc44' };

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/** Stand-ins for the card gateway and E-Kyash. */
function fakeBank() {
  const cardOrders = new Map<string, { amount: number; status: number; orderNumber: string }>();
  const wallet = new Map<string, { amount: number; statusPay: number; orderId: string }>();
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? '');
    calls.push({ url: url.toString(), body, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.host === 'sandbox.belizebank.com') {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (f.password !== 'bank-pass-123') return json({ errorCode: 5, errorMessage: 'Access denied' });
      if (url.pathname.endsWith('/register.do')) {
        if (f.currency !== '084') return json({ errorCode: 4, errorMessage: 'Wrong currency' });
        const id = `bb-${++n}-0000-0000`;
        cardOrders.set(id, { amount: Number(f.amount), status: 0, orderNumber: f.orderNumber! });
        return json({ orderId: id, formURL: `https://sandbox.belizebank.com/payment/merchants/payment.html?mdOrder=${id}` });
      }
      if (url.pathname.endsWith('/getOrderStatusExtended.do')) {
        const o = cardOrders.get(f.orderId!);
        if (!o) return json({ errorCode: 6, errorMessage: 'Order not found' });
        return json({ errorCode: '0', errorMessage: 'Success', orderStatus: o.status, amount: o.amount, cardAuthInfo: { maskedPan: '555555**5599', approvalCode: '123456' } });
      }
    }
    if (url.toString().startsWith(EKYASH_URL)) {
      const b = JSON.parse(body) as Record<string, unknown>;
      // Every request is signed: an HS256 JWT over the body with the merchant's API key.
      if ((init?.headers as Record<string, string>).authorization !== `Bearer ${ekyashJwt(b, EKYASH.apiKey)}`) return json({ message: 'bad token' }, 401);
      const path = url.pathname.replace('/api/', '');
      if (path === 'authorization') return b.sid === EKYASH.sid && b.pinHash === EKYASH.pinHash ? json({ session: 's'.repeat(32), firstName: 'Test' }) : json({ message: 'PERSONNEL_NOT_FOUND' }, 400);
      if (b.session !== 's'.repeat(32)) return json({ message: 'no session' }, 403);
      if (path === 'create-new-invoice') {
        const id = String(368050143800 + ++n);
        wallet.set(id, { amount: Number(b.amount), statusPay: 0, orderId: String(b.orderId) });
        return json({ invoiceId: id, qrUrl: `https://ekyash.example/qr/${id}`, qrData: id, receiptUrl: null, paymentLink: 'https://ekyash.page.link/Z1eB' });
      }
      if (path === 'get-invoice-info') {
        const w = wallet.get(String(b.invoiceId));
        if (!w || w.orderId !== b.orderId) return json({ list: [] });
        return json({ list: [{ invoiceId: b.invoiceId, orderId: w.orderId, amount: w.amount, statusPay: w.statusPay, transactions: w.statusPay === 3 ? [{ transactionId: '843103001715', statusPay: 3 }] : [] }] });
      }
    }
    return json({ message: 'not found' }, 404);
  }) as typeof fetch;
  return { fetcher, calls, cardOrders, wallet };
}

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  bank: ReturnType<typeof fakeBank>;
  slug: string;
  owner: Record<string, string>;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '03', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const bank = fakeBank();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: memoryMailer(), paymentsFetch: bank.fetcher, ekyash: { sandboxUrl: EKYASH_URL } });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  try {
    await fn({ f, app, bank, slug, owner: { ...CSRF, cookie: cookieFrom(login), 'x-business': slug } });
  } finally {
    await app.close();
    await f.close();
  }
}

async function invoice(c: Ctx, price = '100.00') {
  const res = await c.app.inject({
    method: 'POST', url: '/v1/documents', headers: c.owner,
    payload: {
      type: '01',
      customer: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' }, contact: { email: 'accounts@island.example' } },
      lines: [{ description: 'Consulting', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' }],
      payment: { meansCode: '30', dueDate: '2026-12-31' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const doc = res.json() as { id: string };
  const share = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/share`, headers: c.owner });
  return { id: doc.id, token: /\/d\/([A-Za-z0-9_-]{43})/.exec(share.json().url)![1]! };
}

const paymentsOf = async (c: Ctx, id: string) => (await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/payments`, headers: c.owner })).json() as { invoice: { balance: string; status: string }; payments: Array<{ method: string; amount: string; reference: string }> };

test('invoice numbers as customers type them', () => {
  assert.deepEqual(parseInvoiceNumber('001-000000012'), { series: 1, serial: 12 });
  assert.deepEqual(parseInvoiceNumber('INV 12'), { series: null, serial: 12 });
  assert.deepEqual(parseInvoiceNumber('#000000012'), { series: null, serial: 12 });
  assert.deepEqual(parseInvoiceNumber('2/45'), { series: 2, serial: 45 });
  assert.equal(parseInvoiceNumber('abc'), null);
  assert.equal(parseInvoiceNumber('0'), null);
});

test('E-Kyash callback signatures', () => {
  const data = { orderId: '1234567890', invoiceId: '1234567890', statusPay: 3 };
  const hash = createHmac('sha256', EKYASH.apiPassword).update(JSON.stringify(data)).digest('hex');
  assert.equal(verifyEKyashCallback({ ...data, hash }, EKYASH.apiPassword), true);
  assert.equal(verifyEKyashCallback({ ...data, statusPay: 2, hash }, EKYASH.apiPassword), false, 'a changed message fails');
  assert.equal(verifyEKyashCallback({ ...data, hash }, 'another-password'), false);
  assert.equal(verifyEKyashCallback(data, EKYASH.apiPassword), false, 'no hash');
});

test('Belize Bank cards: connect (login checked), pay an invoice in BZ$ on the bank page, the callback settles it once', () =>
  withBusiness(async (c) => {
    const connect = (password: string) => c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/belizebank', headers: c.owner, payload: { userName: 'merchant01', password, mode: 'sandbox' } });
    const bad = await connect('wrong-pass');
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().error.message, /refused this user name or password/);
    assert.equal((await connect('bank-pass-123')).statusCode, 200);
    const accounts = (await c.app.inject({ method: 'GET', url: '/v1/payment-accounts', headers: c.owner })).json();
    assert.deepEqual(accounts.belizebank, { connected: true, userName: 'merchant01', mode: 'sandbox' });
    const stored = (await c.f.db.query<{ credentials_encrypted: string }>("select credentials_encrypted from payment_accounts where provider = 'belizebank'")).rows[0]!;
    assert.ok(!stored.credentials_encrypted.includes('bank-pass-123'), 'the password is encrypted');

    const inv = await invoice(c);
    const page = (await c.app.inject({ method: 'GET', url: `/v1/pay/${inv.token}` })).json();
    assert.deepEqual(page.online.providers, ['belizebank'], 'connected providers replace test payments');
    const start = await c.app.inject({ method: 'POST', url: `/v1/pay/${inv.token}/start`, payload: { provider: 'belizebank' } });
    assert.equal(start.statusCode, 200, start.body);
    assert.match(start.json().redirectUrl, /^https:\/\/sandbox\.belizebank\.com\/payment\/merchants\/payment\.html\?mdOrder=/);
    const register = Object.fromEntries(new URLSearchParams(c.bank.calls.find((x) => x.url.endsWith('/register.do'))!.body));
    assert.deepEqual([register.amount, register.currency, register.dynamicCallbackUrl], ['11250', '084', 'https://app.example.test/v1/payment-callbacks/belizebank'], 'BZ$112.50 in cents, in Belize dollars');
    assert.equal(register.returnURL, `https://app.example.test/pay/${inv.token}?payment=${start.json().paymentId}`);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/pay/${inv.token}/start`, payload: { provider: 'paypal' } })).statusCode, 409, 'only connected providers');

    const [orderId, order] = [...c.bank.cardOrders.entries()][0]!;
    const pending = await c.app.inject({ method: 'POST', url: `/v1/pay/${inv.token}/payments/${start.json().paymentId}/confirm` });
    assert.equal(pending.json().status, 'pending');

    // The customer pays on the bank's page; the bank calls back (unsigned, so we ask the bank).
    order.status = 2;
    const forged = await c.app.inject({ method: 'POST', url: '/v1/payment-callbacks/belizebank', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'mdOrder=not-a-real-order-0000&operation=deposited&status=1' });
    assert.equal(forged.statusCode, 200);
    const cb = await c.app.inject({ method: 'POST', url: '/v1/payment-callbacks/belizebank', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `mdOrder=${orderId}&orderNumber=${order.orderNumber}&operation=deposited&status=1` });
    assert.equal(cb.statusCode, 200, cb.body);
    await c.app.inject({ method: 'POST', url: '/v1/payment-callbacks/belizebank', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `mdOrder=${orderId}&operation=deposited&status=1` });
    const after = await paymentsOf(c, inv.id);
    assert.equal(after.invoice.status, 'paid');
    assert.equal(after.payments.length, 1, 'recorded once');
    assert.deepEqual([after.payments[0]!.method, after.payments[0]!.amount, after.payments[0]!.reference], ['online', '112.50', 'Belize Bank card 123456']);

    // A different amount than asked for is never accepted.
    const inv2 = await invoice(c);
    const s2 = await c.app.inject({ method: 'POST', url: `/v1/pay/${inv2.token}/start`, payload: {} });
    const o2 = [...c.bank.cardOrders.values()].at(-1)!;
    o2.status = 2;
    o2.amount = 100;
    const wrong = (await c.app.inject({ method: 'POST', url: `/v1/pay/${inv2.token}/payments/${s2.json().paymentId}/confirm` })).json();
    assert.equal(wrong.status, 'failed');
    assert.match(wrong.problem, /not BZ\$112\.50/);
    assert.equal((await paymentsOf(c, inv2.id)).payments.length, 0);

    // The store can take card payments through the bank too.
    const store = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, pickup: { enabled: true, instructions: '' }, payments: { online: { enabled: true, provider: 'belizebank' } } } });
    assert.equal(store.statusCode, 200, store.body);
    await c.app.inject({ method: 'DELETE', url: '/v1/payment-accounts/belizebank', headers: c.owner });
    const settings = (await c.app.inject({ method: 'GET', url: '/v1/store-settings', headers: c.owner })).json();
    assert.equal(settings.payments.online.enabled, false, 'disconnecting turns online payments off');
  }));

test('E-Kyash: connect (checked), pay an invoice by QR code or deep link, a signed callback settles it', () =>
  withBusiness(async (c) => {
    const bad = await c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/ekyash', headers: c.owner, payload: { ...EKYASH, pinHash: 'b'.repeat(64), mode: 'sandbox' } });
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/ekyash', headers: c.owner, payload: { ...EKYASH, mode: 'live' } })).statusCode, 422, 'no live address on this server');
    const ok = await c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/ekyash', headers: c.owner, payload: { ...EKYASH, mode: 'sandbox' } });
    assert.equal(ok.statusCode, 200, ok.body);
    // Changing the mode only keeps the stored secrets.
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/ekyash', headers: c.owner, payload: { sid: EKYASH.sid, mode: 'sandbox' } })).statusCode, 200);
    const accounts = (await c.app.inject({ method: 'GET', url: '/v1/payment-accounts', headers: c.owner })).json();
    assert.equal(accounts.ekyash.callbackUrl, `https://app.example.test/v1/payment-callbacks/ekyash/${c.slug}`);

    const inv = await invoice(c, '40.00');
    const page = (await c.app.inject({ method: 'GET', url: `/v1/pay/${inv.token}` })).json();
    assert.deepEqual(page.online.providers, ['ekyash']);
    const start = await c.app.inject({ method: 'POST', url: `/v1/pay/${inv.token}/start`, payload: { provider: 'ekyash' } });
    assert.equal(start.statusCode, 200, start.body);
    const paymentId = start.json().paymentId;
    assert.equal(start.json().redirectUrl, `https://app.example.test/pay/${inv.token}?payment=${paymentId}`, 'the customer stays on our page');
    const [invoiceId, w] = [...c.bank.wallet.entries()][0]!;
    assert.equal(w.amount, 4500);
    assert.ok(w.orderId.length <= 20);

    const pending = (await c.app.inject({ method: 'POST', url: `/v1/pay/${inv.token}/payments/${paymentId}/confirm` })).json();
    assert.equal(pending.status, 'pending');
    assert.match(pending.wallet.qr, /^data:image\/png;base64,/);
    assert.equal(pending.wallet.deepLink, 'https://ekyash.page.link/Z1eB');

    // The customer accepts in the app; E-Kyash calls back, signed.
    w.statusPay = 3;
    const message = { orderId: w.orderId, invoiceId, transactionId: '843103001715', statusPay: 3 };
    const unsigned = await c.app.inject({ method: 'POST', url: `/v1/payment-callbacks/ekyash/${c.slug}`, payload: { ...message, hash: 'f'.repeat(64) } });
    assert.equal(unsigned.statusCode, 401);
    assert.equal((await paymentsOf(c, inv.id)).payments.length, 0, 'a bad signature changes nothing');
    const hash = createHmac('sha256', EKYASH.apiPassword).update(JSON.stringify(message)).digest('hex');
    const signed = await c.app.inject({ method: 'POST', url: `/v1/payment-callbacks/ekyash/${c.slug}`, payload: { ...message, hash } });
    assert.equal(signed.statusCode, 200, signed.body);
    const after = await paymentsOf(c, inv.id);
    assert.equal(after.invoice.status, 'paid');
    assert.deepEqual([after.payments[0]!.amount, after.payments[0]!.reference], ['45.00', 'E-Kyash 843103001715']);
  }));

test('bill payments from online banking: the bank checks the number, posts, reconciles; each payment once', () =>
  withBusiness(async (c) => {
    const on = await c.app.inject({ method: 'POST', url: '/v1/bill-payments', headers: c.owner, payload: { referenceField: 'invoiceNumber' } });
    assert.equal(on.statusCode, 200, on.body);
    const token = on.json().token as string;
    assert.equal(on.json().urls.validate, `https://app.example.test/v1/billpay/${c.slug}/validate`);
    assert.equal((await c.f.db.query<{ n: number }>('select count(*)::int as n from bill_payment_accounts where token_hash = $1', [token])).rows[0]!.n, 0, 'only a hash is kept');
    const bank = (path: string, payload: unknown, t = token) => c.app.inject({ method: 'POST', url: `/v1/billpay/${c.slug}/${path}`, headers: { authorization: `Bearer ${t}` }, payload: payload as Record<string, unknown> });

    const inv = await invoice(c);
    const number = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}`, headers: c.owner })).json();
    const full = `${number.series}-${number.number}`;

    assert.equal((await bank('validate', { invoiceNumber: full }, 'wrong-token')).statusCode, 401);
    const v = (await bank('validate', { invoiceNumber: full })).json();
    assert.deepEqual(v, { status: 0, displayInfo: 'Due 2026-12-31. Balance BZ$112.50', amountMin: 0.01, amountMax: 112.5, customerName: 'Island Logistics Ltd.' });
    assert.ok(v.displayInfo.length <= 50);
    assert.equal((await bank('validate', { invoiceNumber: String(number.serial) })).json().status, 0, 'the short number works too');
    assert.equal((await bank('validate', { invoiceNumber: '999' })).json().status, 1);
    assert.equal((await bank('validate', { referenceNumber: full })).json().status, 0, 'common field names are understood');

    const post = await bank('post', { invoiceNumber: full, postingDate: '2026-11-22', amount: '50.00', bblReferenceNumber: '200000001234' });
    assert.equal(post.json().status, 0, post.body);
    assert.match(post.json().receiptNumber, /^PAY-[0-9A-F]{10}$/);
    const again = await bank('post', { invoiceNumber: full, postingDate: '2026-11-22', amount: '50.00', bblReferenceNumber: '200000001234' });
    assert.equal(again.json().receiptNumber, post.json().receiptNumber, 'the same receipt for a repeat');
    let p = await paymentsOf(c, inv.id);
    assert.deepEqual([p.payments.length, p.invoice.balance, p.invoice.status], [1, '62.50', 'partial']);
    assert.equal(p.payments[0]!.reference, 'Belize Bank bill payment 200000001234');

    // The day's summary: one already posted, one missed, one that matches nothing.
    const rec = await bank('reconcile', {
      totalAmount: 175.0, totalCount: 3, businessDate: '2026-11-22',
      transactions: [
        { invoiceNumber: full, postingDate: '2026-11-22', amount: '50.00', bblReferenceNumber: '200000001234' },
        { invoiceNumber: full, postingDate: '2026-11-22', amount: '62.50', bblReferenceNumber: '200000001235' },
        { invoiceNumber: '000000777', postingDate: '2026-11-22', amount: '62.50', bblReferenceNumber: '200000001236' },
      ],
    });
    assert.deepEqual(rec.json(), { status: 0 });
    p = await paymentsOf(c, inv.id);
    assert.deepEqual([p.payments.length, p.invoice.status], [2, 'paid']);
    const setup = (await c.app.inject({ method: 'GET', url: '/v1/bill-payments', headers: c.owner })).json();
    assert.deepEqual(setup.last30Days, { payments: 2, amount: '112.50' });
    assert.equal(setup.problems.length, 1);
    assert.deepEqual([setup.problems[0].bankReference, setup.problems[0].outcome, setup.problems[0].amount], ['200000001236', 'unmatched', '62.50']);
    assert.ok(setup.lastSeenAt);

    // A new token replaces the old one; turned off, the bank is refused.
    const rotated = (await c.app.inject({ method: 'POST', url: '/v1/bill-payments', headers: c.owner, payload: {} })).json();
    assert.equal((await bank('validate', { invoiceNumber: full })).statusCode, 401);
    assert.equal((await bank('validate', { invoiceNumber: full }, rotated.token)).json().status, 1, 'paid now');
    await c.app.inject({ method: 'PUT', url: '/v1/bill-payments', headers: c.owner, payload: { referenceField: 'invoiceNumber', enabled: false } });
    assert.equal((await bank('validate', { invoiceNumber: full }, rotated.token)).statusCode, 401);
  }));
