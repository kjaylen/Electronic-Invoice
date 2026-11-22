/**
 * The online store: products with variants and photos, the public
 * storefront, quotes and orders with stock, and orders turning into BTS
 * documents when paid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PNG } from 'pngjs';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { resetStoreLimits } from '../src/api/storefront.ts';
import { priceWithGst } from '../src/commerce/store.ts';
import { createApiKey } from '../src/db/apikeys.ts';
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
  as: (role: 'manager' | 'cashier' | 'accountant') => Promise<Record<string, string>>;
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withStore(fn: (c: Ctx) => Promise<void>) {
  resetLoginAttempts();
  resetStoreLimits();
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  let n = 0;
  const as = async (role: 'owner' | 'manager' | 'cashier' | 'accountant') => {
    const email = `${role}${++n}@shop.example`;
    await createUser(f.db, { tenantId: f.tenantA, name: role, email, role, password: PASSWORD });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  const owner = await as('owner');
  try {
    await fn({ f, app, mail, slug, owner, as });
  } finally {
    await app.close();
    await f.close();
  }
}

const TEE = {
  title: 'Island T-shirt',
  description: 'Soft cotton, printed in Belize City.',
  status: 'active',
  option1Name: 'Size',
  variants: [
    { option1: 'S', price: '40.00', gstCategory: 'S', sellerCode: 'TEE-S', stock: 5 },
    { option1: 'M', price: '40.00', gstCategory: 'S', sellerCode: 'TEE-M', stock: 1 },
  ],
};

async function openStore(c: Ctx, overrides: Record<string, unknown> = {}) {
  const res = await c.app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: c.owner,
    payload: {
      enabled: true,
      tagline: 'Made here',
      delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '8.00' }, { name: 'San Pedro', fee: '25.00' }] },
      pickup: { enabled: true, instructions: 'Ring the bell' },
      payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank 123-456, account Corner Store' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true } },
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function createProduct(c: Ctx, body: Record<string, unknown> = TEE) {
  const res = await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: body });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const order = (c: Ctx, body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: body });
const buyer = { name: 'Ana Buyer', email: 'ana@example.com', phone: '+501 610-0000' };
const address = { street: '1 Barrack Road', city: 'Belize City', districtCode: '1' };

test('prices shown to buyers include GST', () => {
  assert.equal(priceWithGst('40', 'S'), '45.00');
  assert.equal(priceWithGst('8', 'S'), '9.00');
  assert.equal(priceWithGst('3.33', 'S'), '3.75');
  assert.equal(priceWithGst('10', 'Z'), '10.00');
});

test('products: variants become items (counter, invoices), edits, archived variants, barcodes', () =>
  withStore(async (c) => {
    const p = await createProduct(c);
    assert.equal(p.handle, 'island-t-shirt');
    assert.deepEqual(p.variants.map((v: { title: string; priceWithGst: string; stock: number }) => [v.title, v.priceWithGst, v.stock]), [['S', '45.00', 5], ['M', '45.00', 1]]);
    assert.equal((await createProduct(c, { ...TEE, status: 'draft' })).handle, 'island-t-shirt-2', 'handles are unique');

    const items = (await c.app.inject({ method: 'GET', url: '/v1/items?q=island', headers: c.owner })).json().data.map((i: { name: string }) => i.name);
    assert.ok(items.includes('Island T-shirt – M'), 'variants sell at the counter and on invoices');

    const [s] = p.variants;
    const put = await c.app.inject({
      method: 'PUT', url: `/v1/products/${p.id}`, headers: c.owner,
      payload: { ...TEE, title: 'Island Tee', variants: [{ id: s.id, option1: 'S', price: '42.00', gstCategory: 'S', stock: 9 }, { option1: 'L', price: '44.00', gstCategory: 'S', barcode: '777000111' }] },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().variants.map((v: { title: string; price: string }) => [v.title, v.price]), [['S', '42.00'], ['L', '44.00']], 'M was left out, so it is archived');
    assert.equal(put.json().variants[0].id, s.id, 'existing variants keep their id');

    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title: 'Dup', variants: [{ price: '1', gstCategory: 'S', barcode: '777000111' }] } })).statusCode, 409);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title: 'Two same', variants: [{ option1: 'A', price: '1', gstCategory: 'S' }, { option1: 'a', price: '1', gstCategory: 'S' }] } })).statusCode, 422);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title: 'Exempt', variants: [{ price: '1', gstCategory: 'E' }] } })).statusCode, 422);

    const cashier = await c.as('cashier');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/products', headers: cashier, payload: TEE })).statusCode, 403);
    const key = (await createApiKey(c.f.db, c.f.tenantA, 'shop sync')).key;
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/products', headers: { authorization: `Bearer ${key}` }, payload: { ...TEE, title: 'From the POS' } })).statusCode, 201, 'API keys can sync products');
  }));

test('photos: real images only, cover, served to buyers only for active products', () =>
  withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c, { ...TEE, status: 'draft' });
    const png = new PNG({ width: 2, height: 2 });
    const upload = (data: Buffer) => c.app.inject({ method: 'POST', url: `/v1/products/${p.id}/images`, headers: c.owner, payload: { dataBase64: data.toString('base64') } });
    const first = await upload(PNG.sync.write(png));
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().contentType, 'image/png');
    const second = (await upload(PNG.sync.write(png))).json();
    assert.equal((await upload(Buffer.from('<svg onload=alert(1)></svg>'.repeat(3)))).statusCode, 422, 'not an image');

    const cover = await c.app.inject({ method: 'POST', url: `/v1/products/${p.id}/images/${second.id}/cover`, headers: c.owner });
    assert.equal(cover.json().images[0].id, second.id);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}/images/${first.json().id}`, headers: c.owner })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/images/${first.json().id}` })).statusCode, 404, 'drafts stay private');
    await c.app.inject({ method: 'PUT', url: `/v1/products/${p.id}`, headers: c.owner, payload: { ...TEE, status: 'active', variants: p.variants.map((v: { id: string; option1: string }) => ({ id: v.id, option1: v.option1, price: '40', gstCategory: 'S' })) } });
    const pub = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/images/${first.json().id}` });
    assert.equal(pub.statusCode, 200);
    assert.equal(pub.headers['content-type'], 'image/png');
    assert.match(String(pub.headers['cache-control']), /immutable/);
  }));

test('storefront: closed until opened; only active products; prices with GST; stock hints', () =>
  withStore(async (c) => {
    const p = await createProduct(c);
    await createProduct(c, { ...TEE, title: 'Secret draft', status: 'draft' });
    const closed = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` });
    assert.equal(closed.statusCode, 404);
    assert.equal(closed.json().error.code, 'store_closed');
    await openStore(c);
    const info = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json();
    assert.deepEqual(info.delivery.zones, [{ name: 'Belize City', fee: '9.00' }, { name: 'San Pedro', fee: '28.13' }]);
    assert.equal(info.pickup.enabled, true);
    const list = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products` })).json().data;
    assert.deepEqual(list.map((x: { title: string; price: string }) => [x.title, x.price]), [['Island T-shirt', '45.00']]);
    const detail = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products/${p.handle}` })).json();
    assert.deepEqual(detail.options, ['Size']);
    assert.deepEqual(detail.variants.map((v: { title: string; price: string; left: number | null }) => [v.title, v.price, v.left]), [['S', '45.00', 5], ['M', '45.00', 1]]);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products/secret-draft` })).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store/no-such-store' })).statusCode, 404);
  }));

test('quote: lines, delivery as a GST line, pickup, bad zone', () =>
  withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c);
    const quote = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/quote`, payload: body });
    const q = await quote({ lines: [{ variantId: p.variants[0].id, quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City' });
    assert.equal(q.statusCode, 200, q.body);
    // 2 x 40 + 8 delivery = 88 net; GST 11.00; total 99.00
    assert.deepEqual(q.json().totals, { lineExtension: '88.00', gst: '11.00', total: '99.00' });
    assert.equal(q.json().delivery.total, '9.00');
    assert.deepEqual(q.json().paymentMethods, ['bank_transfer', 'cash_on_delivery']);
    const pickup = (await quote({ lines: [{ variantId: p.variants[0].id, quantity: 2 }], fulfillment: 'pickup' })).json();
    assert.equal(pickup.totals.total, '90.00');
    assert.deepEqual(pickup.paymentMethods, ['bank_transfer', 'pay_at_pickup']);
    assert.equal((await quote({ lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'delivery', zone: 'Mars' })).statusCode, 422);
    assert.equal((await quote({ lines: [{ variantId: p.variants[1].id, quantity: 2 }], fulfillment: 'pickup' })).statusCode, 409, 'only one M left');
  }));

test('placing an order reserves stock, emails both sides, and gives the buyer a private order page', () =>
  withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c);
    const placed = await order(c, { lines: [{ variantId: p.variants[1].id, quantity: 1 }, { variantId: p.variants[0].id, quantity: 2 }], fulfillment: 'delivery', zone: 'San Pedro', paymentMethod: 'bank_transfer', customer: buyer, address });
    assert.equal(placed.statusCode, 201, placed.body);
    const { number, token, path } = placed.json();
    assert.equal(number, 1001);
    assert.equal(path, `/${c.slug}/shop/orders/1001?t=${token}`);

    const sold = await order(c, { lines: [{ variantId: p.variants[1].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: buyer });
    assert.equal(sold.statusCode, 409, 'the last M is gone');
    assert.equal(sold.json().error.code, 'out_of_stock');
    assert.equal((await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'cash_on_delivery', customer: buyer })).statusCode, 422, 'no cash on delivery for pickup');
    assert.equal((await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'cash_on_delivery', customer: buyer })).statusCode, 422, 'delivery needs an address');

    const detail = (await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}`, headers: c.owner })).json();
    assert.deepEqual(detail.variants.map((v: { stock: number }) => v.stock), [3, 0]);

    const page = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/1001?t=${token}` });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().paymentStatus, 'unpaid');
    assert.match(page.json().instructions, /Belize Bank/);
    // 40 + 80 + 25 delivery = 145 net; GST 18.13 (on the total); total 163.13
    assert.deepEqual(page.json().totals, { lineExtension: '145.00', gst: '18.13', total: '163.13' });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/1001?t=${'x'.repeat(32)}` })).statusCode, 404, 'the token is needed');

    await new Promise((r) => setTimeout(r, 50));
    const toBuyer = c.mail.sent.find((m) => m.to === 'ana@example.com')!;
    assert.match(toBuyer.subject, /Order #1001/);
    assert.match(toBuyer.text, /Belize Bank 123-456/);
    assert.ok(toBuyer.text.includes(`https://app.example.test${path}`));
    const toMerchant = c.mail.sent.find((m) => m.subject.startsWith('New order #1001'))!;
    assert.match(toMerchant.subject, /BZ\$163\.13/);
  }));

test('marking an order paid issues the BTS receipt (once), emails it, and the buyer can download it', () =>
  withStore(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    await openStore(c);
    const p = await createProduct(c);
    const { token } = (await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'bank_transfer', customer: buyer, address })).json();
    const list = (await c.app.inject({ method: 'GET', url: '/v1/orders', headers: c.owner })).json();
    assert.deepEqual(list.counts, { unpaid: 1, unfulfilled: 1 });
    const id = list.data[0].id;

    const accountant = await c.as('accountant');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: accountant })).statusCode, 403);
    const cashier = await c.as('cashier');
    const paid = await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: cashier });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(paid.json().paymentStatus, 'paid');
    assert.equal(paid.json().document.status, 'authorized');
    assert.equal(paid.json().document.type, '02');
    assert.equal(paid.json().emailed, true);

    const sent = c.f.bts.requests.filter((r) => r.path === SUBMIT_PATHS['02']);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /Island T-shirt – S/);
    assert.match(sent[0]!.body, /Delivery: Belize City/);
    assert.match(sent[0]!.body, /Online order #1001/);
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.json().document.id}`, headers: c.owner })).json();
    assert.equal(doc.totals.taxInclusive, '99.00', 'the receipt matches the order to the cent');
    assert.equal(doc.issuedBy, 'cashier');

    const again = await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: c.owner });
    assert.equal(again.json().document.id, paid.json().document.id, 'paying twice never issues twice');
    assert.equal(c.f.bts.requests.filter((r) => r.path === SUBMIT_PATHS['02']).length, 1);

    const receiptMail = c.mail.sent.find((m) => m.to === 'ana@example.com' && m.attachments?.length)!;
    assert.match(receiptMail.subject, /Tax Receipt 001-000000001/i);
    const page = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/1001?t=${token}` })).json();
    assert.equal(page.document.number, '000000001');
    assert.equal(page.instructions, null, 'no payment instructions once paid');
    const pdf = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/1001/document?t=${token}` });
    assert.equal(pdf.headers['content-type'], 'application/pdf');

    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/fulfilled`, headers: cashier })).json().fulfillmentStatus, 'fulfilled');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/cancel`, headers: c.owner, payload: { reason: 'x' } })).statusCode, 409, 'paid orders are refunded with a credit note');
    assert.deepEqual((await c.app.inject({ method: 'GET', url: '/v1/orders?view=done', headers: c.owner })).json().data.map((o: { number: number }) => o.number), [1001]);
  }));

test('a buyer who gives a TIN gets a tax invoice in the business name', () =>
  withStore(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    await openStore(c);
    const p = await createProduct(c);
    assert.equal((await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: buyer, business: { tin: '445566', name: 'Reef Divers Ltd.' } })).statusCode, 422, 'an invoice needs the address');
    const placed = await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: buyer, address, business: { tin: '445566', name: 'Reef Divers Ltd.' } });
    assert.equal(placed.statusCode, 201, placed.body);
    const id = (await c.app.inject({ method: 'GET', url: '/v1/orders', headers: c.owner })).json().data[0].id;
    const paid = (await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: c.owner })).json();
    assert.equal(paid.document.type, '01');
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.document.id}`, headers: c.owner })).json();
    assert.equal(doc.customer.name, 'Reef Divers Ltd.');
    assert.equal(doc.customer.tin, '445566');
  }));

test('cancelling an unpaid order puts the stock back; a cancelled order cannot be paid', () =>
  withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c);
    await order(c, { lines: [{ variantId: p.variants[1].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: buyer });
    const id = (await c.app.inject({ method: 'GET', url: '/v1/orders', headers: c.owner })).json().data[0].id;
    const accountant = await c.as('accountant');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/cancel`, headers: accountant, payload: { reason: 'x' } })).statusCode, 403);
    const res = await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/cancel`, headers: c.owner, payload: { reason: 'Buyer changed their mind' } });
    assert.equal(res.json().status, 'cancelled');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}`, headers: c.owner })).json().variants[1].stock, 1, 'the M is back');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: c.owner })).statusCode, 409);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/orders?view=cancelled', headers: c.owner })).json().data.length, 1);
    const log = (await c.app.inject({ method: 'GET', url: '/v1/audit', headers: c.owner })).json().data.map((e: { action: string }) => e.action);
    for (const a of ['store.opened', 'order.placed', 'order.cancelled']) assert.ok(log.includes(a), a);
  }));

test('store settings: validation, and only owners and admins change them', () =>
  withStore(async (c) => {
    const manager = await c.as('manager');
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: manager, payload: { enabled: true } })).statusCode, 403);
    const bad = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true, delivery: { enabled: false, zones: [] }, pickup: { enabled: false } } });
    assert.equal(bad.statusCode, 422);
    const dupZones = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { delivery: { enabled: true, zones: [{ name: 'Cayo', fee: '1' }, { name: 'cayo', fee: '2' }] } } });
    assert.equal(dupZones.statusCode, 422);
    const ok = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { tagline: 'Hi' } });
    assert.equal(ok.json().tagline, 'Hi');
    assert.equal(ok.json().enabled, false, 'partial updates keep the rest');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-settings', headers: manager })).json().slug, c.slug);
  }));
