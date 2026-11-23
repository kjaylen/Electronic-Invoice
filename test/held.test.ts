/**
 * Held sales shared by the business's tills: hold at one, recall at another, only once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('held sales: hold, list, recall once, delete; per business', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slugOf = async (id: string) => (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [id])).rows[0]!.slug;
    const slug = await slugOf(f.tenantA);
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Ari', email: 'ari@biz.example', role: 'accountant', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantB, name: 'Bo', email: 'bo@other.example', role: 'owner', password: PASSWORD });
    const login = async (business: string, email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business, login: email, password: PASSWORD } })), 'x-business': business });
    const cashier = await login(slug, 'cass@biz.example');
    const accountant = await login(slug, 'ari@biz.example');
    const other = await login(await slugOf(f.tenantB), 'bo@other.example');

    const sale = { lines: [{ key: 1, name: 'Coconut water', quantity: '2', unitCode: 'H87', unitPrice: '3.50', gstCategory: 'S' }], meansCode: '10', tendered: '', tin: '', idempotencyKey: 'k-1' };
    const held = await app.inject({ method: 'POST', url: '/v1/held-sales', headers: cashier, payload: { label: 'Table 4', total: '7.88', count: 1, sale } });
    assert.equal(held.statusCode, 201, held.body);
    const h = held.json();
    assert.deepEqual([h.label, h.total, h.count, h.heldBy], ['Table 4', '7.88', 1, 'Cass']);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/held-sales', headers: accountant, payload: { total: '1.00', count: 1, sale } })).statusCode, 403);

    const list = (await app.inject({ method: 'GET', url: '/v1/held-sales', headers: cashier })).json().data;
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].sale, sale);
    // Another business sees nothing and cannot take it.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/held-sales', headers: other })).json().data.length, 0);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/held-sales/${h.id}/recall`, headers: other })).statusCode, 404);

    // Recalled once: the second till is told it is gone.
    const got = await app.inject({ method: 'POST', url: `/v1/held-sales/${h.id}/recall`, headers: cashier });
    assert.equal(got.statusCode, 200);
    assert.deepEqual(got.json().sale, sale);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/held-sales/${h.id}/recall`, headers: cashier })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/held-sales', headers: cashier })).json().data.length, 0);

    const again = (await app.inject({ method: 'POST', url: '/v1/held-sales', headers: cashier, payload: { total: '7.88', count: 1, sale } })).json();
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/held-sales/${again.id}`, headers: cashier })).statusCode, 204);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/held-sales/${again.id}`, headers: cashier })).statusCode, 404);
  } finally {
    await app.close();
    await f.close();
  }
});
