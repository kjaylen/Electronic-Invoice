/**
 * Secret API keys that may do less than everything: read-only keys, keys for
 * some parts of the API, keys that end on a day. And that a key made without
 * choosing any of that is what a key always was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { areaOfRoute, assertRouteHasArea, expiryFromDay, KEY_AREAS } from '../src/api/key-scope.ts';
import { belizeDay } from '../src/api/devlog.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PRODUCT = { title: 'Island T-shirt', status: 'active', variants: [{ price: '40.00', gstCategory: 'S' }] };
const RECEIPT = { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } };

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  owner: Record<string, string>;
  /** Make a key as the owner does; answers what the route answers. */
  make: (body: Record<string, unknown>) => Promise<LightMyRequestResponse>;
  /** A request with a secret key. */
  call: (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
}

async function withKeys(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: memoryMailer() });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const owner = { ...CSRF, 'x-business': slug, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } })) };
    await fn({
      f, app, owner,
      make: (body) => app.inject({ method: 'POST', url: '/v1/api-keys', headers: owner, payload: body }),
      call: (key, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload !== undefined && { payload: payload as object }) }),
    });
  } finally {
    await app.close();
    await f.close();
  }
}

const error = (res: LightMyRequestResponse) => [res.statusCode, res.json().error?.code];

test('every part of the API a key can reach has an area; a route with none stops the server from starting', () => {
  assert.equal(areaOfRoute('/v1/documents/:id/pdf'), 'documents');
  assert.equal(areaOfRoute('/v1/orders'), 'orders');
  assert.equal(areaOfRoute('/v1/store-settings'), 'catalog');
  assert.equal(areaOfRoute('/v1/inventory.csv'), 'catalog');
  assert.equal(areaOfRoute('/v1/reports/gst-return.pdf'), 'reports');
  assert.equal(areaOfRoute('/v1/me/pin'), 'business');
  assert.equal(areaOfRoute('/v1/api-keys/:id'), 'people');
  assert.equal(areaOfRoute('/v1/brand-new/:id'), undefined);
  assert.throws(() => assertRouteHasArea('/v1/brand-new/:id'), /belongs to no API key area\. Add "brand-new" to AREA_OF/);
  assert.doesNotThrow(() => assertRouteHasArea('/v1/webhooks/:id/test'));
});

test('the last day a key works: through that day in Belize, and never a day already over', () => {
  const now = new Date('2026-11-24T18:00:00Z');
  assert.equal(expiryFromDay('2026-11-24', now).toISOString(), '2026-11-25T05:59:59.999Z', 'the end of the day in Belize, six hours behind');
  assert.equal(expiryFromDay('2027-01-31', now).toISOString(), '2027-02-01T05:59:59.999Z');
  assert.throws(() => expiryFromDay('2026-11-23', now), /today or later/);
  assert.throws(() => expiryFromDay('2026-13-45', now), /not a date/);
});

test('a key made without choosing is what a key always was; what a key may do is shown to its owner and to the key', () =>
  withKeys(async (c) => {
    const plain = await c.make({ name: 'Our ERP' });
    assert.equal(plain.statusCode, 201, plain.body);
    assert.deepEqual({ access: plain.json().access, areas: plain.json().areas, expiresAt: plain.json().expiresAt, expired: plain.json().expired }, { access: 'full', areas: null, expiresAt: null, expired: false });
    // Made by other means (the admin route, an older version): the same.
    const older = (await createApiKey(c.f.db, c.f.tenantA, 'From before')).key;
    for (const key of [plain.json().key, older]) {
      assert.equal((await c.call(key, 'POST', '/v1/customers', { name: 'Island Logistics Ltd.' })).statusCode, 201);
      assert.equal((await c.call(key, 'GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30')).statusCode, 200);
      assert.equal((await c.call(key, 'POST', '/v1/products', PRODUCT)).statusCode, 201);
      const me = (await c.call(key, 'GET', '/v1/me')).json();
      assert.deepEqual({ access: me.apiKey.access, areas: me.apiKey.areas, expiresAt: me.apiKey.expiresAt }, { access: 'full', areas: null, expiresAt: null });
    }
    assert.equal((await c.call(plain.json().key, 'GET', '/v1/me')).json().apiKey.name, 'Our ERP');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: c.owner })).json().apiKey, undefined, 'a person signed in is not a key');

    // Choosing every area is the same as not choosing.
    assert.equal((await c.make({ name: 'All of it', areas: [...KEY_AREAS] })).json().areas, null);
    // The list: each key with what it may do, and the areas on offer with what they cover.
    assert.equal((await c.make({ name: 'Reports only', access: 'read', areas: ['reports', 'documents'], expiresOn: '2099-12-31' })).statusCode, 201);
    const list = (await c.app.inject({ method: 'GET', url: '/v1/api-keys', headers: c.owner })).json();
    const reports = list.data.find((k: { name: string }) => k.name === 'Reports only');
    assert.deepEqual({ access: reports.access, areas: reports.areas, expiresAt: reports.expiresAt, expired: reports.expired }, { access: 'read', areas: ['documents', 'reports'], expiresAt: '2100-01-01T05:59:59.999Z', expired: false });
    assert.deepEqual(list.areas.map((a: { id: string }) => a.id), [...KEY_AREAS]);
    assert.ok(list.areas.every((a: { name: string; covers: string }) => a.name && a.covers.length > 10));
    assert.equal(list.data.find((k: { name: string }) => k.name === 'From before').access, 'full');

    // What cannot be asked for.
    assert.deepEqual(error(await c.make({ name: 'x', areas: ['everything'] })), [400, 'invalid_request']);
    assert.deepEqual(error(await c.make({ name: 'x', areas: [] })), [400, 'invalid_request']);
    assert.deepEqual(error(await c.make({ name: 'x', access: 'write' })), [400, 'invalid_request']);
    assert.deepEqual(error(await c.make({ name: 'x', expiresOn: '2020-01-01' })), [422, 'invalid_expiry']);
    assert.deepEqual(error(await c.make({ name: 'x', expiresOn: 'next week' })), [400, 'invalid_request']);
    // A key cannot make keys, whatever it may do.
    assert.equal((await c.call(plain.json().key, 'POST', '/v1/api-keys', { name: 'Another' })).statusCode, 403);
    // The activity log says what a limited key was limited to.
    const logged = (await c.f.db.query<{ details: Record<string, unknown> | null }>(`select details from audit_events where action = 'apikey.created' and target = 'Reports only'`)).rows[0]!;
    assert.deepEqual(logged.details, { access: 'read', areas: ['documents', 'reports'], expiresOn: '2099-12-31' });
  }));

test('a read-only key looks at everything and changes nothing', () =>
  withKeys(async (c) => {
    const full = (await c.make({ name: 'Our ERP' })).json().key;
    const customer = (await c.call(full, 'POST', '/v1/customers', { name: 'Island Logistics Ltd.' })).json();
    const read = (await c.make({ name: 'Dashboard', access: 'read' })).json().key;

    for (const url of ['/v1/me', '/v1/customers', `/v1/customers/${customer.id}`, '/v1/documents', '/v1/items', '/v1/products', '/v1/orders?view=all', '/v1/reports/summary?from=2026-11-01&to=2026-11-30', '/v1/webhooks', '/v1/store-settings', '/v1/expenses']) {
      assert.equal((await c.call(read, 'GET', url)).statusCode, 200, url);
    }
    // Working something out is reading, though it is a POST.
    const preview = await c.call(read, 'POST', '/v1/documents/preview', RECEIPT);
    assert.equal(preview.statusCode, 200, preview.body);

    const refused: Array<['POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['POST', '/v1/customers', { name: 'Someone New' }], ['PUT', `/v1/customers/${customer.id}`, { name: 'Renamed' }], ['DELETE', `/v1/customers/${customer.id}`],
      ['POST', '/v1/documents', RECEIPT], ['POST', '/v1/products', PRODUCT], ['PUT', '/v1/store-settings', { enabled: true }],
      ['POST', '/v1/orders/00000000-0000-4000-8000-000000000000/paid'], ['POST', '/v1/webhooks', { url: 'https://example.com/hook', events: ['*'] }],
    ];
    for (const [method, url, payload] of refused) assert.deepEqual(error(await c.call(read, method, url, payload)), [403, 'key_read_only'], `${method} ${url}`);
    const said = (await c.call(read, 'POST', '/v1/customers', { name: 'Someone New' })).json().error.message;
    assert.equal(said, 'The key "Dashboard" is read-only, so it cannot POST /v1/customers. Use a key that may make changes (Settings → Developers).');
    // Nothing changed.
    const customers = (await c.call(full, 'GET', '/v1/customers')).json().data;
    assert.deepEqual(customers.map((x: { name: string }) => x.name), ['Island Logistics Ltd.']);
    assert.equal((await c.f.db.query('select 1 from documents')).rows.length, 0);
    assert.equal((await c.f.db.query('select 1 from products')).rows.length, 0);
    assert.equal((await c.call(read, 'GET', '/v1/me')).json().apiKey.access, 'read');
  }));

test('a key for some parts of the API is held to them, and says which part it is missing', () =>
  withKeys(async (c) => {
    const shop = (await c.make({ name: 'Website sync', areas: ['catalog', 'orders'] })).json().key;
    // Inside its areas: reading and changing.
    const product = await c.call(shop, 'POST', '/v1/products', PRODUCT);
    assert.equal(product.statusCode, 201, product.body);
    for (const url of ['/v1/products', `/v1/products/${product.json().id}`, '/v1/items', '/v1/inventory', '/v1/orders?view=all', '/v1/gift-cards', '/v1/store-settings', '/v1/collections']) {
      assert.equal((await c.call(shop, 'GET', url)).statusCode, 200, url);
    }
    // Asking who it is and what it may do is always answered.
    const me = (await c.call(shop, 'GET', '/v1/me')).json();
    assert.deepEqual(me.apiKey.areas, ['catalog', 'orders']);
    assert.equal(me.apiKey.name, 'Website sync');

    // Outside them: refused, reading too.
    for (const [method, url, area] of [
      ['GET', '/v1/customers', 'customers'], ['POST', '/v1/customers', 'customers'], ['GET', '/v1/documents', 'documents'], ['POST', '/v1/documents', 'documents'], ['POST', '/v1/documents/preview', 'documents'],
      ['GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30', 'reports'], ['GET', '/v1/expenses', 'expenses'], ['GET', '/v1/webhooks', 'webhooks'], ['GET', '/v1/business', 'business'], ['PUT', '/v1/me/pin', 'business'], ['GET', '/v1/receivables', 'documents'],
    ] as const) {
      const res = await c.call(shop, method, url, method === 'GET' ? undefined : {});
      assert.deepEqual(error(res), [403, 'key_scope'], `${method} ${url}`);
      assert.deepEqual(res.json().error.details, { needs: area, has: ['catalog', 'orders'] }, url);
    }
    assert.equal((await c.call(shop, 'GET', '/v1/customers')).json().error.message,
      'The key "Website sync" may not use Customers (GET /v1/customers). It is limited to: Catalogue, Orders. Make a key that includes Customers in Settings → Developers.');
    // What no key may do stays refused the way it was, and an address that is no endpoint is still just that.
    assert.deepEqual(error(await c.call(shop, 'GET', '/v1/users')), [403, 'forbidden']);
    assert.deepEqual(error(await c.call(shop, 'GET', '/v1/developer/requests')), [403, 'forbidden']);
    assert.equal((await c.call(shop, 'GET', '/v1/no-such-thing')).statusCode, 404);
    assert.equal((await c.f.db.query('select 1 from customers')).rows.length, 0);

    // Both limits at once: only reading, only reports.
    const reports = (await c.make({ name: 'Accountant export', access: 'read', areas: ['reports'] })).json().key;
    assert.equal((await c.call(reports, 'GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30')).statusCode, 200);
    assert.deepEqual(error(await c.call(reports, 'GET', '/v1/documents')), [403, 'key_scope']);
    assert.deepEqual(error(await c.call(reports, 'POST', '/v1/customers', { name: 'x' })), [403, 'key_read_only']);

    // The owner sees the refusals in the developer log, with the reason.
    const failed = (await c.app.inject({ method: 'GET', url: '/v1/developer/requests?errors=1&limit=200', headers: c.owner })).json().data as Array<{ code: string; path: string; key: { name: string } }>;
    assert.ok(failed.some((r) => r.code === 'key_scope' && r.path === '/v1/customers' && r.key.name === 'Website sync'));
    assert.ok(failed.some((r) => r.code === 'key_read_only' && r.key.name === 'Accountant export'));
  }));

test('a key that ends on a day works through it and not after', () =>
  withKeys(async (c) => {
    const made = await c.make({ name: 'Summer contractor', expiresOn: belizeDay() });
    assert.equal(made.statusCode, 201, made.body);
    const key = made.json().key;
    assert.equal(made.json().expired, false);
    assert.equal((await c.call(key, 'GET', '/v1/me')).statusCode, 200, 'today is its last day: it works');
    assert.match((await c.call(key, 'GET', '/v1/me')).json().apiKey.expiresAt, /^\d{4}-\d{2}-\d{2}T05:59:59\.999Z$/);

    // The day is over.
    await c.f.db.query(`update api_keys set expires_at = '2026-06-30T05:59:59.999Z' where id = $1`, [made.json().id]);
    for (const [method, url] of [['GET', '/v1/me'], ['GET', '/v1/customers'], ['POST', '/v1/customers']] as const) {
      const res = await c.call(key, method, url, method === 'GET' ? undefined : { name: 'x' });
      assert.deepEqual(error(res), [401, 'api_key_expired'], `${method} ${url}`);
      assert.equal(res.json().error.message, 'The key "Summer contractor" expired on 2026-06-30. Make a new one in Settings → Developers.');
    }
    assert.equal((await c.f.db.query('select 1 from customers')).rows.length, 0);
    const listed = (await c.app.inject({ method: 'GET', url: '/v1/api-keys', headers: c.owner })).json().data.find((k: { name: string }) => k.name === 'Summer contractor');
    assert.equal(listed.expired, true);
    // A wrong secret is still just a wrong key: nothing about the key is said to someone who does not hold it.
    assert.deepEqual(error(await c.call(`${key.slice(0, -4)}AAAA`, 'GET', '/v1/me')), [401, 'unauthorized']);
  }));

test('the reference says which part of the API each endpoint belongs to, and which a read-only key may use', () =>
  withKeys(async (c) => {
    const spec = (await c.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    const op = (path: string, method: string) => spec.paths[path][method] as { 'x-key-area'?: string; 'x-key-read-only'?: boolean };
    assert.deepEqual([op('/v1/orders/{id}/paid', 'post')['x-key-area'], op('/v1/orders/{id}/paid', 'post')['x-key-read-only']], ['orders', false]);
    assert.deepEqual([op('/v1/orders', 'get')['x-key-area'], op('/v1/orders', 'get')['x-key-read-only']], ['orders', true]);
    assert.deepEqual([op('/v1/documents/preview', 'post')['x-key-area'], op('/v1/documents/preview', 'post')['x-key-read-only']], ['documents', true], 'working something out is reading');
    assert.equal(op('/v1/store-settings', 'put')['x-key-area'], 'catalog');
    // Every endpoint for a business's own systems has one of the areas a key can be given; the store API (no secret key) has none.
    for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, { 'x-key-area'?: string }>>)) {
      for (const [method, o] of Object.entries(methods)) {
        if (path.startsWith('/v1/store/')) assert.equal(o['x-key-area'], undefined, `${method} ${path}`);
        else assert.ok((KEY_AREAS as readonly string[]).includes(o['x-key-area'] ?? ''), `${method} ${path} has no area`);
      }
    }
    assert.match(spec.info.description, /^## Limiting a secret key$/m);
    for (const said of ['key_read_only', 'key_scope', 'api_key_expired', ...KEY_AREAS.map((a) => `\`${a}\``)]) assert.ok(spec.info.description.includes(said), said);
  }));
