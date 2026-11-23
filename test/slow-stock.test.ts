/**
 * Not selling: items in stock for a while with nothing sold in 60 days, most money tied up first.
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

test('slow stock: held 60 days with no sale', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: owner, ...(payload && { payload }) });
    const item = async (name: string) => (await call('POST', '/v1/items', { name, unitCode: 'H87', unitPrice: '10.00', gstCategory: 'S' })).json() as { id: string };
    const fan = await item('Desk fan');
    const lamp = await item('Lamp');
    const cups = await item('Cups');
    await call('POST', '/v1/inventory/receipts', { supplierName: 'Wholesaler', receivedOn: belizeToday(), lines: [{ itemId: fan.id, quantity: '5', unitCost: '30.00' }, { itemId: lamp.id, quantity: '2', unitCost: '20.00' }, { itemId: cups.id, quantity: '10', unitCost: '1.00' }] });
    const slow = async () => ((await call('GET', '/v1/inventory?filter=slow')).json().data as Array<{ name: string; lastSold: string | null }>).map((s) => s.name);
    // Just arrived: not slow yet.
    assert.deepEqual(await slow(), []);
    // As if they had been on the shelf for three months.
    await f.db.query(
      `insert into stock_movements (id, tenant_id, item_id, change, balance_after, reason, note, created_at)
       select gen_random_uuid(), tenant_id, id, 0, stock_quantity, 'count', 'test', now() - interval '90 days' from items where id = any($1::uuid[])`, [[fan.id, lamp.id, cups.id]],
    );
    // The most money first: fan 150, lamp 40, cups 10.
    assert.deepEqual(await slow(), ['Desk fan', 'Lamp', 'Cups']);
    // A sale today takes the cups off the list.
    const sale = await call('POST', '/v1/documents', { type: '02', lines: [{ itemId: cups.id, quantity: '1' }], payment: { meansCode: '10', terms: 'Paid' } });
    assert.equal(sale.statusCode, 201, sale.body);
    assert.deepEqual(await slow(), ['Desk fan', 'Lamp']);
    const cupsNow = (await call('GET', `/v1/inventory/${cups.id}`)).json();
    assert.ok(cupsNow.lastSold);
  } finally {
    await app.close();
    await f.close();
  }
});
