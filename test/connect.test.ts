/**
 * A site built somewhere else, connected to a store: publishable keys, which
 * sites may call the store API from a browser, what the answers give such a
 * site (full addresses, pages), and coming back to it after paying online.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { isLocalOrigin, normalizeOrigin } from '../src/commerce/connect.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const SITE = 'https://www.reefgoods.example';
const LOCAL = 'http://localhost:5500';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  slug: string;
  owner: Record<string, string>;
  variants: string[];
  /** A request as a browser on another site sends it. */
  from: (origin: string, url: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; key?: string; payload?: unknown; headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;
  newKey: (body?: Record<string, unknown>) => Promise<{ id: string; key: string; origins: string[]; mode: string }>;
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withSite(fn: (c: Ctx) => Promise<void>, appOptions: { storeRateLimitPerMinute?: number } = {}) {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: memoryMailer(), ...appOptions });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
  const settings = await app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: owner,
    payload: { enabled: true, delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '8.00' }] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank 123' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: true, provider: 'test' } } },
  });
  assert.equal(settings.statusCode, 200, settings.body);
  const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 10 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 10 }] } });
  assert.equal(product.statusCode, 201, product.body);
  const from: Ctx['from'] = (origin, url, init = {}) => app.inject({
    method: init.method ?? 'GET', url,
    headers: { origin, host: 'app.example.test', ...(init.key && { authorization: `Bearer ${init.key}` }), ...init.headers },
    ...(init.payload !== undefined && { payload: init.payload as object }),
  });
  const newKey: Ctx['newKey'] = async (body = {}) => {
    const res = await app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: owner, payload: { name: 'My website', ...body } });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  try {
    await fn({ f, app, slug, owner, variants: product.json().variants.map((v: { id: string }) => v.id), from, newKey });
  } finally {
    await app.close();
    await f.close();
  }
}

const code = (res: LightMyRequestResponse) => res.json().error?.code;

test('site addresses: cleaned up to what browsers send, and refused with a reason', () => {
  assert.equal(normalizeOrigin('www.Example.bz', 'live'), 'https://www.example.bz');
  assert.equal(normalizeOrigin(' https://example.bz/shop/index.html?x=1 ', 'live'), 'https://example.bz');
  assert.equal(normalizeOrigin('https://example.bz:8443', 'live'), 'https://example.bz:8443');
  assert.equal(normalizeOrigin('http://localhost:3000/', 'test'), 'http://localhost:3000');
  assert.throws(() => normalizeOrigin('http://example.bz', 'live'), /must use https/);
  assert.throws(() => normalizeOrigin('http://example.bz', 'test'), /only for a site on your own computer/);
  assert.throws(() => normalizeOrigin('https://*.example.bz', 'live'), /wildcards/);
  assert.throws(() => normalizeOrigin('ftp://example.bz', 'live'), /starts with https/);
  assert.throws(() => normalizeOrigin('https://user:pw@example.bz', 'live'), /user name/);
  assert.throws(() => normalizeOrigin('intranet', 'live'), /not a full site address/);
  assert.throws(() => normalizeOrigin('   ', 'live'), /Enter the address/);
  for (const o of ['http://localhost', 'http://localhost:8080', 'http://127.0.0.1:5500', 'http://[::1]:3000', 'https://shop.localhost', 'null']) assert.ok(isLocalOrigin(o), o);
  for (const o of ['https://example.bz', 'http://localhost.example.bz', 'https://127.0.0.1.example.bz', 'nonsense']) assert.ok(!isLocalOrigin(o), o);
});

test('publishable keys: made, listed, changed and revoked by owners, never with an API key', () =>
  withSite(async (c) => {
    const empty = (await c.app.inject({ method: 'GET', url: '/v1/publishable-keys', headers: c.owner })).json();
    assert.deepEqual(empty.data, []);
    assert.equal(empty.mode, 'test');
    assert.equal(empty.store, c.slug);
    assert.equal(empty.storeOpen, true);
    assert.equal(empty.apiUrl, `https://app.example.test/v1/store/${c.slug}`);
    assert.equal(empty.embedUrl, 'https://app.example.test/embed.js');

    const key = await c.newKey({ origins: ['www.reefgoods.example', 'https://www.reefgoods.example/shop'] });
    assert.match(key.key, /^pk_test_[A-Za-z0-9]{24}$/);
    assert.equal(key.mode, 'test');
    assert.deepEqual(key.origins, [SITE], 'cleaned up, and the same site once');

    const bad = await c.app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: c.owner, payload: { name: 'x', origins: ['http://shop.example'] } });
    assert.equal(bad.statusCode, 422);
    assert.equal(code(bad), 'invalid_origin');

    const patched = await c.app.inject({ method: 'PATCH', url: `/v1/publishable-keys/${key.id}`, headers: c.owner, payload: { name: 'Main site', origins: [SITE, 'https://reefgoods.example'] } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json().origins, [SITE, 'https://reefgoods.example']);
    assert.equal(patched.json().key, key.key, 'the key itself never changes');

    // Saving the store's settings (the Settings page sends back what it loaded) neither shows nor loses the keys.
    const loaded = (await c.app.inject({ method: 'GET', url: '/v1/store-settings', headers: c.owner })).json();
    assert.equal(loaded.connect, undefined);
    const { slug: _slug, ...body } = loaded;
    const saved = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { ...body, tagline: 'From the reef' } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().connect, undefined);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/publishable-keys', headers: c.owner })).json().data.length, 1);

    // Not with an API key, and not by staff who do not manage keys.
    const secret = (await createApiKey(c.f.db, c.f.tenantA, 'POS')).key;
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/publishable-keys', headers: { authorization: `Bearer ${secret}` } })).statusCode, 403);
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@shop.example', role: 'cashier', password: PASSWORD });
    const cashier = { ...CSRF, 'x-business': c.slug, cookie: cookieFrom(await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: c.slug, login: 'cash@shop.example', password: PASSWORD } })) };
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: cashier, payload: { name: 'x' } })).statusCode, 403);

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/publishable-keys/${key.id}`, headers: c.owner })).statusCode, 204);
    const after = (await c.app.inject({ method: 'GET', url: '/v1/publishable-keys', headers: c.owner })).json().data;
    assert.ok(after[0].revokedAt, 'kept in the list, marked revoked');
    assert.equal((await c.app.inject({ method: 'PATCH', url: `/v1/publishable-keys/${key.id}`, headers: c.owner, payload: { name: 'again' } })).statusCode, 422);
    assert.equal((await c.app.inject({ method: 'DELETE', url: '/v1/publishable-keys/00000000-0000-4000-8000-000000000000', headers: c.owner })).statusCode, 404);

    for (let i = 0; i < 10; i++) await c.newKey({ name: `Key ${i}` });
    const eleventh = await c.app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: c.owner, payload: { name: 'One too many' } });
    assert.equal(eleventh.statusCode, 409);
    assert.equal(code(eleventh), 'too_many_keys');

    const log = (await c.f.db.query<{ action: string }>(`select action from audit_events where action like 'publishable_key.%' order by id`)).rows.map((r) => r.action);
    assert.deepEqual(log.slice(0, 3), ['publishable_key.created', 'publishable_key.updated', 'publishable_key.revoked']);
  }));

test('the store API from another site: a key from an allowed site, and refusals a page can read', () =>
  withSite(async (c) => {
    const products = `/v1/store/${c.slug}/products`;
    const key = await c.newKey();

    // As before: no Origin (a server, curl), or a page of the app itself.
    const plain = await c.app.inject({ method: 'GET', url: products });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers['access-control-allow-origin'], undefined);
    const own = await c.from('https://app.example.test', products);
    assert.equal(own.statusCode, 200);
    assert.equal(own.headers['access-control-allow-origin'], undefined);
    const till = await c.from('capacitor://localhost', products);
    assert.equal(till.statusCode, 200, 'the till apps are this app too');

    // The browser asks first; the answer never allows cookies.
    const preflight = await c.app.inject({ method: 'OPTIONS', url: `/v1/store/${c.slug}/quote`, headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], SITE);
    assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/);
    assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
    assert.equal((await c.app.inject({ method: 'OPTIONS', url: '/v1/orders', headers: { origin: SITE, 'access-control-request-method': 'GET' } })).headers['access-control-allow-origin'], undefined, 'only the store API');

    // No key: refused, and the page can read why.
    const none = await c.from(SITE, products);
    assert.equal(none.statusCode, 401);
    assert.equal(code(none), 'publishable_key_required');
    assert.equal(none.headers['access-control-allow-origin'], SITE);
    assert.match(String(none.headers.vary), /Origin/);

    // A test key: any site on the developer's own computer, and a page opened from a file.
    for (const origin of [LOCAL, 'http://127.0.0.1:8080', 'null']) {
      const res = await c.from(origin, products, { key: key.key });
      assert.equal(res.statusCode, 200, `${origin}: ${res.body}`);
      assert.equal(res.headers['access-control-allow-origin'], origin);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      assert.equal(res.json().data.length, 1);
    }
    // The key in the address (no preflight for a GET) or in X-Floreo-Key works the same.
    assert.equal((await c.from(LOCAL, `${products}?key=${key.key}&limit=5`)).statusCode, 200);
    assert.equal((await c.from(LOCAL, products, { headers: { 'x-floreo-key': key.key } })).statusCode, 200);

    // Any other site has to be on the key's list.
    const stranger = await c.from(SITE, products, { key: key.key });
    assert.equal(stranger.statusCode, 403);
    assert.equal(code(stranger), 'origin_not_allowed');
    assert.match(stranger.json().error.message, /https:\/\/www\.reefgoods\.example is not on the list of sites of the key "My website"/);
    await c.app.inject({ method: 'PATCH', url: `/v1/publishable-keys/${key.id}`, headers: c.owner, payload: { origins: [SITE] } });
    const listed = await c.from(SITE, products, { key: key.key });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.headers['x-ratelimit-limit'], '300');
    assert.equal((await c.from('https://evil.example', products, { key: key.key })).statusCode, 403);
    assert.equal((await c.from('https://www.reefgoods.example.evil.example', products, { key: key.key })).statusCode, 403, 'the whole address, not its start');

    // Writing works the same way.
    const quote = await c.from(SITE, `/v1/store/${c.slug}/quote`, { method: 'POST', key: key.key, payload: { lines: [{ variantId: c.variants[0], quantity: 2 }], fulfillment: 'pickup' } });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().totals.total, '90.00');

    // Wrong keys, each with its own reason.
    assert.equal(code(await c.from(SITE, products, { key: 'pk_test_AAAAAAAAAAAAAAAAAAAAAAAA' })), 'invalid_publishable_key');
    assert.equal(code(await c.from(SITE, products, { headers: { 'x-floreo-key': 'my-key' } })), 'invalid_publishable_key');
    const secret = (await createApiKey(c.f.db, c.f.tenantA, 'POS')).key;
    const leaked = await c.from(SITE, products, { key: secret });
    assert.equal(leaked.statusCode, 403);
    assert.equal(code(leaked), 'secret_key_in_browser');
    assert.equal((await c.app.inject({ method: 'GET', url: products, headers: { authorization: `Bearer ${secret}` } })).statusCode, 200, 'from a server it is ignored, as before');
    // A server may send the publishable key too; a wrong one is still refused.
    assert.equal((await c.app.inject({ method: 'GET', url: products, headers: { authorization: `Bearer ${key.key}` } })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: `${products}?key=pk_test_AAAAAAAAAAAAAAAAAAAAAAAA` })).statusCode, 401);

    // Another store's key opens nothing here.
    const other = (await c.f.db.query<{ slug: string }>('select slug from tenants where id = $1', [c.f.tenantB])).rows[0]!.slug;
    assert.equal(code(await c.from(LOCAL, `/v1/store/${other}/products`, { key: key.key })), 'invalid_publishable_key');
    assert.equal((await c.from(LOCAL, '/v1/store/no-such-store/products', { key: key.key })).statusCode, 404);

    // Photos are public and cached for a year: any page may use them.
    assert.equal((await c.from(SITE, `/v1/store/${c.slug}/images/00000000-0000-4000-8000-000000000000`)).headers['access-control-allow-origin'], '*');

    // Buyer accounts sign in with a cookie of the app: not from another site.
    const account = await c.from(SITE, `/v1/store/${c.slug}/account`, { key: key.key });
    assert.equal(account.statusCode, 403);
    assert.equal(code(account), 'hosted_only');

    // Revoked: sites using it stop at once.
    await c.app.inject({ method: 'DELETE', url: `/v1/publishable-keys/${key.id}`, headers: c.owner });
    const revoked = await c.from(SITE, products, { key: key.key });
    assert.equal(revoked.statusCode, 401);
    assert.equal(code(revoked), 'publishable_key_revoked');
  }));

test('test and live are kept apart: a test key stops when the store goes live', () =>
  withSite(async (c) => {
    const products = `/v1/store/${c.slug}/products`;
    const testKey = await c.newKey({ origins: [SITE] });
    assert.equal((await c.from(SITE, products, { key: testKey.key })).statusCode, 200);

    await c.f.db.query(`update tenants set environment = 'production' where id = $1`, [c.f.tenantA]);
    const stale = await c.from(SITE, products, { key: testKey.key });
    assert.equal(stale.statusCode, 403);
    assert.equal(code(stale), 'test_key_on_live_store');
    assert.match(stale.json().error.message, /Make a live key/);

    const live = await c.newKey({ name: 'Live site', origins: [SITE] });
    assert.match(live.key, /^pk_live_/);
    assert.equal(live.mode, 'live');
    assert.equal((await c.from(SITE, products, { key: live.key })).statusCode, 200);
    // A live key is for its sites only: not localhost, not a file.
    assert.equal(code(await c.from(LOCAL, products, { key: live.key })), 'origin_not_allowed');
    assert.equal(code(await c.from('null', products, { key: live.key })), 'origin_not_allowed');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: c.owner, payload: { name: 'x', origins: ['http://www.reefgoods.example'] } })).statusCode, 422, 'live sites use https');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/publishable-keys', headers: c.owner })).json().mode, 'live');

    await c.f.db.query(`update tenants set environment = 'test' where id = $1`, [c.f.tenantA]);
    assert.equal(code(await c.from(SITE, products, { key: live.key })), 'live_key_on_test_store');
  }));

test('requests per minute for one key from one visitor', () =>
  withSite(async (c) => {
    const key = await c.newKey();
    const products = `/v1/store/${c.slug}/products?key=${key.key}`;
    for (let i = 0; i < 3; i++) assert.equal((await c.from(LOCAL, products)).statusCode, 200);
    const over = await c.from(LOCAL, products);
    assert.equal(over.statusCode, 429);
    assert.equal(code(over), 'rate_limited');
    assert.equal(over.headers['retry-after'], '60');
    assert.equal(over.headers['x-ratelimit-remaining'], '0');
    assert.equal(over.headers['access-control-allow-origin'], LOCAL, 'readable from the page');
    // Another visitor, and a server sending the key, are not held up.
    assert.equal((await c.app.inject({ method: 'GET', url: products, remoteAddress: '203.0.113.9', headers: { origin: LOCAL, host: 'app.example.test' } })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: products })).statusCode, 200);
  }, { storeRateLimitPerMinute: 3 }));

test('answers a site can use: full addresses, the store without its design, pages of products', () =>
  withSite(async (c) => {
    const base = `https://app.example.test`;
    const info = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/info` })).json();
    assert.equal(info.slug, c.slug);
    assert.equal(info.currency, 'BZD');
    assert.equal(info.test, true);
    assert.deepEqual(info.payments, { bankTransfer: true, cashOnDelivery: true, payAtPickup: true, online: 'test' });
    assert.deepEqual(info.delivery.zones, [{ name: 'Belize City', fee: '9.00' }]);
    assert.deepEqual(info.urls, { store: `${base}/${c.slug}/shop`, cart: `${base}/${c.slug}/shop/cart`, account: `${base}/${c.slug}/shop/account`, api: `${base}/v1/store/${c.slug}` });
    assert.equal(info.site, undefined);
    assert.equal(info.theme, undefined);
    // The hosted store's own answer keeps everything it had, and gains the addresses.
    const full = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json();
    assert.ok(full.site && typeof full.theme === 'object');
    for (const k of Object.keys(info)) assert.deepEqual(full[k], info[k], k);

    for (const title of ['Hot sauce', 'Sunscreen', 'Beach towel', 'Sandals']) {
      const res = await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title, status: 'active', variants: [{ price: '10.00', gstCategory: 'S' }] } });
      assert.equal(res.statusCode, 201, res.body);
    }
    const all = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products?sort=title` })).json();
    assert.equal(all.data.length, 5);
    assert.equal(all.nextCursor, null, 'without a limit, everything as before');
    const first = all.data[0];
    assert.equal(first.url, `${base}/${c.slug}/shop/products/${first.handle}`);
    assert.equal(first.imageUrl, null);
    assert.equal(first.imageId, null);

    // Two at a time until there is no more: every product once, in order.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { data: Array<{ title: string }>; nextCursor: string | null } = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products?sort=title&limit=2${cursor ? `&cursor=${cursor}` : ''}` })).json();
      seen.push(...page.data.map((p) => p.title));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, all.data.map((p: { title: string }) => p.title));
    const badCursor = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products?cursor=abc` });
    assert.equal(badCursor.statusCode, 400);
    assert.match(badCursor.json().error.message, /nextCursor/);

    const product = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products/island-t-shirt` })).json();
    assert.equal(product.url, `${base}/${c.slug}/shop/products/island-t-shirt`);
    assert.deepEqual(product.imageUrls, []);
    assert.deepEqual(product.images, []);
  }));

test('paying online from another site: the buyer comes back to it, and the order is paid', () =>
  withSite(async (c) => {
    const key = await c.newKey({ origins: [SITE] });
    const body = { lines: [{ variantId: c.variants[0], quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'online', customer: { name: 'Ana Buyer', phone: '+501 610-0000', email: 'ana@example.com' } };
    const orders = `/v1/store/${c.slug}/orders`;

    // Only to a site on the key's list, and only with a key.
    const elsewhere = await c.from(SITE, orders, { method: 'POST', key: key.key, payload: { ...body, returnUrl: 'https://evil.example/thanks' } });
    assert.equal(elsewhere.statusCode, 422);
    assert.equal(code(elsewhere), 'invalid_return_url');
    const keyless = await c.app.inject({ method: 'POST', url: orders, payload: { ...body, returnUrl: `${SITE}/thanks` } });
    assert.equal(keyless.statusCode, 422);
    assert.equal(code(keyless), 'invalid_return_url');
    assert.equal((await c.f.db.query('select 1 from orders')).rows.length, 0, 'nothing was ordered by the refused requests');

    const placed = await c.from(SITE, orders, { method: 'POST', key: key.key, payload: { ...body, returnUrl: `${SITE}/shop.html?page=thanks` } });
    assert.equal(placed.statusCode, 201, placed.body);
    const o = placed.json();
    assert.equal(o.test, true);
    assert.equal(o.orderUrl, `https://app.example.test/${c.slug}/shop/orders/${o.number}?t=${o.token}`);
    assert.equal(o.path, `/${c.slug}/shop/orders/${o.number}?t=${o.token}`, 'the old field is still there');
    assert.equal(o.payment.redirectUrl, `/${c.slug}/shop/pay/${o.payment.paymentId}`, 'as before');
    assert.equal(o.payment.url, `https://app.example.test/${c.slug}/shop/pay/${o.payment.paymentId}`, 'and as a full address');

    // The pretend card page approves, and learns where the buyer came from.
    const decided = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${o.payment.paymentId}`, payload: { decision: 'approved' } });
    assert.equal(decided.statusCode, 200, decided.body);
    const back = new URL(decided.json().returnUrl);
    assert.equal(back.origin + back.pathname, `${SITE}/shop.html`);
    assert.equal(back.searchParams.get('page'), 'thanks', 'the site\'s own query is kept');
    assert.equal(back.searchParams.get('floreo_order'), String(o.number));
    assert.equal(back.searchParams.get('floreo_token'), o.token);
    assert.equal(back.searchParams.get('floreo_payment'), o.payment.paymentId);

    // Back on the site: it asks whether the payment went through, then shows the order.
    const confirm = await c.from(SITE, `/v1/store/${c.slug}/orders/${o.number}/payments/${o.payment.paymentId}/confirm?t=${o.token}`, { method: 'POST', key: key.key });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(confirm.json().status, 'paid');
    const order = (await c.from(SITE, `/v1/store/${c.slug}/orders/${o.number}?t=${o.token}`, { key: key.key })).json();
    assert.equal(order.paymentStatus, 'paid');
    assert.equal(order.test, true);
    assert.equal(order.orderUrl, o.orderUrl);
    assert.equal(order.document.pdfUrl, `https://app.example.test/v1/store/${c.slug}/orders/${o.number}/document?t=${o.token}`);

    // Trying again from the site (a declined card) takes a returnUrl too; without one, back to the hosted order page as before.
    const second = (await c.from(SITE, orders, { method: 'POST', key: key.key, payload: body })).json();
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${second.payment.paymentId}`, payload: { decision: 'declined' } })).json().returnUrl, null);
    await c.from(SITE, `/v1/store/${c.slug}/orders/${second.number}/payments/${second.payment.paymentId}/confirm?t=${second.token}`, { method: 'POST', key: key.key });
    const retry = await c.from(SITE, `/v1/store/${c.slug}/orders/${second.number}/pay?t=${second.token}`, { method: 'POST', key: key.key, payload: { returnUrl: `${SITE}/thanks` } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.match(retry.json().url, /^https:\/\/app\.example\.test\//);
    assert.match((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/test-payments/${retry.json().paymentId}`, payload: { decision: 'approved' } })).json().returnUrl, /^https:\/\/www\.reefgoods\.example\/thanks\?floreo_order=/);
  }));
