/**
 * Online store, phase 2: discount codes (on the quote, the order, the
 * e-invoice and refunds), paying online with the test gateway and PayPal,
 * and reconciling payments buyers never came back from.
 */

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { gatewayOptions, reconcilePayments } from '../src/api/payments.ts';
import { allocateDiscount, discountShare } from '../src/commerce/discounts.ts';
import { bzdToUsd } from '../src/commerce/payments.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  slug: string;
  owner: Record<string, string>;
  productId: string;
  variants: string[];
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/** A stand-in for PayPal's REST API. */
function fakePayPal() {
  const orders = new Map<string, { value: string; captured: boolean }>();
  let n = 0;
  let captureValue: string | null = null;
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/oauth2/token') {
      return String((init?.headers as Record<string, string>).authorization).includes(Buffer.from('bad-client-id-123:').toString('base64').slice(0, 10)) ? json(401, {}) : json(200, { access_token: 'tok', expires_in: 3600 });
    }
    if (url.pathname === '/v2/checkout/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `PP-${++n}`;
      orders.set(id, { value: body.purchase_units[0].amount.value, captured: false });
      return json(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    const m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(url.pathname);
    if (m) {
      const o = orders.get(m[1]!)!;
      o.captured = true;
      return json(201, { id: m[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-${m[1]}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: captureValue ?? o.value } }] } }] });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetcher, calls, setCaptureValue: (v: string | null) => (captureValue = v) };
}

async function withShop(fn: (c: Ctx) => Promise<void>, options: { paypal?: ReturnType<typeof fakePayPal> } = {}) {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail, ...(options.paypal && { paymentsFetch: options.paypal.fetcher }) });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
  const settings = await app.inject({ method: 'PUT', url: '/v1/store-settings', headers: owner, payload: { enabled: true, delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '8.00' }] }, pickup: { enabled: true, instructions: '' } } });
  assert.equal(settings.statusCode, 200, settings.body);
  const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 10 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 10 }] } });
  assert.equal(product.statusCode, 201, product.body);
  try {
    await fn({ f, app, mail, slug, owner, productId: product.json().id, variants: product.json().variants.map((v: { id: string }) => v.id) });
  } finally {
    await app.close();
    await f.close();
  }
}

const buyer = { name: 'Ana Buyer', email: 'ana@example.com', phone: '+501 610-0000' };
const address = { street: '1 Barrack Road', city: 'Belize City', districtCode: '1' };

test('discount shares: percent and BZ$ amounts per line, and refunds that always add up', () => {
  assert.deepEqual(allocateDiscount({ kind: 'percent', value: '10' }, [{ net: 8000n, total: 9000n }, { net: 1000n, total: 1000n }]), [800n, 100n]);
  // BZ$10 off 90 + 10 (with GST): shared 9:1, each taken back to before GST.
  assert.deepEqual(allocateDiscount({ kind: 'amount', value: '10' }, [{ net: 8000n, total: 9000n }, { net: 1000n, total: 1000n }]), [800n, 100n]);
  assert.deepEqual(allocateDiscount({ kind: 'amount', value: '500' }, [{ net: 100n, total: 113n }]), [100n], 'never more than the line');
  // A 1.00 discount on 3 units, refunded one at a time: 0.33 + 0.34 + 0.33 = 1.00.
  const parts = [discountShare(100n, 3, 0, 1), discountShare(100n, 3, 1, 1), discountShare(100n, 3, 2, 1)];
  assert.equal(parts.reduce((a, b) => a + b, 0n), 100n);
  assert.equal(bzdToUsd(9900n), '49.50');
  assert.equal(bzdToUsd(9901n), '49.51', 'rounded up, never less for the business');
});

test('discount codes: quote, order, the e-invoice shows the allowance, refunds take their share, limits hold', () =>
  withShop(async (c) => {
    const make = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/discounts', headers: c.owner, payload: body });
    assert.equal((await make({ code: 'REEF10', kind: 'percent', value: '10', maxUses: 1 })).statusCode, 201);
    assert.equal((await make({ code: 'TEN', kind: 'amount', value: '10' })).statusCode, 201);
    assert.equal((await make({ code: 'SHIPFREE', kind: 'free_delivery' })).statusCode, 201);
    assert.equal((await make({ code: 'reef10', kind: 'percent', value: '5' })).statusCode, 422, 'codes are unique, whatever the case');
    assert.equal((await make({ code: 'TOOMUCH', kind: 'percent', value: '150' })).statusCode, 422);

    const quote = (code: string) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/quote`, payload: { lines: [{ variantId: c.variants[0], quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City', discountCode: code } });
    const plain = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/quote`, payload: { lines: [{ variantId: c.variants[0], quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City' } })).json();
    assert.equal(plain.totals.total, '99.00');
    const tenOff = (await quote('reef10')).json();
    assert.equal(tenOff.totals.total, '90.00', '10% off the shirts (90 → 81), delivery 9');
    assert.deepEqual(tenOff.discount, { code: 'REEF10', kind: 'percent', saved: '9.00' });
    assert.equal((await quote('TEN')).json().totals.total, '89.00');
    assert.equal((await quote('SHIPFREE')).json().totals.total, '90.00');
    assert.equal((await quote('NOPE')).statusCode, 422);

    const placed = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variants[0], quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'bank_transfer', customer: buyer, address, discountCode: 'REEF10' } });
    assert.equal(placed.statusCode, 201, placed.body);
    assert.equal(placed.json().totals.total, '90.00');
    const again = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variants[0], quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'bank_transfer', customer: buyer, discountCode: 'REEF10' } });
    assert.equal(again.statusCode, 422, 'used up after one order');

    const orderId = (await c.app.inject({ method: 'GET', url: '/v1/orders?view=all', headers: c.owner })).json().data.find((o: { number: number }) => o.number === placed.json().number).id;
    const paid = (await c.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/paid`, headers: c.owner })).json();
    assert.deepEqual(paid.discount, { code: 'REEF10', net: '8.00' });
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.document.id}`, headers: c.owner })).json();
    assert.equal(doc.totals.taxInclusive, '90.00', 'the receipt matches what the buyer paid');
    const xml = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.document.id}/xml`, headers: c.owner })).body;
    assert.match(xml, /<cbc:AllowanceChargeReason>Discount REEF10<\/cbc:AllowanceChargeReason>/);

    const refund = await c.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/refund`, headers: c.owner, payload: { reason: 'One returned', lines: [{ lineNumber: 1, quantity: 1 }] } });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().refund.amount, '40.50', 'one shirt at its discounted price');
    const rest = await c.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/refund`, headers: c.owner, payload: { reason: 'All back' } });
    assert.equal(rest.json().totals.refunded, '90.00', 'refunds add up to exactly what was paid');

    const list = (await c.app.inject({ method: 'GET', url: '/v1/discounts', headers: c.owner })).json().data;
    assert.equal(list.find((d: { code: string }) => d.code === 'REEF10').uses, 1);
  }));

test('paying online with the test gateway: approve issues the receipt; decline lets the buyer try again; reconciliation catches up', () =>
  withShop(async (c) => {
    const on = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, payments: { bankTransfer: { enabled: true, instructions: '' }, online: { enabled: true, provider: 'test' } } } });
    assert.equal(on.statusCode, 200, on.body);
    const quote = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/quote`, payload: { lines: [{ variantId: c.variants[0], quantity: 1 }], fulfillment: 'pickup' } })).json();
    assert.ok(quote.paymentMethods.includes('online'));

    const order = async () => {
      const r = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variants[0], quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'online', customer: buyer } });
      assert.equal(r.statusCode, 201, r.body);
      return r.json();
    };
    const first = await order();
    const m = new RegExp(`^/${c.slug}/shop/pay/([0-9a-f-]{36})$`).exec(first.payment.redirectUrl);
    assert.ok(m, first.payment.redirectUrl);
    const paymentId = m[1]!;
    const page = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/test-payments/${paymentId}` })).json();
    assert.equal(page.amount, '45.00');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${paymentId}`, payload: { decision: 'approved' } })).statusCode, 200);
    const confirm = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${first.number}/payments/${paymentId}/confirm?t=${first.token}` });
    assert.deepEqual(confirm.json(), { status: 'paid', problem: null });
    const buyerPage = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${first.number}?t=${first.token}` })).json();
    assert.equal(buyerPage.paymentStatus, 'paid');
    assert.equal(buyerPage.document.type, '02', 'the receipt was issued');
    assert.ok(c.mail.sent.some((m) => m.to === 'ana@example.com' && m.attachments?.length), 'and emailed');
    // Confirming twice changes nothing.
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${first.number}/payments/${paymentId}/confirm?t=${first.token}` })).json().status, 'paid');

    // Declined: the order waits, the buyer can try again.
    const second = await order();
    const secondPayment = /pay\/(.+)$/.exec(second.payment.redirectUrl)![1]!;
    await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${secondPayment}`, payload: { decision: 'declined' } });
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${second.number}/payments/${secondPayment}/confirm?t=${second.token}` })).json().status, 'failed');
    const waiting = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${second.number}?t=${second.token}` })).json();
    assert.equal(waiting.paymentStatus, 'unpaid');
    assert.equal(waiting.online.canPay, true);
    assert.equal(waiting.online.lastStatus, 'failed');
    const retry = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${second.number}/pay?t=${second.token}` })).json();
    const retryId = /pay\/(.+)$/.exec(retry.redirectUrl)![1]!;

    // The buyer paid but closed the tab: the reconciliation run settles it.
    await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${retryId}`, payload: { decision: 'approved' } });
    await c.f.db.query("update order_payments set created_at = now() - interval '10 minutes' where id = $1", [retryId]);
    const ctx = { mailer: c.mail, mailConfigured: true, publicUrl: 'https://app.example.test', cookieSecure: true, allowSignup: true };
    const slugOf = async () => c.slug;
    const r = await reconcilePayments(c.f.deps, ctx, gatewayOptions(c.f.deps, slugOf));
    assert.deepEqual(r, { checked: 1, settled: 1 });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${second.number}?t=${second.token}` })).json().paymentStatus, 'paid');

    // Test payments never in production.
    await c.f.db.query("update tenants set environment = 'production' where id = $1", [c.f.tenantA]);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, payments: { online: { enabled: true, provider: 'test' } } } })).statusCode, 422);
  }));

test('PayPal: connect (credentials checked), charge in US dollars at BZ$2 = US$1, capture on return, refuse a wrong amount', async () => {
  const paypal = fakePayPal();
  await withShop(async (c) => {
    const connect = (clientId: string) => c.app.inject({ method: 'PUT', url: '/v1/payment-accounts/paypal', headers: c.owner, payload: { clientId, secret: 'sandbox-secret-abc', mode: 'sandbox' } });
    assert.equal((await connect('bad-client-id-123')).statusCode, 422, 'PayPal refused the credentials');
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, payments: { online: { enabled: true, provider: 'paypal' } } } })).statusCode, 422, 'connect PayPal first');
    assert.equal((await connect('good-client-id-123')).statusCode, 200);
    const accounts = (await c.app.inject({ method: 'GET', url: '/v1/payment-accounts', headers: c.owner })).json();
    assert.deepEqual(accounts.paypal, { connected: true, clientId: 'good-client-id-123', mode: 'sandbox' });
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, payments: { bankTransfer: { enabled: true, instructions: '' }, online: { enabled: true, provider: 'paypal' } } } })).statusCode, 200);

    const placed = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variants[0], quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'online', customer: buyer, address } })).json();
    assert.match(placed.payment.redirectUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=PP-/);
    const payment = (await c.f.db.query<{ id: string; currency: string; charged_amount: string }>('select id, currency, charged_amount from order_payments order by created_at desc limit 1')).rows[0]!;
    assert.deepEqual([payment.currency, payment.charged_amount], ['USD', '49.50'], 'BZ$99.00 at the fixed rate');
    const confirm = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${placed.number}/payments/${payment.id}/confirm?t=${placed.token}` });
    assert.equal(confirm.json().status, 'paid', confirm.body);
    const orderId = (await c.app.inject({ method: 'GET', url: '/v1/orders?view=all', headers: c.owner })).json().data[0].id;
    const detail = (await c.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: c.owner })).json();
    assert.equal(detail.paymentStatus, 'paid');
    assert.equal(detail.payments[0].charged, 'USD 49.50');
    assert.match(detail.payments[0].transactionId, /^CAP-PP-/);

    // PayPal capturing a different amount is not accepted.
    paypal.setCaptureValue('1.00');
    const second = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variants[1], quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'online', customer: buyer } })).json();
    const p2 = (await c.f.db.query<{ id: string }>('select id from order_payments order by created_at desc limit 1')).rows[0]!;
    const bad = (await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${second.number}/payments/${p2.id}/confirm?t=${second.token}` })).json();
    assert.equal(bad.status, 'failed');
    assert.match(bad.problem, /not USD 22\.50/);
  }, { paypal });
});

test('a store on its own domain: DNS verification, then the domain shows the store', async () => {
  const f = await setupPipeline();
  const txt = new Map<string, string[][]>();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', webRoot: fileURLToPath(new URL('../web/dist/', import.meta.url)), storeDomainTarget: 'stores.example.test', resolveTxt: async (name) => txt.get(name) ?? Promise.reject(new Error('ENOTFOUND')) });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/store-domains', headers: owner, payload: { domain: 'shop.app.example.test' } })).statusCode, 422, 'not one of our own domains');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/store-domains', headers: owner, payload: { domain: 'not a domain' } })).statusCode, 422);
    const added = await app.inject({ method: 'POST', url: '/v1/store-domains', headers: owner, payload: { domain: 'https://Shop.CornerStore.bz/' } });
    assert.equal(added.statusCode, 201, added.body);
    const d = added.json();
    assert.equal(d.domain, 'shop.cornerstore.bz');
    assert.deepEqual(d.records.map((r: { type: string; name: string }) => [r.type, r.name]), [['CNAME', 'shop.cornerstore.bz'], ['TXT', '_floreo.shop.cornerstore.bz']]);
    assert.equal(d.records[0].value, 'stores.example.test');

    const verify = () => app.inject({ method: 'POST', url: '/v1/store-domains/shop.cornerstore.bz/verify', headers: owner });
    assert.equal((await verify()).statusCode, 422, 'no TXT record yet');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/domains/check?domain=shop.cornerstore.bz' })).statusCode, 404, 'no certificate before verification');
    txt.set('_floreo.shop.cornerstore.bz', [[d.records[1].value]]);
    const ok = await verify();
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().verified, true);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/domains/check?domain=shop.cornerstore.bz' })).statusCode, 200);

    const root = await app.inject({ method: 'GET', url: '/', headers: { host: 'shop.cornerstore.bz' } });
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/shop');
    const page = await app.inject({ method: 'GET', url: '/shop/products/tee', headers: { host: 'shop.cornerstore.bz' } });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`<meta name="floreo-store" content="${slug}">`), 'the page names the store');
    const robots = await app.inject({ method: 'GET', url: '/robots.txt', headers: { host: 'shop.cornerstore.bz' } });
    assert.match(robots.body, /Sitemap: https:\/\/shop\.cornerstore\.bz\/sitemap\.xml/);
    assert.equal((await app.inject({ method: 'GET', url: '/sitemap.xml', headers: { host: 'shop.cornerstore.bz' } })).statusCode, 404, 'no sitemap while the store is closed');
    const plain = await app.inject({ method: 'GET', url: '/shop', headers: { host: 'app.example.test' } });
    assert.ok(!plain.body.includes('floreo-store'), 'the platform host is unchanged');
    // Another business cannot take the domain.
    await createUser(f.db, { tenantId: f.tenantB, name: 'Bo', email: 'bo@other.example', role: 'owner', password: PASSWORD });
    const slugB = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantB])).rows[0]!.slug;
    const loginB = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slugB, login: 'bo@other.example', password: PASSWORD } });
    const taken = await app.inject({ method: 'POST', url: '/v1/store-domains', headers: { ...CSRF, cookie: cookieFrom(loginB), 'x-business': slugB }, payload: { domain: 'shop.cornerstore.bz' } });
    assert.equal(taken.statusCode, 422);
  } finally {
    await app.close();
    await f.close();
  }
});
