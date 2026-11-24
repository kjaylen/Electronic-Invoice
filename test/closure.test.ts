/**
 * An owner deletes their business: it is closed at once (only owners get in,
 * to reopen it or take its records; tills, API keys, the store and anything
 * that issues or emails stop), can be reopened for 30 days with nothing lost,
 * and is then erased for good, every row and file, without touching any
 * other business.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { runHousekeepingOnce } from '../src/api/housekeeping.ts';
import { closureOf, eraseBusiness, eraseDueBusinesses, GRACE_DAYS } from '../src/db/closure.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { issueDocument } from '../src/pipeline/issue.ts';
import type { ObjectStore } from '../src/storage/objects.ts';
import { AUTHORIZED, invoiceRequest, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DAY = 86_400_000;

type Headers = Record<string, string>;
interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Headers; login: (email: string) => Promise<LightMyRequestResponse>; stored: Map<string, Buffer> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const type of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[type], AUTHORIZED);
  const mail = memoryMailer();
  // Files kept outside the database (product photos), as with S3.
  const stored = new Map<string, Buffer>();
  const objects: ObjectStore = {
    put: async (key, data) => void stored.set(key, data),
    get: async (key) => (stored.has(key) ? { data: stored.get(key)!, contentType: 'image/png' } : null),
    delete: async (key) => void stored.delete(key),
    publicUrl: () => null,
  };
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail, objectStore: objects });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = (email: string) => app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const owner = { ...CSRF, cookie: cookieFrom(await login('olive@shop.example')), 'x-business': slug };
  try {
    await fn({ f, app, mail, slug, owner, login, stored });
  } finally {
    await app.close();
    await f.close();
  }
}

/** One of everything a business gathers: people, a customer, a product with a photo, an open store with an order, documents, a payment, an expense, a gift card, a site, a collection, an API key. */
async function fill(c: Ctx) {
  const post = async (url: string, payload: Record<string, unknown>, headers: Headers = c.owner, expect = 201) => {
    const r = await c.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(r.statusCode, expect, `${url}: ${r.body}`);
    return r.json();
  };
  const put = async (url: string, payload: Record<string, unknown>) => {
    const r = await c.app.inject({ method: 'PUT', url, headers: c.owner, payload });
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    return r.json();
  };
  await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@shop.example', role: 'cashier', password: PASSWORD });
  await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Ada', email: 'ada@shop.example', role: 'admin', password: PASSWORD });
  const customer = await post('/v1/customers', { name: 'Dive Shop', tin: '654987', address: { street: '1 Reef Rd', city: 'Placencia', districtCode: '5' }, contact: { email: 'dive@example.test' } });
  const product = await post('/v1/products', { title: 'Reef Hoodie', status: 'active', variants: [{ price: '60.00', gstCategory: 'S', stock: 5 }] });
  await post(`/v1/products/${product.id}/images`, { dataBase64: PNG });
  await put('/v1/store-settings', { enabled: true, tagline: 'Fresh', delivery: { enabled: false, zones: [] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: '' }, cashOnDelivery: { enabled: false }, payAtPickup: { enabled: true } } });
  const order = await post(`/v1/store/${c.slug}/orders`, { lines: [{ variantId: product.variants[0].id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: { name: 'Bea Buyer', phone: '600 1234', email: 'bea@example.test' } }, { ...CSRF, 'idempotency-key': 'order-1' });
  const receipt = await post('/v1/documents', { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } });
  const invoice = await post('/v1/documents', { type: '01', customerId: customer.id, lines: [{ description: 'Tank fill', quantity: '2', unitCode: 'H87', unitPrice: '15', gstCategory: 'S' }], payment: { meansCode: '30', terms: 'Net 30' } });
  await post(`/v1/documents/${invoice.id}/payments`, { amount: '10.00', method: 'cash', paidOn: new Date().toISOString().slice(0, 10) });
  await post('/v1/expenses', { supplierName: 'BEL', date: new Date().toISOString().slice(0, 10), category: 'Electricity', total: '112.50', gstTreatment: 'standard' });
  await post('/v1/gift-cards', { amount: '50.00', source: 'given' });
  const site = (await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json().draft;
  site.pages = [{ slug: 'about', title: 'About us', sections: [] }];
  await put('/v1/store-site/draft', { site });
  await post('/v1/store-site/publish', {}, c.owner, 200);
  await post('/v1/collections', { title: 'Hoodies', products: [product.handle] });
  const key = await post('/v1/api-keys', { name: 'Till software' });
  return { customer, product, order, receipt, invoice, apiKey: key.key as string };
}

/** How many rows each table holds for a business (tables that carry a tenant_id). */
async function rowsOf(c: Ctx, tenantId: string): Promise<Record<string, number>> {
  const tables = (await c.f.db.query<{ t: string }>(`select table_name::text as t from information_schema.columns where table_schema = current_schema() and column_name = 'tenant_id' order by 1`)).rows.map((r) => r.t);
  const out: Record<string, number> = {};
  for (const t of tables) {
    const n = (await c.f.db.query<{ n: number }>(`select count(*)::int as n from "${t}" where tenant_id = $1`, [tenantId])).rows[0]!.n;
    if (n) out[t] = n;
  }
  return out;
}

test('closing a business: owners only, on purpose; then it is shut to everyone and everything but its owner, who can reopen it', () =>
  withBusiness(async (c) => {
    const made = await fill(c);
    const name = (await c.app.inject({ method: 'GET', url: '/v1/business', headers: c.owner })).json().legalName as string;
    const close = (headers: Headers, payload: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/business/close', headers, payload });
    const as = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await c.login(email)), 'x-business': c.slug });
    const cashier = await as('cass@shop.example');
    const admin = await as('ada@shop.example');
    const api = { authorization: `Bearer ${made.apiKey}` };

    // Not an admin, not a cashier, not an API key; not without the name; not without the password.
    for (const who of [admin, cashier, api]) assert.equal((await close(who, { password: PASSWORD, name })).statusCode, 403);
    assert.equal((await close(c.owner, { password: PASSWORD, name: 'Something else' })).json().error.code, 'name_mismatch');
    assert.equal((await close(c.owner, { password: 'not my password', name })).json().error.code, 'wrong_password');
    assert.equal(await closureOf(c.f.db, c.f.tenantA), null);

    c.mail.sent.length = 0;
    const before = Date.now();
    const closed = await close(c.owner, { password: PASSWORD, name: `  ${name.toUpperCase()} ` });
    assert.equal(closed.statusCode, 200, closed.body);
    const eraseAfter = Date.parse(closed.json().closed.eraseAfter);
    assert.ok(Math.abs(eraseAfter - (before + GRACE_DAYS * DAY)) < 60_000, 'erased 30 days from now');
    assert.equal((await close(c.owner, { password: PASSWORD, name })).statusCode, 403, 'closing is not among what a closed business allows');
    // The owners are told by email, with the date and how to undo it.
    const notice = c.mail.sent.find((m) => m.to === 'olive@shop.example');
    assert.ok(notice && /was closed and will be erased on/.test(notice.subject) && /sign in and reopen it/.test(notice.text ?? ''));

    // Everyone else is out, and cannot come back in.
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: cashier })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: admin })).statusCode, 401);
    const refused = await c.login('cass@shop.example');
    assert.deepEqual([refused.statusCode, refused.json().error.code], [403, 'business_closed']);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: api })).statusCode, 401, 'API keys stop');
    // The store is shut, and nothing new is issued by anything.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().error.code, 'store_closed');
    await assert.rejects(issueDocument(c.f.deps, c.f.tenantA, invoiceRequest()), /closed/);

    // The owner: sees that it is closed, may take the records, and nothing else.
    const today = new Date().toISOString().slice(0, 10);
    const session = (await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: c.owner })).json();
    assert.equal(Date.parse(session.business.closed.eraseAfter), eraseAfter);
    assert.equal(Date.parse((await c.app.inject({ method: 'GET', url: '/v1/business', headers: c.owner })).json().closed.eraseAfter), eraseAfter);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/reports/documents?from=${today.slice(0, 8)}01&to=${today}`, headers: c.owner })).statusCode, 200);
    for (const [method, url] of [['GET', '/v1/documents'], ['GET', '/v1/customers'], ['POST', '/v1/customers'], ['PUT', '/v1/store-settings'], ['GET', '/v1/users']] as const) {
      const r = await c.app.inject({ method, url, headers: c.owner, payload: {} });
      assert.deepEqual([r.statusCode, r.json().error.code], [403, 'business_closed'], `${method} ${url}`);
    }
    // An owner signing in afresh gets in (to the same closed business).
    const again = await as('olive@shop.example');
    assert.ok((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: again })).json().business.closed);

    // Not erased while it can still be reopened, whatever runs.
    assert.deepEqual(await eraseDueBusinesses(c.f.db, { now: new Date(eraseAfter - DAY) }), []);
    await assert.rejects(eraseBusiness(c.f.db, c.f.tenantA), /can still be reopened/);
    const kept = await rowsOf(c, c.f.tenantA);
    assert.ok(kept.documents === 2 && kept.orders === 1 && kept.users === 3);

    // Reopened: as it was. Only an owner can; then everyone is back.
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/business/reopen', headers: c.owner, payload: {} })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/business/reopen', headers: c.owner, payload: {} })).statusCode, 409);
    assert.equal(await closureOf(c.f.db, c.f.tenantA), null);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: await as('cass@shop.example') })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: api })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).statusCode, 200);
    // Nothing was lost (the activity log has grown: it records the reopening and the sign-ins; so may the developer log, which notes what the API key asked).
    const { audit_events: logBefore, api_requests: _asked, ...keptRecords } = kept;
    const { audit_events: logAfter, api_requests: _askedSince, ...records } = await rowsOf(c, c.f.tenantA);
    assert.deepEqual(records, keptRecords);
    assert.ok(logAfter! > logBefore!);
    const log = (await c.f.db.query<{ action: string }>(`select action from audit_events where tenant_id = $1 and action like 'business.%' order by id`, [c.f.tenantA])).rows.map((r) => r.action);
    assert.deepEqual(log, ['business.close_refused', 'business.closed', 'business.reopened']);
  }));

test('thirty days after closing, the business is erased for good: every row and file of it, and nothing of anyone else', () =>
  withBusiness(async (c) => {
    await fill(c);
    // Another business with records of its own, which must not be touched.
    await issueDocument(c.f.deps, c.f.tenantB, invoiceRequest());
    await createUser(c.f.db, { tenantId: c.f.tenantB, name: 'Bo', email: 'bo@other.example', role: 'owner', password: PASSWORD });
    const others = await rowsOf(c, c.f.tenantB);
    assert.ok(others.documents === 1 && others.users === 1);
    assert.equal(c.stored.size, 1, 'the product photo is kept outside the database');
    const mine = await rowsOf(c, c.f.tenantA);
    for (const table of ['documents', 'invoice_payments', 'audit_events', 'orders', 'products', 'product_images', 'customers', 'expenses', 'gift_cards', 'store_sites', 'store_collections', 'api_keys', 'users']) assert.ok(mine[table], `${table} has rows to erase`);

    const name = (await c.app.inject({ method: 'GET', url: '/v1/business', headers: c.owner })).json().legalName as string;
    const closed = (await c.app.inject({ method: 'POST', url: '/v1/business/close', headers: c.owner, payload: { password: PASSWORD, name } })).json().closed;
    const due = new Date(Date.parse(closed.eraseAfter) + 1000);

    // The day comes: housekeeping erases it.
    let erased: Awaited<ReturnType<typeof eraseDueBusinesses>> = [];
    const failures: unknown[] = [];
    await runHousekeepingOnce(c.f.db, { eraseClosed: async () => { erased = await eraseDueBusinesses(c.f.db, { now: due, objects: { put: async () => {}, get: async () => null, publicUrl: () => null, delete: async (key) => void c.stored.delete(key) }, onError: (_id, e) => failures.push(e) }); }, onError: (_step, e) => failures.push(e) });
    assert.deepEqual(failures, []);
    assert.equal(erased.length, 1);
    assert.equal(erased[0]!.slug, c.slug);
    assert.ok(erased[0]!.rows > 20);
    assert.equal(erased[0]!.files, 1);
    assert.equal(c.stored.size, 0, 'its files are gone too');

    // Nothing of it is left anywhere; the other business has everything it had.
    assert.equal((await c.f.db.query('select 1 from tenants where id = $1', [c.f.tenantA])).rows.length, 0);
    assert.deepEqual(await rowsOf(c, c.f.tenantA), {});
    for (const [table, column] of [['document_lines', 'document_id'], ['submissions', 'document_id'], ['sessions', 'user_id']] as const) {
      const parent = column === 'user_id' ? 'users' : 'documents';
      assert.equal((await c.f.db.query(`select 1 from ${table} x where not exists (select 1 from ${parent} p where p.id = x.${column})`)).rows.length, 0, `no ${table} left behind`);
    }
    assert.deepEqual(await rowsOf(c, c.f.tenantB), others);
    assert.equal((await c.f.db.query<{ n: number }>('select count(*)::int as n from document_lines')).rows[0]!.n > 0, true, "the other business's document lines are still there");

    // Its address answers as if it had never been, and can be taken again; the owner's session is no more.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/auth/business/${c.slug}`, headers: CSRF })).statusCode, 404);
    assert.equal((await c.login('olive@shop.example')).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: c.owner })).statusCode, 401);
    // What stays, for good: that it was erased.
    const record = (await c.f.db.query<{ details: { slug: string; name: string } }>(`select details from platform_audit where action = 'tenant.erased'`)).rows;
    assert.equal(record.length, 1);
    assert.equal(record[0]!.details.slug, c.slug);
    // The rules that make records permanent are back in force for everyone else.
    await assert.rejects(c.f.db.query('delete from documents where tenant_id = $1', [c.f.tenantB]), /permanent records/);
    await assert.rejects(c.f.db.query('delete from platform_audit'), /permanent records/);
    await assert.rejects(c.f.db.query(`update platform_audit set action = 'x'`), /permanent records/);
  }));
