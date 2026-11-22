/**
 * Inventory: sales take stock off, voided sales put it back once, counts and
 * adjustments, receiving with an expense and average cost, the product
 * editor recording counts, who may change stock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { reverseVoidedSales, stockQuantity } from '../src/inventory/stock.ts';
import { AUTHORIZED, rejectedWith, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  try {
    await fn({ f, app, owner: await login('olive@biz.example'), login });
  } finally {
    await app.close();
    await f.close();
  }
}

async function item(c: Ctx, name: string, price = '10.00', unitCode = 'H87') {
  const r = await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name, unitCode, unitPrice: price, gstCategory: 'S' } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}

const sell = (c: Ctx, itemId: string, quantity: string) => c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [{ itemId, quantity }], payment: { meansCode: '10', terms: 'Paid in cash' } } });
const stockOf = async (c: Ctx, itemId: string) => (await c.app.inject({ method: 'GET', url: `/v1/inventory/${itemId}`, headers: c.owner })).json();

test('stock quantities', () => {
  assert.equal(stockQuantity('1.000000'), '1');
  assert.equal(stockQuantity('2.500'), '2.5');
  assert.equal(stockQuantity('-3'), '-3');
  assert.throws(() => stockQuantity('1.2345'));
});

test('sales take stock off; untracked items are left alone; voided sales come back once; stock can go below zero', () =>
  withBusiness(async (c) => {
    const rice = await item(c, 'Rice (lb)', '1.50', 'LBR');
    const bag = await item(c, 'Gift bag');
    assert.equal((await sell(c, bag, '1')).statusCode, 201);
    assert.equal((await stockOf(c, bag)).tracked, false, 'untracked: selling it records nothing');

    const start = await c.app.inject({ method: 'PUT', url: `/v1/inventory/${rice}/settings`, headers: c.owner, payload: { track: true, quantity: '20', lowStock: '5' } });
    assert.deepEqual([start.json().stock, start.json().lowStock, start.json().state], [20, 5, 'ok']);
    const sale = await sell(c, rice, '2.5');
    assert.equal(sale.statusCode, 201, sale.body);
    let s = await stockOf(c, rice);
    assert.equal(s.stock, 17.5, 'sold by the pound');
    assert.deepEqual([s.movements[0].reason, s.movements[0].change, s.movements[0].document.id], ['sale', -2.5, sale.json().id]);
    assert.equal(s.movements[1].reason, 'initial');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/items?q=Rice', headers: c.owner })).json().data[0].stock, 17.5, 'the catalog shows the stock');

    // A document BTS rejects never takes stock.
    c.f.bts.script(SUBMIT_PATHS['02'], rejectedWith('283', 'Something wrong'));
    await sell(c, rice, '1');
    assert.equal((await stockOf(c, rice)).stock, 17.5);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);

    // A cancelled sale goes back, once.
    await c.f.db.query("update documents set status = 'cancelled' where id = $1", [sale.json().id]);
    assert.equal(await reverseVoidedSales(c.f.db), 1);
    assert.equal(await reverseVoidedSales(c.f.db), 0, 'once');
    s = await stockOf(c, rice);
    assert.deepEqual([s.stock, s.movements[0].reason, s.movements[0].note], [20, 'sale_reversed', 'Document cancelled']);
    await assert.rejects(c.f.db.query('delete from stock_movements'), /permanent/);

    // The counter never refuses a sale because the count is off.
    assert.equal((await sell(c, rice, '25')).statusCode, 201);
    s = await stockOf(c, rice);
    assert.deepEqual([s.stock, s.state], [-5, 'out']);
  }));

test('counts, adjustments, low stock, receiving with the bill as an expense, average cost and value', () =>
  withBusiness(async (c) => {
    const soap = await item(c, 'Soap bar', '3.00');
    const oil = await item(c, 'Coconut oil', '12.00');
    await c.app.inject({ method: 'PUT', url: `/v1/inventory/${soap}/settings`, headers: c.owner, payload: { track: true, quantity: '10', lowStock: '4' } });

    const damaged = await c.app.inject({ method: 'POST', url: `/v1/inventory/${soap}/adjust`, headers: c.owner, payload: { mode: 'change', quantity: '-7', reason: 'damaged', note: 'Water leak' } });
    assert.deepEqual([damaged.json().stock, damaged.json().state], [3, 'low']);
    const low = (await c.app.inject({ method: 'GET', url: '/v1/inventory?filter=low', headers: c.owner })).json();
    assert.deepEqual([low.data.length, low.totals.low], [1, 1]);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/inventory/${oil}/adjust`, headers: c.owner, payload: { mode: 'change', quantity: '1', reason: 'count' } })).statusCode, 409, 'not tracked yet');

    const sup = (await c.app.inject({ method: 'POST', url: '/v1/suppliers', headers: c.owner, payload: { name: 'Island Distributors', tin: '123456' } })).json();
    const rec = await c.app.inject({
      method: 'POST', url: '/v1/inventory/receipts', headers: c.owner,
      payload: { supplierId: sup.id, reference: 'DN-778', receivedOn: today(), lines: [{ itemId: soap, quantity: '12', unitCost: '1.25' }, { itemId: oil, quantity: '6', unitCost: '7.00' }], expense: { gstTreatment: 'standard', paid: null, dueDate: today() } },
    });
    assert.equal(rec.statusCode, 201, rec.body);
    assert.equal(rec.json().totalCost, '57.00');
    const exp = (await c.app.inject({ method: 'GET', url: `/v1/expenses/${rec.json().expenseId}`, headers: c.owner })).json();
    assert.deepEqual([exp.category, exp.net, exp.gst, exp.total, exp.claimableGst, exp.paid], ['Stock for resale', '57.00', '7.13', '64.13', '7.13', null], 'the bill, with GST on top of the cost');

    let s = await stockOf(c, soap);
    assert.deepEqual([s.stock, s.averageCost, s.movements[0].reason, s.movements[0].receipt.supplier], [15, '1.25', 'receive', 'Island Distributors']);
    assert.equal((await stockOf(c, oil)).stock, 6, 'receiving starts tracking an item');
    // A second delivery at a higher cost moves the average: (15 × 1.25 + 5 × 2.25) / 20 = 1.50.
    await c.app.inject({ method: 'POST', url: '/v1/inventory/receipts', headers: c.owner, payload: { supplierName: 'Market', receivedOn: today(), lines: [{ itemId: soap, quantity: '5', unitCost: '2.25' }] } });
    s = await stockOf(c, soap);
    assert.deepEqual([s.stock, s.averageCost, s.value], [20, '1.50', '30.00']);

    const count = await c.app.inject({ method: 'POST', url: '/v1/inventory/count', headers: c.owner, payload: { counts: [{ itemId: soap, quantity: '18' }, { itemId: oil, quantity: '6' }], note: 'Month-end count' } });
    assert.deepEqual(count.json(), { counted: 2, changed: 1 }, 'only what differs is recorded');
    s = await stockOf(c, soap);
    assert.deepEqual([s.stock, s.movements[0].reason, s.movements[0].change], [18, 'count', -2]);

    const all = (await c.app.inject({ method: 'GET', url: '/v1/inventory', headers: c.owner })).json();
    assert.equal(all.totals.value, '69.00', '18 × 1.50 + 6 × 7.00');
    const csv = await c.app.inject({ method: 'GET', url: '/v1/inventory.csv', headers: c.owner });
    assert.match(csv.body, /Soap bar,,,H87,18,4,1\.50,27\.00,3\.00/);
    const receipts = (await c.app.inject({ method: 'GET', url: '/v1/inventory/receipts', headers: c.owner })).json();
    assert.deepEqual(receipts.data.map((r: { lines: number }) => r.lines), [1, 2]);

    // Cashiers see stock; managers and owners change it.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cash@biz.example');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/inventory', headers: cashier })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/inventory/${soap}/adjust`, headers: cashier, payload: { mode: 'change', quantity: '-1', reason: 'lost' } })).statusCode, 403);
  }));

test('the product editor records stock changes as counts', () =>
  withBusiness(async (c) => {
    const p = await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title: 'Mug', status: 'draft', variants: [{ price: '15.00', gstCategory: 'S', stock: 5 }] } });
    assert.equal(p.statusCode, 201, p.body);
    const v = p.json().variants[0];
    assert.equal(v.stock, 5);
    await c.app.inject({ method: 'PUT', url: `/v1/products/${p.json().id}`, headers: c.owner, payload: { title: 'Mug', status: 'draft', variants: [{ id: v.id, price: '15.00', gstCategory: 'S', stock: 8 }] } });
    const s = await stockOf(c, v.id);
    assert.deepEqual([s.stock, s.movements[0].reason, s.movements[0].change, s.movements[1].reason], [8, 'count', 3, 'initial']);
  }));
