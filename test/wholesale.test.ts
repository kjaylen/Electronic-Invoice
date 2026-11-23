/**
 * Wholesale prices: an item's second price, a customer's price list, and documents that use the
 * wholesale price for wholesale customers when a line gives no price of its own.
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

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('wholesale customers pay wholesale prices; retail customers the usual price', async () => {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };

    const item = (await app.inject({ method: 'POST', url: '/v1/items', headers: owner, payload: { name: 'Rice 25 lb', unitCode: 'H87', unitPrice: '30.00', wholesalePrice: '25.50', gstCategory: 'Z' } })).json();
    assert.equal(item.wholesalePrice, '25.50');
    // An edit that leaves the wholesale price out keeps it.
    const edited = (await app.inject({ method: 'PUT', url: `/v1/items/${item.id}`, headers: owner, payload: { name: 'Rice 25 lb', unitCode: 'H87', unitPrice: '31.00', gstCategory: 'Z' } })).json();
    assert.deepEqual([edited.unitPrice, edited.wholesalePrice], ['31.00', '25.50']);

    const address = { street: '1 Main St', city: 'Belize City', districtCode: '1' };
    const shop = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Corner Shop', tin: '111222', address, priceList: 'wholesale' } })).json();
    assert.equal(shop.priceList, 'wholesale');
    const person = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Ana', tin: '333444', address } })).json();
    assert.equal(person.priceList, 'retail');

    const invoice = async (customerId: string) => {
      const doc = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '01', customerId, lines: [{ itemId: item.id, quantity: '2' }], payment: { meansCode: '30', dueDate: '2099-12-31' } } });
      assert.equal(doc.statusCode, 201, doc.body);
      return (await app.inject({ method: 'GET', url: `/v1/documents/${doc.json().id}/view`, headers: owner })).json().view.lines[0].unitPrice;
    };
    assert.equal(await invoice(shop.id), '25.50');
    assert.equal(await invoice(person.id), '31.00');

    // An edit without the price list keeps it.
    const kept = (await app.inject({ method: 'PUT', url: `/v1/customers/${shop.id}`, headers: owner, payload: { name: 'Corner Shop Ltd.', tin: '111222', address } })).json();
    assert.equal(kept.priceList, 'wholesale');

    // Imports carry them too.
    const imp = (await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv: 'Name,Code,Price,Wholesale price,GST\nFlour 50 lb,FL50,40.00,34.00,Z' } })).json();
    assert.equal(imp.created, 1);
    const flour = ((await app.inject({ method: 'GET', url: '/v1/items?q=Flour', headers: owner })).json().data as Array<{ wholesalePrice: string | null }>)[0]!;
    assert.equal(flour.wholesalePrice, '34.00');
    const cust = (await app.inject({ method: 'POST', url: '/v1/customers/import', headers: owner, payload: { csv: 'Name,TIN,Price list\nBig Store,555666,wholesale\nOdd,777999,special' } })).json();
    assert.deepEqual([cust.created, cust.errors], [1, 1]);
    const big = ((await app.inject({ method: 'GET', url: '/v1/customers?q=Big', headers: owner })).json().data as Array<{ priceList: string }>)[0]!;
    assert.equal(big.priceList, 'wholesale');
  } finally {
    await app.close();
    await f.close();
  }
});
