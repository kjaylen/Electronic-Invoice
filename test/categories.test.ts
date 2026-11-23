/**
 * Item categories: the stored spelling, the list and filter, sales by category (each line keeps the
 * item it was sold from), price changes by category, and the import/export column.
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

test('categories group items, count sales and change prices together', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const add = async (name: string, unitPrice: string, category?: string | null, wholesalePrice?: string) => {
      const r = await app.inject({ method: 'POST', url: '/v1/items', headers: owner, payload: { name, unitCode: 'H87', unitPrice, gstCategory: 'S', ...(category !== undefined && { category }), ...(wholesalePrice && { wholesalePrice }) } });
      assert.equal(r.statusCode, 201, r.body);
      return r.json() as { id: string; category: string | null; unitPrice: string };
    };

    const latte = await add('Latte', '6.50', 'Coffee', '5.00');
    // Spaces tidied; a different case joins the spelling already in use.
    const mocha = await add('Mocha', '7.00', '  coffee ');
    assert.equal(mocha.category, 'Coffee');
    const bread = await add('Banana bread', '3.75', 'Bakery');
    const plain = await add('Gift card', '20.00', '   ');
    assert.equal(plain.category, null);

    const cats = (await app.inject({ method: 'GET', url: '/v1/items/categories', headers: owner })).json().data;
    assert.deepEqual(cats, [{ name: 'Bakery', items: 1 }, { name: 'Coffee', items: 2 }]);
    const names = async (qs: string) => ((await app.inject({ method: 'GET', url: `/v1/items?${qs}`, headers: owner })).json().data as Array<{ name: string }>).map((i) => i.name).sort();
    assert.deepEqual(await names('category=COFFEE'), ['Latte', 'Mocha']);
    assert.deepEqual(await names('category='), ['Gift card']);

    // An edit without the category keeps it; an item alone in its category may change its spelling.
    const kept = (await app.inject({ method: 'PUT', url: `/v1/items/${bread.id}`, headers: owner, payload: { name: 'Banana bread', unitCode: 'H87', unitPrice: '4.00', gstCategory: 'S' } })).json();
    assert.equal(kept.category, 'Bakery');
    const respelled = (await app.inject({ method: 'PUT', url: `/v1/items/${bread.id}`, headers: owner, payload: { name: 'Banana bread', unitCode: 'H87', unitPrice: '4.00', gstCategory: 'S', category: 'BAKERY' } })).json();
    assert.equal(respelled.category, 'BAKERY');

    // Sales by category: lines from the catalog count under their item's category; typed lines under none.
    const doc = await app.inject({
      method: 'POST', url: '/v1/documents', headers: owner,
      payload: {
        type: '01', customer: { name: 'Ana', tin: '333444', address: { street: '1 Main St', city: 'Belize City', districtCode: '1' } },
        lines: [{ itemId: latte.id, quantity: '2' }, { itemId: mocha.id, quantity: '1' }, { itemId: bread.id, quantity: '3' }, { description: 'Delivery', quantity: '1', unitCode: 'H87', unitPrice: '10.00', gstCategory: 'S' }],
        payment: { meansCode: '30', dueDate: '2099-12-31' },
      },
    });
    assert.equal(doc.statusCode, 201, doc.body);
    const period = `from=${belizeToday()}&to=${belizeToday()}`;
    const report = (await app.inject({ method: 'GET', url: `/v1/reports/categories?${period}`, headers: owner })).json().data as Array<{ name: string | null; sales: number; net: string; total: string }>;
    const byName = Object.fromEntries(report.map((r) => [r.name ?? '-', r]));
    assert.equal(byName.Coffee!.net, '20.00'); // 2 × 6.50 + 7.00
    assert.equal(byName.Coffee!.total, '22.51'); // GST per line: 1.63 + 0.88
    assert.equal(byName.BAKERY!.net, '12.00');
    assert.equal(byName['-']!.net, '10.00');
    assert.equal(byName.Coffee!.sales, 1);
    const csv = await app.inject({ method: 'GET', url: `/v1/reports/categories?${period}&format=csv`, headers: owner });
    assert.match(csv.body, /No category/);

    // Prices by category: a dry run changes nothing; rounding goes up to the step.
    const dry = (await app.inject({ method: 'POST', url: '/v1/items/reprice', headers: owner, payload: { category: 'coffee', mode: 'percent', value: '10', roundTo: '0.25', dryRun: true } })).json();
    assert.deepEqual(dry.changes.map((c: { name: string; from: string; to: string }) => [c.name, c.from, c.to]), [['Latte', '6.50', '7.25'], ['Mocha', '7.00', '7.75']]);
    assert.equal((await names('category=Coffee')).length, 2);
    const unchanged = ((await app.inject({ method: 'GET', url: '/v1/items?category=Coffee', headers: owner })).json().data as Array<{ unitPrice: string }>).map((i) => i.unitPrice).sort();
    assert.deepEqual(unchanged, ['6.50', '7.00']);
    const applied = (await app.inject({ method: 'POST', url: '/v1/items/reprice', headers: owner, payload: { category: 'Coffee', mode: 'percent', value: '10', roundTo: '0.25' } })).json();
    assert.equal(applied.changed, 2);
    const prices = ((await app.inject({ method: 'GET', url: '/v1/items?category=Coffee', headers: owner })).json().data as Array<{ name: string; unitPrice: string }>).map((i) => `${i.name} ${i.unitPrice}`).sort();
    assert.deepEqual(prices, ['Latte 7.25', 'Mocha 7.75']);
    const logged = (await f.db.query<{ n: number }>(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'items.repriced'`, [f.tenantA])).rows[0]!.n;
    assert.equal(logged, 1);

    // Wholesale prices: only items that have one move by an amount; never below zero.
    const ws = (await app.inject({ method: 'POST', url: '/v1/items/reprice', headers: owner, payload: { mode: 'amount', value: '-0.50', price: 'wholesale' } })).json();
    assert.deepEqual([ws.matched, ws.changes[0].to], [1, '4.50']);
    const floor = (await app.inject({ method: 'POST', url: '/v1/items/reprice', headers: owner, payload: { category: null, mode: 'amount', value: '-50', dryRun: true } })).json();
    assert.deepEqual(floor.changes.map((c: { name: string; to: string }) => [c.name, c.to]), [['Gift card', '0.00']]);
    const bad = await app.inject({ method: 'POST', url: '/v1/items/reprice', headers: owner, payload: { mode: 'percent', value: 'ten' } });
    assert.equal(bad.statusCode, 400);

    // Imports read a Category column (in the spelling already used); exports write it.
    const imp = (await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv: 'Name,Price,GST,Category\nCold brew,6.00,S,COFFEE\nScone,3.00,S,Pastry' } })).json();
    assert.equal(imp.created, 2, JSON.stringify(imp));
    assert.deepEqual(await names('category=Coffee'), ['Cold brew', 'Latte', 'Mocha']);
    const exported = await app.inject({ method: 'GET', url: '/v1/items/export.csv', headers: owner });
    assert.match(exported.body.split('\n')[0]!, /Category/);
    assert.match(exported.body, /Scone,,,Pastry,/);
  } finally {
    await app.close();
    await f.close();
  }
});
