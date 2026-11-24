/**
 * What a business's integrations have been doing (Settings → Developers →
 * Logs): the latest requests made with its keys and their answers, and
 * counts by day, key, endpoint and error code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { belizeDay, createDevLog, pruneLoggedRequests } from '../src/api/devlog.ts';
import { runHousekeepingOnce } from '../src/api/housekeeping.ts';
import { closeBusiness, eraseBusiness } from '../src/db/closure.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const SITE = 'https://www.reefgoods.example';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('the developer log: requests made with secret and publishable keys, what they were answered, and counts by day', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: memoryMailer() });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const owner = { ...CSRF, 'x-business': slug, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } })) };
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/store-settings', headers: owner, payload: { enabled: true } })).statusCode, 200);
    const pk = (await app.inject({ method: 'POST', url: '/v1/publishable-keys', headers: owner, payload: { name: 'Main website', origins: [SITE] } })).json();
    const secret = await createApiKey(f.db, f.tenantA, 'Our ERP');
    const erp = { authorization: `Bearer ${secret.key}` };
    const from = (origin: string, url: string, key?: string) => app.inject({ method: 'GET', url, headers: { origin, host: 'app.example.test', ...(key && { authorization: `Bearer ${key}` }) } });
    const log = async (query = '') => (await app.inject({ method: 'GET', url: `/v1/developer/requests${query}`, headers: owner })).json();
    const usage = async () => (await app.inject({ method: 'GET', url: '/v1/developer/usage', headers: owner })).json();
    /** Counting happens after the answer is sent: wait for the counts to land. */
    const settled = async (requests: number) => {
      for (let i = 0; i < 100; i++) {
        if ((await usage()).totals.requests >= requests) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail('the counts never arrived');
    };

    // Nothing yet. The owner's own clicks in the app are not an integration's requests.
    assert.deepEqual((await log()).data, []);
    assert.deepEqual((await usage()).totals, { requests: 0, errors: 0 });

    // A server with the secret key: one that works, one that does not fit, one that is not there.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: erp })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/customers?limit=lots', headers: erp })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/orders/00000000-0000-4000-8000-000000000000', headers: erp })).statusCode, 404);
    // A site with the publishable key: allowed, from a site not on its list, and with no key at all.
    assert.equal((await from(SITE, `/v1/store/${slug}/products?limit=5`, pk.key)).statusCode, 200);
    assert.equal((await from('https://elsewhere.example', `/v1/store/${slug}/products`, pk.key)).statusCode, 403);
    assert.equal((await from(SITE, `/v1/store/${slug}/orders/1001?t=${'s'.repeat(32)}`)).statusCode, 401);
    await settled(6);

    const { data, keptDays, nextCursor } = await log();
    assert.equal(keptDays, 7);
    assert.equal(nextCursor, null);
    assert.deepEqual(data.map((r: { method: string; path: string; status: number; code: string | null }) => [r.method, r.path, r.status, r.code]), [
      ['GET', `/v1/store/${slug}/orders/1001`, 401, 'publishable_key_required'],
      ['GET', `/v1/store/${slug}/products`, 403, 'origin_not_allowed'],
      ['GET', `/v1/store/${slug}/products`, 200, null],
      ['GET', '/v1/orders/00000000-0000-4000-8000-000000000000', 404, 'not_found'],
      ['GET', '/v1/customers', 400, 'invalid_request'],
      ['GET', '/v1/me', 200, null],
    ], 'newest first; the address without its query (it can carry an order token)');
    assert.equal(JSON.stringify(data).includes('sssss'), false);
    assert.equal(data[1].message, 'https://elsewhere.example is not on the list of sites of the key "Main website". Add it in Settings → Developers → Publishable keys.');
    assert.equal(data[1].origin, 'https://elsewhere.example');
    assert.deepEqual(data[1].key, { kind: 'publishable', id: pk.id, name: 'Main website', revoked: false });
    assert.deepEqual(data[0].key, { kind: 'publishable', id: 'unknown', name: 'A key this store does not have', revoked: false });
    assert.equal(data[4].message, 'query parameter limit must be a whole number (digits only)');
    assert.equal(data[4].route, '/v1/customers');
    assert.equal(data[3].route, '/v1/orders/:id');
    assert.deepEqual(data[5].key, { kind: 'secret', id: secret.id, name: 'Our ERP', revoked: false });
    assert.equal(data[5].origin, null);
    assert.ok(Number.isInteger(data[5].ms));

    // Narrowed to what failed, and to one key.
    assert.equal((await log('?errors=1')).data.length, 4);
    assert.deepEqual((await log(`?key=${pk.id}`)).data.map((r: { status: number }) => r.status), [403, 200]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/developer/requests?errors=yes', headers: owner })).statusCode, 400);

    // Counts: by day (today last), by key, and what fails by endpoint and code.
    const u = await usage();
    assert.equal(u.days.length, 14);
    assert.deepEqual(u.days.at(-1), { date: belizeDay(), requests: 6, errors: 4 });
    assert.deepEqual(u.totals, { requests: 6, errors: 4 });
    assert.deepEqual(u.keys.map((k: { name: string; kind: string; requests: number; errors: number }) => [k.name, k.kind, k.requests, k.errors]).sort(), [
      ['A key this store does not have', 'publishable', 1, 1], ['Main website', 'publishable', 2, 1], ['Our ERP', 'secret', 3, 2],
    ]);
    assert.deepEqual(u.failures.map((x: { method: string; route: string; status: number; code: string; count: number }) => `${x.method} ${x.route} ${x.status} ${x.code} ×${x.count}`).sort(), [
      'GET /v1/customers 400 invalid_request ×1',
      'GET /v1/orders/:id 404 not_found ×1',
      'GET /v1/store/:slug/orders/:number 401 publishable_key_required ×1',
      'GET /v1/store/:slug/products 403 origin_not_allowed ×1',
    ]);
    // The same failure again counts up rather than adding a line.
    await from('https://elsewhere.example', `/v1/store/${slug}/products`, pk.key);
    await settled(7);
    assert.equal((await usage()).failures.find((x: { code: string }) => x.code === 'origin_not_allowed').count, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/developer/usage?days=3', headers: owner })).json().days.length, 3);

    // For the people who manage keys, signed in: not with a key, and never another business's.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/developer/requests', headers: erp })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/developer/usage', headers: erp })).statusCode, 403);
    const otherSlug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantB])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantB, name: 'Other', email: 'other@else.example', role: 'owner', password: PASSWORD });
    const other = { ...CSRF, 'x-business': otherSlug, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: otherSlug, login: 'other@else.example', password: PASSWORD } })) };
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/developer/requests', headers: other })).json().data, []);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/developer/usage', headers: other })).json().totals, { requests: 0, errors: 0 });
  } finally {
    await app.close();
    await f.close();
  }
});

test('the developer log is kept in the database: it survives a restart, pages, is pruned, and goes with the business', async () => {
  const f = await setupPipeline();
  const options = { pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: memoryMailer() };
  let app = await buildApp(options);
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    const olive = await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const owner = { ...CSRF, 'x-business': slug, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } })) };
    const erp = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantA, 'Our ERP')).key}` };
    const other = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantB, 'Theirs')).key}` };
    const log = async (query = '') => (await app.inject({ method: 'GET', url: `/v1/developer/requests${query}`, headers: owner })).json();
    /** The log is written a moment after the answer: wait until it holds this many. */
    const holds = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        if ((await log('?limit=200')).data.length >= n) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail(`the log never held ${n} requests`);
    };

    // Five requests, in this order: three that work, two that do not. And one by another business.
    for (const url of ['/v1/me', '/v1/customers', '/v1/customers?limit=lots', '/v1/items', '/v1/orders/00000000-0000-4000-8000-000000000000']) await app.inject({ method: 'GET', url, headers: erp });
    await app.inject({ method: 'GET', url: '/v1/me', headers: other });
    await holds(5);

    // The server restarts: the log is as it was (it is in the database, not in the process).
    await app.close();
    assert.equal((await f.db.query('select 1 from api_requests')).rows.length, 6);
    app = await buildApp(options);
    const all = await log();
    assert.equal(all.keptDays, 7);
    assert.equal(all.nextCursor, null);
    assert.deepEqual(all.data.map((r: { path: string; status: number }) => `${r.path} ${r.status}`), ['/v1/orders/00000000-0000-4000-8000-000000000000 404', '/v1/items 200', '/v1/customers 400', '/v1/customers 200', '/v1/me 200'], 'newest first, this business only');
    assert.equal(all.data[0].key.name, 'Our ERP');
    assert.equal(all.data[0].id, undefined, 'the row\'s number is not part of the answer');

    // A page at a time: every request once.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { data: Array<{ path: string }>; nextCursor: string | null } = await log(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.ok(page.data.length <= 2);
      seen.push(...page.data.map((r) => r.path));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, all.data.map((r: { path: string }) => r.path));
    // What failed only, and paged the same way.
    const failed = await log('?errors=1&limit=1');
    assert.equal(failed.data[0].status, 404);
    assert.deepEqual((await log(`?errors=1&limit=1&cursor=${failed.nextCursor}`)).data.map((r: { status: number }) => r.status), [400]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/developer/requests?cursor=abc', headers: owner })).statusCode, 400);

    // Housekeeping: what is older than a week goes; of the rest, a business keeps its newest (here, two).
    await f.db.query(`update api_requests set at = now() - interval '8 days' where path = '/v1/me' and tenant_id = $1`, [f.tenantA]);
    assert.equal(await pruneLoggedRequests(f.db), 1);
    assert.equal((await log()).data.length, 4);
    assert.equal(await pruneLoggedRequests(f.db, { perBusiness: 2 }), 2);
    assert.deepEqual((await log()).data.map((r: { path: string }) => r.path), ['/v1/orders/00000000-0000-4000-8000-000000000000', '/v1/items']);
    assert.equal((await f.db.query('select 1 from api_requests where tenant_id = $1', [f.tenantB])).rows.length, 1, 'the other business is under its number: untouched');
    assert.equal(await pruneLoggedRequests(f.db), 0);
    // The housekeeping run does it.
    await f.db.query(`update api_requests set at = now() - interval '8 days' where tenant_id = $1`, [f.tenantB]);
    const failures: unknown[] = [];
    await runHousekeepingOnce(f.db, { onError: (_step, e) => failures.push(e) });
    assert.deepEqual(failures, []);
    assert.equal((await f.db.query('select 1 from api_requests where tenant_id = $1', [f.tenantB])).rows.length, 0);

    // A business that is erased takes its log with it.
    await closeBusiness(f.db, f.tenantA, olive.id);
    await eraseBusiness(f.db, f.tenantA, { force: true });
    assert.equal((await f.db.query('select 1 from api_requests')).rows.length, 0);
  } finally {
    await app.close();
    await f.close();
  }
});

test('writing the log never holds a request up: rows wait together, and a database that is away loses them quietly', async () => {
  const queries: Array<{ sql: string; rows: number }> = [];
  let down = false;
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (down) throw new Error('the database is away');
      if (sql.includes('api_requests')) queries.push({ sql, rows: (params![0] as unknown[]).length });
      return { rows: [{ count: 1 }] };
    },
    exec: async () => {},
  };
  const log = createDevLog(db as never, { flushMs: 20 });
  const entry = (path: string) => ({ at: new Date().toISOString(), method: 'GET', path, route: path, status: 200, code: null, message: null, ms: 3, key: { kind: 'secret' as const, id: 'k' }, origin: null });
  // Three requests in quick succession are one write, a moment later.
  for (const p of ['/a', '/b', '/c']) log.record('00000000-0000-4000-8000-000000000001', entry(p));
  assert.equal(queries.length, 0, 'nothing is written while the request is answered');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(queries.map((q) => q.rows), [3]);
  // A hundred waiting go at once, without the wait.
  for (let i = 0; i < 100; i++) log.record('00000000-0000-4000-8000-000000000001', entry(`/n/${i}`));
  await log.flush();
  assert.deepEqual(queries.map((q) => q.rows), [3, 100]);
  // The database away: recording still never throws, and what could not be written is given up.
  down = true;
  log.record('00000000-0000-4000-8000-000000000001', entry('/lost'));
  await log.flush();
  down = false;
  log.record('00000000-0000-4000-8000-000000000001', entry('/after'));
  await log.stop();
  assert.deepEqual(queries.map((q) => q.rows), [3, 100, 1]);
});
