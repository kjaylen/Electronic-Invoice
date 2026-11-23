/**
 * The online store: products with variants and photos, the public
 * storefront, quotes and orders with stock, and orders turning into BTS
 * documents when paid.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PNG } from 'pngjs';
import { buildApp } from '../src/api/app.ts';
import { runStockAlerts } from '../src/commerce/stock-alerts.ts';
import { priceWithGst } from '../src/commerce/store.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { type ObjectStore, s3Store, signV4 } from '../src/storage/objects.ts';
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

async function withStore(fn: (c: Ctx) => Promise<void>, appOptions: { objectStore?: ObjectStore; webRoot?: string } = {}) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail, ...appOptions });
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

test('SigV4 matches the AWS reference example (GET object with a range)', () => {
  const headers = signV4(
    { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
    new Date('2013-05-24T00:00:00Z'),
  );
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

/** A stand-in S3 bucket: objects in a map, every request recorded. */
function fakeBucket() {
  const objects = new Map<string, { data: Buffer; type: string }>();
  const requests: Array<{ method: string; url: string; auth: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const h = init?.headers as Record<string, string>;
    requests.push({ method, url, auth: h.authorization ?? '' });
    const key = new URL(url).pathname;
    if (method === 'PUT') {
      objects.set(key, { data: Buffer.from(init!.body as Uint8Array), type: h['content-type'] ?? '' });
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o.data), { status: 200, headers: { 'content-type': o.type } }) : new Response('NoSuchKey', { status: 404 });
  }) as typeof fetch;
  return { objects, requests, fetcher };
}

test('photos in object storage: uploaded to the bucket, served from the CDN (or through the app), deleted with the photo', async () => {
  const bucket = fakeBucket();
  const config = { endpoint: 'https://s3.example.test', region: 'us-east-1', bucket: 'shop-photos', accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret', fetch: bucket.fetcher };
  await withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c, { ...TEE, status: 'active' });
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const up = await c.app.inject({ method: 'POST', url: `/v1/products/${p.id}/images`, headers: c.owner, payload: { dataBase64: png.toString('base64') } });
    assert.equal(up.statusCode, 201, up.body);
    const id = up.json().id;
    const put = bucket.requests.find((r) => r.method === 'PUT')!;
    assert.match(put.url, new RegExp(`^https://shop-photos\\.s3\\.example\\.test/products/${c.f.tenantA}/${id}\\.png$`), 'virtual-hosted style URL');
    assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const row = (await c.f.db.query<{ data: unknown; storage_key: string }>('select data, storage_key from product_images where id = $1', [id])).rows[0]!;
    assert.equal(row.data, null, 'the database keeps only the key');
    assert.equal(row.storage_key, `products/${c.f.tenantA}/${id}.png`);

    const cdn = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/images/${id}` });
    assert.equal(cdn.statusCode, 302);
    assert.equal(cdn.headers.location, `https://cdn.example.test/products/${c.f.tenantA}/${id}.png`);
    assert.match(String(cdn.headers['cache-control']), /immutable/);

    const del = await c.app.inject({ method: 'DELETE', url: `/v1/products/${p.id}/images/${id}`, headers: c.owner });
    assert.equal(del.statusCode, 204);
    assert.equal(bucket.objects.size, 0, 'the object is deleted too');
  }, { objectStore: s3Store({ ...config, publicBaseUrl: 'https://cdn.example.test/' }) });

  // Without a CDN, the app fetches the object and serves it (path-style, as MinIO wants).
  await withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c, { ...TEE, status: 'active' });
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const id = (await c.app.inject({ method: 'POST', url: `/v1/products/${p.id}/images`, headers: c.owner, payload: { dataBase64: png.toString('base64') } })).json().id;
    assert.ok(bucket.requests.at(-1)!.url.startsWith('https://s3.example.test/shop-photos/products/'));
    const served = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/images/${id}` });
    assert.equal(served.statusCode, 200);
    assert.deepEqual(served.rawPayload, png);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}/images/${id}`, headers: c.owner })).statusCode, 200);
  }, { objectStore: s3Store({ ...config, forcePathStyle: true }) });
});

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
    assert.deepEqual(page.json().totals, { lineExtension: '145.00', gst: '18.13', total: '163.13', refunded: '0.00' });
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

test('refunding a paid order issues credit notes, never more than was paid, and can restock', () =>
  withStore(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
    await openStore(c);
    const p = await createProduct(c);
    await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'bank_transfer', customer: buyer, address });
    const id = (await c.app.inject({ method: 'GET', url: '/v1/orders', headers: c.owner })).json().data[0].id;
    const refund = (headers: Record<string, string>, payload: Record<string, unknown>) => c.app.inject({ method: 'POST', url: `/v1/orders/${id}/refund`, headers, payload });

    assert.equal((await refund(c.owner, { reason: 'x' })).statusCode, 409, 'an unpaid order is cancelled, not refunded');
    const paid = (await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/paid`, headers: c.owner })).json();
    assert.equal(paid.refundable.delivery, true);
    assert.deepEqual(paid.refundable.lines, [{ lineNumber: 1, quantity: 2 }]);
    assert.equal((await refund(await c.as('cashier'), { reason: 'x' })).statusCode, 403, 'cashiers do not refund');

    // One shirt back, into stock.
    const manager = await c.as('manager');
    const first = await refund(manager, { reason: 'Wrong size', lines: [{ lineNumber: 1, quantity: 1 }], restock: true });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().refund.amount, '45.00');
    assert.equal(first.json().totals.refunded, '45.00');
    assert.deepEqual(first.json().refundable, { lines: [{ lineNumber: 1, quantity: 1 }], delivery: true });
    assert.equal(first.json().refunds[0].document.type, '04');
    assert.equal(first.json().emailed, true);
    const note = c.f.bts.requests.filter((r) => r.path === SUBMIT_PATHS['04'])[0]!.body;
    const receipt = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.document.id}`, headers: c.owner })).json();
    assert.ok(note.includes(receipt.etdui), 'the credit note references the receipt');
    assert.match(note, /Island T-shirt – S/);
    assert.match(note, /Wrong size/);
    assert.equal(receipt.credit.remaining, '54.00');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}`, headers: c.owner })).json().variants[0].stock, 4, 'restocked');

    assert.equal((await refund(manager, { reason: 'x', lines: [{ lineNumber: 1, quantity: 2 }] })).statusCode, 422, 'only one shirt is left to refund');
    assert.equal((await refund(manager, { reason: 'x', lines: [{ lineNumber: 9, quantity: 1 }] })).statusCode, 422);

    // A credit note typed by hand is capped too.
    const tooMuch = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: manager,
      payload: { type: '04', reference: { documentId: paid.document.id, reason: 'Goodwill' }, customer: { name: 'Ana Buyer' }, lines: [{ description: 'Goodwill', quantity: '1', unitCode: 'EA', unitPrice: '50', gstCategory: 'S' }], payment: { meansCode: '30', terms: 'Refund' } },
    });
    assert.equal(tooMuch.statusCode, 422, tooMuch.body);
    assert.equal(tooMuch.json().error.code, 'credit_exceeds_original');
    assert.equal(tooMuch.json().error.details.remaining, '54.00');

    // The rest: the other shirt and the delivery fee.
    const rest = await refund(manager, { reason: 'Order returned' });
    assert.equal(rest.statusCode, 200, rest.body);
    assert.equal(rest.json().refund.amount, '54.00');
    assert.equal(rest.json().totals.refunded, '99.00');
    assert.deepEqual(rest.json().refundable, { lines: [{ lineNumber: 1, quantity: 0 }], delivery: false });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/products/${p.id}`, headers: c.owner })).json().variants[0].stock, 4, 'not restocked unless asked');
    assert.equal((await refund(manager, { reason: 'again' })).statusCode, 422, 'nothing left');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/documents/${paid.document.id}`, headers: c.owner })).json().credit.remaining, '0.00');
    const log = (await c.app.inject({ method: 'GET', url: '/v1/audit', headers: c.owner })).json().data.filter((e: { action: string }) => e.action === 'order.refunded');
    assert.equal(log.length, 2);
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

test('link previews and search: store pages carry their title, price and picture; each store has a sitemap', () => {
  // A stand-in for the built web app.
  const web = mkdtempSync(join(tmpdir(), 'store-seo-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Floreo</title></head><body><div id="root"></div></body></html>');
  return withStore(async (c) => {
    // Closed: the plain page, and no sitemap.
    const closed = await c.app.inject({ method: 'GET', url: `/${c.slug}/shop` });
    assert.ok(!closed.body.includes('og:title'));
    assert.equal((await c.app.inject({ method: 'GET', url: `/${c.slug}/shop/sitemap.xml` })).statusCode, 404);

    await openStore(c, { about: 'Island <b>shirts</b> & more, printed in Belize City.' });
    const p = await createProduct(c, { ...TEE, title: 'Island "Reef" T-shirt' });
    const png = new PNG({ width: 2, height: 2 });
    const photo = (await c.app.inject({ method: 'POST', url: `/v1/products/${p.id}/images`, headers: c.owner, payload: { dataBase64: PNG.sync.write(png).toString('base64') } })).json();

    const home = await c.app.inject({ method: 'GET', url: `/${c.slug}/shop` });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /<title>[^<]+ · Made here<\/title>/);
    assert.ok(home.body.includes('<meta property="og:description" content="Island shirts &amp; more, printed in Belize City.">'), 'tags stripped, text escaped');
    assert.ok(home.body.includes(`<meta property="og:image" content="https://app.example.test/v1/store/${c.slug}/images/${photo.id}">`), 'the newest product picture when there is no logo');

    const product = await c.app.inject({ method: 'GET', url: `/${c.slug}/shop/products/${p.handle}?ref=wa` });
    assert.match(product.body, /<title>Island &quot;Reef&quot; T-shirt · [^<]+<\/title>/);
    assert.ok(product.body.includes('<meta property="og:type" content="product">'));
    assert.ok(product.body.includes('<meta property="product:price:amount" content="45.00">'));
    assert.ok(product.body.includes(`<meta property="og:url" content="https://app.example.test/${c.slug}/shop/products/${p.handle}">`));
    assert.match(product.body, /og:description" content="BZ\$45\.00 · Soft cotton/);
    assert.ok(!product.body.includes('"Reef"'), 'quotes in the title are escaped');

    // An unknown product or another store page: the plain app page.
    assert.ok(!(await c.app.inject({ method: 'GET', url: `/${c.slug}/shop/products/nope` })).body.includes('og:title'));
    assert.ok(!(await c.app.inject({ method: 'GET', url: `/${c.slug}/shop/checkout` })).body.includes('og:title'));

    const map = await c.app.inject({ method: 'GET', url: `/${c.slug}/shop/sitemap.xml` });
    assert.equal(map.statusCode, 200);
    assert.match(String(map.headers['content-type']), /application\/xml/);
    assert.ok(map.body.includes(`<loc>https://app.example.test/${c.slug}/shop/products/${p.handle}</loc>`));
    assert.ok(map.body.includes(`<loc>https://app.example.test/${c.slug}/shop</loc>`));
  }, { webRoot: web });
});

test('ready for pickup: the buyer is told by email and sees the step on their order page', () =>
  withStore(async (c) => {
    await openStore(c, { pickup: { enabled: true, instructions: 'Ring the bell at the side door' } });
    const p = await createProduct(c);
    const placed = (await order(c, { lines: [{ variantId: p.variants[0].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: buyer })).json();
    const id = (await c.app.inject({ method: 'GET', url: '/v1/orders', headers: c.owner })).json().data[0].id;
    const accountant = await c.as('accountant');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/ready`, headers: accountant })).statusCode, 403);

    const ready = await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/ready`, headers: c.owner, payload: { message: 'Open until 6 pm' } });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().emailed, 'ana@example.com');
    assert.ok(ready.json().readyAt);
    const mail = c.mail.sent.at(-1)!;
    assert.equal(mail.to, 'ana@example.com');
    assert.match(mail.subject, /Your order #1001 is ready for pickup at /);
    assert.match(mail.text, /Ring the bell at the side door/);
    assert.match(mail.text, /Open until 6 pm/);
    assert.match(mail.text, /1 × Island T-shirt/);

    const page = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${placed.number}?t=${placed.token}` })).json();
    assert.ok(page.readyAt);

    // Without telling them; and not once it is picked up.
    const quiet = await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/ready`, headers: c.owner, payload: { notify: false } });
    assert.equal(quiet.json().emailed, null);
    await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/fulfilled`, headers: c.owner });
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${id}/ready`, headers: c.owner })).statusCode, 409);
  }));

test('back in stock: buyers waiting on a sold-out variant are emailed once when it returns', () =>
  withStore(async (c) => {
    await openStore(c);
    const p = await createProduct(c, { ...TEE, variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', sellerCode: 'TEE-S', stock: 0 }, { option1: 'M', price: '40.00', gstCategory: 'S', sellerCode: 'TEE-M', stock: 3 }] });
    const [small, medium] = p.variants as Array<{ id: string }>;
    const ask = (variantId: string, email: string) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/products/${p.handle}/notify`, payload: { variantId, email } });
    assert.equal((await ask(small!.id, 'Ana@Example.com')).statusCode, 200);
    assert.equal((await ask(small!.id, 'ana@example.com')).statusCode, 200, 'asking twice is fine');
    assert.equal((await ask(medium!.id, 'ana@example.com')).json().error.code, 'in_stock');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/products/nope/notify`, payload: { variantId: small!.id, email: 'a@b.example' } })).statusCode, 404);
    const waiting = (await c.f.db.query<{ n: number }>('select count(*)::int as n from stock_alerts where notified_at is null')).rows[0]!.n;
    assert.equal(waiting, 1);
    // The stock list shows who is waiting.
    const stock = (await c.app.inject({ method: 'GET', url: '/v1/inventory?q=TEE-S', headers: c.owner })).json().data as Array<{ itemId: string; waiting: number }>;
    assert.equal(stock.find((x) => x.itemId === small!.id)?.waiting, 1);

    // Still sold out: nothing. Restocked: one email, then never again.
    assert.deepEqual(await runStockAlerts(c.f.db, { mailer: c.mail, publicUrl: 'https://app.example.test' }), { sent: 0 });
    await c.app.inject({ method: 'POST', url: `/v1/inventory/${small!.id}/adjust`, headers: c.owner, payload: { mode: 'set', quantity: '4', reason: 'other', note: 'Restock' } });
    assert.deepEqual(await runStockAlerts(c.f.db, { mailer: c.mail, publicUrl: 'https://app.example.test' }), { sent: 1 });
    const mail = c.mail.sent.at(-1)!;
    assert.equal(mail.to, 'ana@example.com');
    assert.match(mail.subject, /Island T-shirt is back at /);
    assert.ok(mail.text.includes(`https://app.example.test/${c.slug}/shop/products/${p.handle}`));
    assert.match(mail.text, /BZ\$45\.00/);
    assert.deepEqual(await runStockAlerts(c.f.db, { mailer: c.mail, publicUrl: 'https://app.example.test' }), { sent: 0 }, 'once');
  }));

test('store categories: products carry their items category, and the list filters by it', () =>
  withStore(async (c) => {
    await openStore(c);
    const tee = await createProduct(c);
    const mug = await createProduct(c, { ...TEE, title: 'Clay mug', variants: [{ price: '20.00', gstCategory: 'S', sellerCode: 'MUG' }] });
    await createProduct(c, { ...TEE, title: 'Gift card', variants: [{ price: '50.00', gstCategory: 'S', sellerCode: 'GIFT' }] });
    await c.f.db.query("update items set category = 'Clothing' where product_id = $1", [tee.id]);
    await c.f.db.query("update items set category = 'Kitchen' where product_id = $1", [mug.id]);
    const all = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products` })).json().data as Array<{ title: string; category: string | null }>;
    assert.equal(all.length, 3);
    assert.equal(all.find((x) => x.title === 'Clay mug')?.category, 'Kitchen');
    assert.equal(all.find((x) => x.title === 'Gift card')?.category, null);
    const kitchen = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products?category=kitchen` })).json().data as Array<{ title: string }>;
    assert.deepEqual(kitchen.map((x) => x.title), ['Clay mug']);
    const both = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products?category=Clothing&q=island` })).json().data as Array<{ title: string }>;
    assert.deepEqual(both.map((x) => x.title), ['Island T-shirt']);
  }));
