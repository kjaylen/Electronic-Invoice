/**
 * Bundles: an item made of others. Selling one takes its components off the shelf, and the line's
 * cost is theirs added up. No bundle inside a bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('bundles sell their components and cost what they cost', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers: owner, ...(payload && { payload }) });
    const item = async (name: string, unitPrice: string) => (await call('POST', '/v1/items', { name, unitCode: 'H87', unitPrice, gstCategory: 'S' })).json() as { id: string };

    const coffee = await item('Drip coffee', '3.00');
    const bread = await item('Banana bread', '3.75');
    const combo = await item('Breakfast combo', '6.00');
    await call('POST', '/v1/inventory/receipts', { supplierName: 'Roaster', receivedOn: belizeToday(), lines: [{ itemId: coffee.id, quantity: '50', unitCost: '0.80' }, { itemId: bread.id, quantity: '20', unitCost: '1.20' }] });

    const set = await call('PUT', `/v1/items/${combo.id}/components`, { components: [{ itemId: coffee.id, quantity: '1' }, { itemId: bread.id, quantity: '2' }] });
    assert.equal(set.statusCode, 200, set.body);
    const parts = (await call('GET', `/v1/items/${combo.id}/components`)).json();
    assert.deepEqual(parts.data.map((p: { name: string; quantity: string }) => [p.name, p.quantity]), [['Banana bread', '2'], ['Drip coffee', '1']]);
    assert.equal(parts.cost, '3.20'); // 0.80 + 2 × 1.20
    const listed = ((await call('GET', '/v1/items?q=combo')).json().data as Array<{ bundle: boolean }>)[0]!;
    assert.equal(listed.bundle, true);

    // No bundle in a bundle, nor an item in itself; a component cannot become a bundle.
    const box = await item('Gift box', '20.00');
    assert.equal((await call('PUT', `/v1/items/${box.id}/components`, { components: [{ itemId: combo.id, quantity: '1' }] })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/items/${combo.id}/components`, { components: [{ itemId: combo.id, quantity: '1' }] })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/items/${coffee.id}/components`, { components: [{ itemId: box.id, quantity: '1' }] })).statusCode, 422);

    // Selling 3 combos takes 3 coffees and 6 breads.
    const sale = await call('POST', '/v1/documents', { type: '02', lines: [{ itemId: combo.id, quantity: '3' }], payment: { meansCode: '10', terms: 'Paid' } });
    assert.equal(sale.statusCode, 201, sale.body);
    const stock = async (id: string) => Number((await call('GET', `/v1/inventory/${id}`)).json().stock);
    assert.equal(await stock(coffee.id), 47);
    assert.equal(await stock(bread.id), 14);
    const line = (await f.db.query<{ unit_cost: string }>('select unit_cost::text from document_lines where item_id = $1', [combo.id])).rows[0]!;
    assert.equal(Number(line.unit_cost), 3.2);

    // No longer a bundle: an empty list.
    await call('PUT', `/v1/items/${combo.id}/components`, { components: [] });
    assert.equal((await call('GET', `/v1/items/${combo.id}/components`)).json().data.length, 0);
  } finally {
    await app.close();
    await f.close();
  }
});
