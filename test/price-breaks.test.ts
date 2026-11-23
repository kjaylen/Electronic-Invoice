/**
 * Quantity prices: an item can cost less each from a quantity on; documents that name the item
 * without a price use the price for the quantity; edits keep or replace them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { priceForQuantity } from '../src/api/catalog.ts';
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

test('the price for a quantity', () => {
  const item = { unitPrice: '3.00', priceBreaks: [{ minQuantity: '6', unitPrice: '2.75' }, { minQuantity: '12', unitPrice: '2.50' }] };
  assert.equal(priceForQuantity(item, '1'), '3.00');
  assert.equal(priceForQuantity(item, '5.9'), '3.00');
  assert.equal(priceForQuantity(item, '6'), '2.75');
  assert.equal(priceForQuantity(item, '24'), '2.50');
  assert.equal(priceForQuantity({ unitPrice: '3.00' }, '100'), '3.00');
});

test('quantity prices on items and documents', async () => {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers: owner, ...(payload && { payload }) });

    const created = await call('POST', '/v1/items', { name: 'Soda', unitCode: 'H87', unitPrice: '3.00', gstCategory: 'S', priceBreaks: [{ minQuantity: '12', unitPrice: '2.50' }, { minQuantity: '6', unitPrice: '2.75' }] });
    assert.equal(created.statusCode, 201, created.body);
    const soda = created.json();
    assert.deepEqual(soda.priceBreaks, [{ minQuantity: '6', unitPrice: '2.75' }, { minQuantity: '12', unitPrice: '2.50' }]);
    const listed = ((await call('GET', '/v1/items?q=Soda')).json().data as Array<{ priceBreaks: unknown }>)[0]!;
    assert.deepEqual(listed.priceBreaks, soda.priceBreaks);
    assert.equal((await call('POST', '/v1/items', { name: 'Bad', unitCode: 'H87', unitPrice: '1.00', gstCategory: 'S', priceBreaks: [{ minQuantity: '1', unitPrice: '0.90' }] })).statusCode, 422);

    // A receipt for 12 sodas named by item: 12 × 2.50.
    const sale = await call('POST', '/v1/documents', { type: '02', lines: [{ itemId: soda.id, quantity: '12' }, { itemId: soda.id, quantity: '2' }], payment: { meansCode: '10', terms: 'Paid' } });
    assert.equal(sale.statusCode, 201, sale.body);
    const lines = (await call('GET', `/v1/documents/${sale.json().id}/view`)).json().view.lines as Array<{ unitPrice: string }>;
    assert.deepEqual(lines.map((l) => Number(l.unitPrice)), [2.5, 3]);

    // The price list PDF, retail with GST and wholesale before GST.
    for (const qs of ['', '?prices=wholesale&gst=exclude', '?category=Drinks']) {
      const pdf = await call('GET', `/v1/items/price-list.pdf${qs}`);
      assert.equal(pdf.statusCode, 200, pdf.body);
      assert.equal(pdf.headers['content-type'], 'application/pdf');
      assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    }

    // An edit without them keeps them; an empty list removes them.
    const kept = (await call('PUT', `/v1/items/${soda.id}`, { name: 'Soda', unitCode: 'H87', unitPrice: '3.25', gstCategory: 'S' })).json();
    assert.equal(kept.priceBreaks.length, 2);
    const cleared = (await call('PUT', `/v1/items/${soda.id}`, { name: 'Soda', unitCode: 'H87', unitPrice: '3.25', gstCategory: 'S', priceBreaks: [] })).json();
    assert.deepEqual(cleared.priceBreaks, []);
  } finally {
    await app.close();
    await f.close();
  }
});
