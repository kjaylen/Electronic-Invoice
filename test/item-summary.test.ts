/**
 * An item at a glance: sales over 30/90/365 days and by month, margin from line costs, stock and
 * days of cover, suppliers with their last cost, and the bundles it is part of.
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

test('an item at a glance', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const post = async (url: string, payload: object) => {
      const r = await app.inject({ method: 'POST', url, headers: owner, payload });
      assert.ok(r.statusCode < 300, r.body);
      return r.json();
    };
    const beans = await post('/v1/items', { name: 'Beans 1 lb', unitCode: 'H87', unitPrice: '20.00', gstCategory: 'S', category: 'Retail' });
    const gift = await post('/v1/items', { name: 'Gift box', unitCode: 'H87', unitPrice: '50.00', gstCategory: 'S' });
    await app.inject({ method: 'PUT', url: `/v1/items/${gift.id}/components`, headers: owner, payload: { components: [{ itemId: beans.id, quantity: '2' }] } });
    await post('/v1/inventory/receipts', { supplierName: 'Roaster', receivedOn: belizeToday(), lines: [{ itemId: beans.id, quantity: '30', unitCost: '12.00' }] });
    await post('/v1/documents', { type: '02', lines: [{ itemId: beans.id, quantity: '3' }], payment: { meansCode: '10', terms: 'Paid' } });

    const s = (await app.inject({ method: 'GET', url: `/v1/items/${beans.id}/summary`, headers: owner })).json();
    assert.equal(s.item.name, 'Beans 1 lb');
    assert.deepEqual(s.sales.last30, { quantity: '3', net: '60.00' });
    assert.equal(s.sales.months.length, 1);
    assert.deepEqual(s.margin, { sales: '60.00', cost: '36.00', percent: 40 });
    assert.equal(s.stock.quantity, 27);
    assert.equal(s.stock.daysOfCover, 810); // 27 left at 3 per 90 days
    assert.deepEqual(s.suppliers.map((p: { name: string; lastCost: string }) => [p.name, p.lastCost]), [['Roaster', '12.00']]);
    assert.deepEqual(s.bundles.map((b: { name: string; quantity: string }) => [b.name, b.quantity]), [['Gift box', '2']]);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/items/${beans.id}/summary`, headers: cashier })).statusCode, 403);
  } finally {
    await app.close();
    await f.close();
  }
});
