/**
 * Gross margin: each line sold from the catalog keeps the item's average cost when it was sold;
 * the report sets sales before GST against that cost, by category and by item.
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

test('gross margin by category and item, from the cost when sold', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const post = async (url: string, payload: object) => {
      const r = await app.inject({ method: 'POST', url, headers: owner, payload });
      assert.ok(r.statusCode < 300, r.body);
      return r.json();
    };
    const latte = await post('/v1/items', { name: 'Latte', unitCode: 'H87', unitPrice: '6.00', gstCategory: 'S', category: 'Drinks' });
    const beans = await post('/v1/items', { name: 'Beans 1 lb', unitCode: 'H87', unitPrice: '20.00', gstCategory: 'S', category: 'Retail' });
    const scone = await post('/v1/items', { name: 'Scone', unitCode: 'H87', unitPrice: '3.00', gstCategory: 'S', category: 'Bakery' });
    // Costs come from stock received; the scone has none.
    await post('/v1/inventory/receipts', { supplierName: 'Roaster', receivedOn: belizeToday(), lines: [{ itemId: latte.id, quantity: '100', unitCost: '1.50' }, { itemId: beans.id, quantity: '10', unitCost: '12.00' }] });

    await post('/v1/documents', {
      type: '01', customer: { name: 'Ana', tin: '333444', address: { street: '1 Main St', city: 'Belize City', districtCode: '1' } },
      lines: [{ itemId: latte.id, quantity: '4' }, { itemId: beans.id, quantity: '2' }, { itemId: scone.id, quantity: '2' }, { description: 'Delivery', quantity: '1', unitCode: 'H87', unitPrice: '5.00', gstCategory: 'S' }],
      payment: { meansCode: '30', dueDate: '2099-12-31' },
    });
    // The line keeps the cost even when the average changes later.
    await post('/v1/inventory/receipts', { supplierName: 'Roaster', receivedOn: belizeToday(), lines: [{ itemId: beans.id, quantity: '8', unitCost: '15.00' }] });
    const kept = (await f.db.query<{ unit_cost: string }>('select unit_cost::text from document_lines where item_id = $1', [beans.id])).rows[0]!;
    assert.equal(Number(kept.unit_cost), 12);

    const period = `from=${belizeToday()}&to=${belizeToday()}`;
    const byCat = (await app.inject({ method: 'GET', url: `/v1/reports/margins?${period}`, headers: owner })).json();
    // Sales with a cost: 4 × 6 + 2 × 20 = 64; cost 4 × 1.50 + 2 × 12 = 30; margin 34 (53.1%).
    assert.deepEqual(byCat.totals, { sales: '64.00', cost: '30.00', margin: '34.00', marginPercent: 53.1, withoutCost: '11.00' });
    assert.deepEqual(byCat.data.map((r: { name: string; margin: string; marginPercent: number }) => [r.name, r.margin, r.marginPercent]), [['Retail', '16.00', 40], ['Drinks', '18.00', 75]].sort((a, b) => Number(b[1]) - Number(a[1])));
    const byItem = (await app.inject({ method: 'GET', url: `/v1/reports/margins?${period}&by=item`, headers: owner })).json();
    assert.deepEqual(byItem.data.map((r: { name: string; category: string; quantity: string; cost: string }) => [r.name, r.category, r.quantity, r.cost]), [['Latte', 'Drinks', '4', '6.00'], ['Beans 1 lb', 'Retail', '2', '24.00']]);
    const csv = await app.inject({ method: 'GET', url: `/v1/reports/margins?${period}&by=item&format=csv`, headers: owner });
    assert.match(csv.body.split('\n')[0]!, /Margin %/);
    assert.match(csv.body, /Latte,Drinks,4,24(\.00)?,6(\.00)?,18(\.00)?,75/);
  } finally {
    await app.close();
    await f.close();
  }
});
