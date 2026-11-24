/**
 * The reference matches reality: every example answer the docs show for the
 * store API is compared, field for field, with what the server really
 * answers; every documented error code is one the server can produce; every
 * store route is in the reference.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { hostedOnly, STORE_ERRORS, STORE_EXAMPLES, STORE_REQUESTS, STORE_SUMMARIES } from '../src/api/store-reference.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { WEBHOOK_EVENTS } from '../src/webhooks/webhooks.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/**
 * Where an example and a real answer differ in their fields. A value that is
 * null (or an empty list) on either side is not looked into: it is a field
 * that is sometimes filled, and the example shows it one way.
 */
function differences(example: unknown, real: unknown, at = ''): string[] {
  if (example === null || real === null || example === undefined || real === undefined) return [];
  if (Array.isArray(example) || Array.isArray(real)) {
    if (!Array.isArray(example) || !Array.isArray(real)) return [`${at}: one is a list, the other is not`];
    return example.length && real.length ? differences(example[0], real[0], `${at}[0]`) : [];
  }
  if (typeof example === 'object' || typeof real === 'object') {
    if (typeof example !== 'object' || typeof real !== 'object') return [`${at}: one is an object, the other is not`];
    const a = example as Record<string, unknown>;
    const b = real as Record<string, unknown>;
    return [
      ...Object.keys(a).filter((k) => !(k in b)).map((k) => `${at}.${k}: in the example, not in the answer`),
      ...Object.keys(b).filter((k) => !(k in a)).map((k) => `${at}.${k}: in the answer, not in the example`),
      ...Object.keys(a).filter((k) => k in b).flatMap((k) => differences(a[k], b[k], `${at}.${k}`)),
    ];
  }
  return typeof example === typeof real ? [] : [`${at}: ${typeof example} in the example, ${typeof real} in the answer`];
}

async function withStore(fn: (c: { app: FastifyInstance; slug: string; owner: Record<string, string>; variant: string; f: Awaited<ReturnType<typeof setupPipeline>> }) => Promise<void>) {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.bz', mailer: memoryMailer() });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const owner = { ...CSRF, 'x-business': slug, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } })) };
    const settings = await app.inject({
      method: 'PUT', url: '/v1/store-settings', headers: owner,
      payload: { enabled: true, tagline: 'From the reef', delivery: { enabled: true, zones: [{ name: 'San Pedro', fee: '8.00' }] }, pickup: { enabled: true, instructions: 'Ask at the counter' }, payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank 123' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: true, provider: 'test' } } },
    });
    assert.equal(settings.statusCode, 200, settings.body);
    const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', description: 'Soft cotton, printed in San Pedro.', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 50 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 3 }] } });
    assert.equal(product.statusCode, 201, product.body);
    // A photo, so the answers carry their image fields filled.
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(200);
    const photo = await app.inject({ method: 'POST', url: `/v1/products/${product.json().id}/images`, headers: owner, payload: { dataBase64: PNG.sync.write(png).toString('base64') } });
    assert.equal(photo.statusCode, 201, photo.body);
    const collection = await app.inject({ method: 'POST', url: '/v1/collections', headers: owner, payload: { title: 'Summer', description: 'For the beach.', products: ['island-t-shirt'], published: true } });
    assert.equal(collection.statusCode, 201, collection.body);
    await fn({ app, slug, owner, variant: product.json().variants[0].id, f });
  } finally {
    await app.close();
    await f.close();
  }
}

test('the reference\'s example answers are what the store API really answers', () =>
  withStore(async ({ app, slug, owner, variant }) => {
    const base = `/v1/store/${slug}`;
    const get = async (path: string) => (await app.inject({ method: 'GET', url: `${base}${path}` })).json();
    const post = async (path: string, payload?: unknown) => (await app.inject({ method: 'POST', url: `${base}${path}`, ...(payload !== undefined && { payload: payload as object }) })).json();
    // A gift card to ask the balance of.
    const card = await app.inject({ method: 'POST', url: '/v1/gift-cards', headers: owner, payload: { amount: '25.00', source: 'given', note: 'For the reference' } });
    assert.equal(card.statusCode, 201, card.body);

    const real: Record<string, unknown> = {
      'GET /v1/store/{slug}/info': await get('/info'),
      'GET /v1/store/{slug}/products': await get('/products?limit=1'),
      'GET /v1/store/{slug}/products/{handle}': await get('/products/island-t-shirt'),
      'GET /v1/store/{slug}/collections': await get('/collections'),
      'GET /v1/store/{slug}/collections/{handle}': await get('/collections/summer'),
      // The request bodies the reference shows are the ones sent here (with this store's own variant).
      'POST /v1/store/{slug}/quote': await post('/quote', { ...(STORE_REQUESTS['POST /v1/store/{slug}/quote'] as object), lines: [{ variantId: variant, quantity: 1 }] }),
      'POST /v1/store/{slug}/gift-cards/balance': await post('/gift-cards/balance', { code: card.json().code }),
      // Asking to be told needs a sold-out variant; its answer is { ok: true } (store.test.ts covers it).
      'POST /v1/store/{slug}/products/{handle}/notify': null,
      'PUT /v1/store/{slug}/checkouts/{id}': (await app.inject({ method: 'PUT', url: `${base}/checkouts/11111111-1111-4111-8111-111111111111`, payload: { email: 'ana@example.com', lines: [{ variantId: variant, quantity: 1 }], fulfillment: 'pickup' } })).json(),
    };
    // An order paid online with the test card: placed, sent to pay, confirmed, and its page with the receipt.
    const { returnUrl: _returnUrl, ...orderBody } = STORE_REQUESTS['POST /v1/store/{slug}/orders'] as Record<string, unknown>;
    const placed = await post('/orders', { ...orderBody, lines: [{ variantId: variant, quantity: 1 }] });
    real['POST /v1/store/{slug}/orders'] = placed;
    real['POST /v1/store/{slug}/orders/{number}/pay'] = await post(`/orders/${placed.number}/pay?t=${placed.token}`);
    const payment = (real['POST /v1/store/{slug}/orders/{number}/pay'] as { paymentId: string }).paymentId;
    await post(`/test-payments/${payment}`, { decision: 'approved' });
    real['POST /v1/store/{slug}/orders/{number}/payments/{paymentId}/confirm'] = await post(`/orders/${placed.number}/payments/${payment}/confirm?t=${placed.token}`);
    real['GET /v1/store/{slug}/orders/{number}'] = await get(`/orders/${placed.number}?t=${placed.token}`);
    real['POST /v1/store/{slug}/contact'] = await post('/contact', { name: 'Ana', email: 'ana@example.com', message: 'Do you deliver to Caye Caulker?' });

    for (const [key, example] of Object.entries(STORE_EXAMPLES)) {
      assert.ok(key in real, `${key}: the reference shows an example nobody checks`);
      if (real[key] === null) continue;
      assert.equal((real[key] as { error?: unknown }).error, undefined, `${key}: ${JSON.stringify(real[key])}`);
      assert.deepEqual(differences(example, real[key], key), [], key);
    }
    // And they say the same things where the store is the same.
    assert.equal((real['GET /v1/store/{slug}/orders/{number}'] as { paymentStatus: string }).paymentStatus, 'paid');
    assert.ok((real['GET /v1/store/{slug}/orders/{number}'] as { document: unknown }).document, 'the receipt is there to compare');
    assert.ok((real['POST /v1/store/{slug}/quote'] as { delivery: unknown }).delivery, 'delivery is there to compare');
    assert.ok((real['GET /v1/store/{slug}/products'] as { data: Array<{ imageUrl: string }> }).data[0]!.imageUrl, 'the photo is there to compare');
    assert.equal((real['GET /v1/store/{slug}/collections/{handle}'] as { products: unknown[] }).products.length, 1, 'the product of the collection is there to compare');
    assert.equal((real['GET /v1/store/{slug}/collections'] as { data: Array<{ productCount: number }> }).data[0]!.productCount, 1);
  }));

test('the reference lists every store route, with example answers and the errors it can give', () =>
  withStore(async ({ app }) => {
    const spec = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    const storePaths = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/store/'));
    assert.ok(storePaths.length >= 25, `${storePaths.length} store paths`);
    assert.deepEqual(Object.keys(spec.paths).slice(0, 3), ['/v1/store/{slug}/info', '/v1/store/{slug}/products', '/v1/store/{slug}/products/{handle}'], 'the store API comes first, in the order a storefront uses it');
    for (const path of storePaths) {
      for (const [method, op] of Object.entries(spec.paths[path] as Record<string, { summary: string; tags: string[]; security: unknown[]; responses: Record<string, { content?: { 'application/json': { example: unknown } } }> }>)) {
        const key = `${method.toUpperCase()} ${path}`;
        assert.equal(op.summary, STORE_SUMMARIES[key], `${key} has no summary`);
        assert.deepEqual(op.tags, [hostedOnly(path) ? 'Storefront: hosted pages' : 'Storefront'], key);
        assert.deepEqual(op.security, [{}, { publishableKey: [] }], key);
        const answer = Object.values(op.responses)[0]!;
        assert.deepEqual(answer.content?.['application/json'].example, STORE_EXAMPLES[key], key);
        // Every endpoint a site built elsewhere uses shows what it answers (a photo and a PDF are not JSON).
        if (!hostedOnly(path) && !/\/(images\/\{id\}|document)$/.test(path)) assert.ok(STORE_EXAMPLES[key], `${key}: no example answer`);
      }
    }
    for (const key of [...Object.keys(STORE_SUMMARIES), ...Object.keys(STORE_EXAMPLES), ...Object.keys(STORE_REQUESTS)]) {
      const [method, path] = key.split(' ') as [string, string];
      assert.ok(spec.paths[path]?.[method.toLowerCase()], `${key} is described but is not a route`);
    }
    const order = spec.paths['/v1/store/{slug}/orders'].post;
    assert.ok(order.responses['201'], 'an order answers 201');
    assert.ok(order.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key'));
    assert.deepEqual(order.requestBody.content['application/json'].example, STORE_REQUESTS['POST /v1/store/{slug}/orders']);
    assert.ok(order.requestBody.content['application/json'].schema.properties.returnUrl, 'from the route\'s own schema');
    assert.equal(spec.components.securitySchemes.publishableKey.scheme, 'bearer');
    // The other half is still there, after it.
    assert.equal(spec.paths['/v1/documents'].post.tags[0], 'Documents');
    assert.equal(spec.paths['/v1/documents'].post.security, undefined);
    assert.deepEqual(spec.tags.map((t: { name: string }) => t.name).slice(0, 2), ['Storefront', 'Documents']);
    assert.equal(spec.tags.at(-1).name, 'Storefront: hosted pages');

    // Webhook events, each with a sample.
    assert.deepEqual(Object.keys(spec.webhooks), [...WEBHOOK_EVENTS]);
    assert.equal(spec.webhooks['order.paid'].post.requestBody.content['application/json'].example.data.order.paymentStatus, 'paid');

    // Error codes: unique, each with a status and what to do; and the guides the dashboard links to.
    const errors = spec['x-store-errors'] as typeof STORE_ERRORS;
    assert.equal(new Set(errors.map((e) => e.code)).size, errors.length);
    for (const e of errors) assert.ok(e.status >= 400 && e.meaning.length > 20, e.code);
    for (const heading of ['Authentication', 'Test and live', 'Errors', 'Pagination', 'Idempotency', 'Rate limits', 'Webhooks']) assert.match(spec.info.description, new RegExp(`^## ${heading}$`, 'm'));
  }));

test('every error the store API is documented to give is one it gives', () =>
  withStore(async ({ app, slug, variant, f }) => {
    const documented = new Map(STORE_ERRORS.map((e) => [e.code, e.status]));
    const base = `/v1/store/${slug}`;
    const site = { origin: 'https://www.reefgoods.example', host: 'app.example.bz' };
    const order = { lines: [{ variantId: variant, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'bank_transfer', customer: { name: 'Ana Buyer', phone: '+501 610-0000' } };
    const seen = new Map<string, number>();
    const expect = async (res: Promise<LightMyRequestResponse>, code: string) => {
      const r = await res;
      assert.equal(r.json().error?.code, code, r.body);
      assert.equal(r.statusCode, documented.get(code), `${code} is documented as ${documented.get(code)}`);
      seen.set(code, r.statusCode);
    };
    await expect(app.inject({ method: 'GET', url: `${base}/products?limit=x` }), 'invalid_request');
    await expect(app.inject({ method: 'GET', url: `${base}/products`, headers: site }), 'publishable_key_required');
    await expect(app.inject({ method: 'GET', url: `${base}/products?key=pk_test_AAAAAAAAAAAAAAAAAAAAAAAA`, headers: site }), 'invalid_publishable_key');
    await expect(app.inject({ method: 'GET', url: `${base}/products/nothing-here` }), 'not_found');
    await expect(app.inject({ method: 'POST', url: `${base}/gift-cards/balance`, payload: { code: 'NOPE' } }), 'gift_card_not_found');
    await expect(app.inject({ method: 'POST', url: `${base}/orders`, payload: { ...order, lines: [{ variantId: variant, quantity: 999 }] } }), 'out_of_stock');
    await expect(app.inject({ method: 'POST', url: `${base}/orders`, payload: { ...order, fulfillment: 'delivery', zone: 'Mars' } }), 'invalid_order');
    await expect(app.inject({ method: 'POST', url: `${base}/orders`, payload: { ...order, returnUrl: 'https://www.reefgoods.example/thanks' } }), 'invalid_return_url');
    const placed = (await app.inject({ method: 'POST', url: `${base}/orders`, payload: order, headers: { 'idempotency-key': 'k1' } })).json();
    await expect(app.inject({ method: 'POST', url: `${base}/orders`, payload: { ...order, note: 'different' }, headers: { 'idempotency-key': 'k1' } }), 'idempotency_key_reused');
    await expect(app.inject({ method: 'POST', url: `${base}/orders/${placed.number}/pay?t=${placed.token}` }), 'conflict');
    await f.db.query(`update tenants set store_settings = jsonb_set(store_settings, '{enabled}', 'false') where slug = $1`, [slug]);
    await expect(app.inject({ method: 'GET', url: `${base}/products` }), 'store_closed');
    // The rest are covered where they are made (connect.test.ts: keys, sites, limits, test and live; store.test.ts: the limits per visitor).
    for (const code of ['publishable_key_revoked', 'origin_not_allowed', 'test_key_on_live_store', 'live_key_on_test_store', 'secret_key_in_browser', 'hosted_only', 'request_in_progress', 'rate_limited', 'too_many_orders', 'too_many_requests', 'too_many_attempts', 'email_unavailable', 'internal_error']) {
      assert.ok(documented.has(code), code);
    }
    assert.equal(seen.size + 13, documented.size, 'every documented code is accounted for');
  }));
