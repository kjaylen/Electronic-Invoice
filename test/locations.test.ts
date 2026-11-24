/**
 * More than one shop: stock kept per location, tills that sell from their
 * own shop's stock, counts per location, transfers between two (and what is
 * on the way), and landed cost on a delivery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { spreadLanded } from '../src/api/inventory.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { reverseVoidedSales } from '../src/inventory/stock.ts';
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

const call = (c: Ctx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = c.owner) => c.app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
async function item(c: Ctx, name: string, stock?: string) {
  const r = await call(c, 'POST', '/v1/items', { name, unitCode: 'H87', unitPrice: '10.00', gstCategory: 'S' });
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().id as string;
  if (stock !== undefined) assert.equal((await call(c, 'PUT', `/v1/inventory/${id}/settings`, { track: true, quantity: stock })).statusCode, 200);
  return id;
}
const stockOf = async (c: Ctx, itemId: string) => (await call(c, 'GET', `/v1/inventory/${itemId}`)).json();
/** [total, at the main shop, at the other one, on the way]. */
const where = async (c: Ctx, itemId: string, main: string, other: string) => {
  const s = await stockOf(c, itemId);
  return [s.stock, s.at[main], s.at[other] ?? 0, s.onTheWay];
};
async function twoShops(c: Ctx) {
  const r = await call(c, 'POST', '/v1/locations', { name: 'San Pedro', mainName: 'Belize City' });
  assert.equal(r.statusCode, 201, r.body);
  const all = r.json().data as Array<{ id: string; name: string; main: boolean }>;
  return { main: all.find((l) => l.main)!.id, other: all.find((l) => !l.main)!.id };
}

test('a business with one shop sees nothing of locations', () =>
  withBusiness(async (c) => {
    const soap = await item(c, 'Soap', '8');
    assert.deepEqual((await call(c, 'GET', '/v1/locations')).json().data, []);
    const list = (await call(c, 'GET', '/v1/inventory')).json();
    assert.equal(list.locations, undefined);
    assert.equal(list.data[0].at, undefined);
    assert.equal((await stockOf(c, soap)).locations, undefined);
    // A location that is not theirs is refused, wherever one can be given.
    const stranger = '00000000-0000-4000-8000-000000000001';
    assert.equal((await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'change', quantity: '1', reason: 'other', locationId: stranger })).statusCode, 422);
    assert.equal((await call(c, 'POST', '/v1/inventory/count', { counts: [{ itemId: soap, quantity: '9' }], locationId: stranger })).statusCode, 422);
    assert.equal((await stockOf(c, soap)).stock, 8);
  }));

test('a second shop: the first gets a name, stock is received, counted and adjusted where it is, and the total follows', () =>
  withBusiness(async (c) => {
    const soap = await item(c, 'Soap', '8');
    const oil = await item(c, 'Oil');
    const { main, other } = await twoShops(c);
    const names = (await call(c, 'GET', '/v1/locations')).json().data.map((l: { name: string; main: boolean }) => [l.name, l.main]);
    assert.deepEqual(names, [['Belize City', true], ['San Pedro', false]]);
    assert.equal((await call(c, 'POST', '/v1/locations', { name: 'san pedro' })).statusCode, 409, 'one of each name');
    // Everything there was is at the main shop.
    assert.deepEqual(await where(c, soap, main, other), [8, 8, 0, 0]);

    // A delivery straight to the other shop; it also starts tracking the oil.
    const got = await call(c, 'POST', '/v1/inventory/receipts', { supplierName: 'Island Distributors', receivedOn: today(), locationId: other, lines: [{ itemId: soap, quantity: '12', unitCost: '1.00' }, { itemId: oil, quantity: '6', unitCost: '7.00' }] });
    assert.equal(got.statusCode, 201, got.body);
    assert.deepEqual(await where(c, soap, main, other), [20, 8, 12, 0]);
    assert.deepEqual(await where(c, oil, main, other), [6, 0, 6, 0]);
    assert.equal((await call(c, 'GET', '/v1/inventory/receipts')).json().data[0].location, 'San Pedro');

    // Counting the other shop sets what is on its shelves; the main shop's stock is untouched.
    const counted = await call(c, 'POST', '/v1/inventory/count', { locationId: other, counts: [{ itemId: soap, quantity: '10' }, { itemId: oil, quantity: '6' }] });
    assert.deepEqual([counted.json().counted, counted.json().changed], [2, 1]);
    assert.deepEqual(await where(c, soap, main, other), [18, 8, 10, 0]);
    // Counting the main shop, likewise (no location: the main one).
    assert.equal((await call(c, 'POST', '/v1/inventory/count', { counts: [{ itemId: soap, quantity: '7' }] })).json().changed, 1);
    assert.deepEqual(await where(c, soap, main, other), [17, 7, 10, 0]);
    assert.equal((await call(c, 'POST', '/v1/inventory/count', { locationId: main, counts: [{ itemId: soap, quantity: '7' }] })).json().changed, 0);

    // One damaged at the other shop; a count on the item itself there.
    const adjusted = await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'change', quantity: '-1', reason: 'damaged', locationId: other });
    assert.deepEqual([adjusted.json().stock, adjusted.json().at[other]], [16, 9]);
    await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'set', quantity: '4', reason: 'count', locationId: other });
    assert.deepEqual(await where(c, soap, main, other), [11, 7, 4, 0]);
    // The history says where each thing happened.
    const moves = (await stockOf(c, soap)).movements as Array<{ reason: string; change: number; location: string }>;
    assert.deepEqual(moves.slice(0, 3).map((m) => [m.reason, m.change, m.location]), [['count', -5, 'San Pedro'], ['damaged', -1, 'San Pedro'], ['count', -1, 'Belize City']]);
    // The list carries the same figures.
    const row = (await call(c, 'GET', '/v1/inventory')).json();
    assert.equal(row.locations.length, 2);
    assert.deepEqual(row.data.find((r: { itemId: string }) => r.itemId === soap).at, { [main]: 7, [other]: 4 });

    // Closing a shop: not while it has stock; the main one never.
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).json().error.code, 'has_stock');
    assert.equal((await call(c, 'DELETE', `/v1/locations/${main}`)).json().error.code, 'main_location');
    // An item that stops being tracked has nothing anywhere.
    await call(c, 'PUT', `/v1/inventory/${oil}/settings`, { track: false });
    await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'set', quantity: '0', reason: 'count', locationId: other });
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).statusCode, 200);
    assert.deepEqual((await call(c, 'GET', '/v1/locations')).json().data.map((l: { name: string }) => l.name), ['Belize City']);
    assert.equal((await stockOf(c, soap)).stock, 7);
  }));

test('a till sells from its own shop: the sale comes off that shelf, and goes back there if BTS rejects it', () =>
  withBusiness(async (c) => {
    const soap = await item(c, 'Soap', '8');
    const { main, other } = await twoShops(c);
    await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'change', quantity: '5', reason: 'other', locationId: other });
    const front = (await call(c, 'POST', '/v1/registers', { name: 'Front counter' })).json();
    const island = (await call(c, 'POST', '/v1/registers', { name: 'Island till', locationId: other })).json();
    assert.equal((await call(c, 'POST', '/v1/registers', { name: 'Nowhere', locationId: '00000000-0000-4000-8000-000000000001' })).statusCode, 422);
    const registers = (await call(c, 'GET', '/v1/registers')).json().data as Array<{ name: string; location: { name: string } }>;
    assert.deepEqual(registers.map((r) => [r.name, r.location.name]), [['Front counter', 'Belize City'], ['Island till', 'San Pedro']]);
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).json().error.code, 'has_stock');

    const sell = (quantity: string) => call(c, 'POST', '/v1/documents', { type: '02', lines: [{ itemId: soap, quantity }], payment: { meansCode: '10', terms: 'Paid in cash' } });
    // A shift on the island till: its sales come off the island's stock.
    const shift = (await call(c, 'POST', '/v1/shifts', { registerId: island.id, openingFloat: '50.00' })).json().shift;
    assert.equal((await sell('2')).statusCode, 201);
    assert.deepEqual(await where(c, soap, main, other), [11, 8, 3, 0]);
    // Rejected by BTS: put back, on the island.
    c.f.bts.script(SUBMIT_PATHS['02'], rejectedWith('283', 'Something wrong'));
    assert.equal((await sell('1')).json().status, 'rejected');
    await reverseVoidedSales(c.f.db);
    assert.deepEqual(await where(c, soap, main, other), [11, 8, 3, 0]);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    await call(c, 'POST', `/v1/shifts/${shift.id}/close`, { countedCash: '70.00' });

    // The same person at the front counter: off the main shop's stock.
    await call(c, 'POST', '/v1/shifts', { registerId: front.id, openingFloat: '50.00' });
    assert.equal((await sell('3')).statusCode, 201);
    assert.deepEqual(await where(c, soap, main, other), [8, 5, 3, 0]);
    // The till moves to the main shop; the island can then close once it is empty.
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).json().error.code, 'has_stock');
    await call(c, 'POST', `/v1/inventory/${soap}/adjust`, { mode: 'set', quantity: '0', reason: 'count', locationId: other });
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).json().error.code, 'has_registers');
    assert.equal((await call(c, 'PUT', `/v1/registers/${island.id}`, { name: 'Island till', locationId: null })).statusCode, 200);
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).statusCode, 200);
  }));

test('a transfer: off one shop when sent, on the way, on the other when received; cancelled goes back; never more than is there', () =>
  withBusiness(async (c) => {
    const soap = await item(c, 'Soap', '10');
    const oil = await item(c, 'Oil', '4');
    const loose = await item(c, 'Not tracked');
    const { main, other } = await twoShops(c);
    const send = (from: string, to: string, lines: Array<{ itemId: string; quantity: string }>) => call(c, 'POST', '/v1/transfers', { fromLocationId: from, toLocationId: to, lines, note: 'Friday boat' });

    assert.equal((await send(main, main, [{ itemId: soap, quantity: '1' }])).statusCode, 422);
    assert.match((await send(main, other, [{ itemId: soap, quantity: '11' }])).json().error.message, /only 10 at Belize City/);
    assert.match((await send(main, other, [{ itemId: loose, quantity: '1' }])).json().error.message, /not tracked/);
    assert.match((await send(other, main, [{ itemId: soap, quantity: '1' }])).json().error.message, /only 0 at San Pedro/);

    const sent = await send(main, other, [{ itemId: soap, quantity: '6' }, { itemId: oil, quantity: '1.5' }]);
    assert.equal(sent.statusCode, 201, sent.body);
    const t = sent.json();
    assert.deepEqual([t.number, t.status, t.from.name, t.to.name, t.lines.length, t.note], ['TR-0001', 'sent', 'Belize City', 'San Pedro', 2, 'Friday boat']);
    // On the way: the business still owns it, but it is on neither shelf.
    assert.deepEqual(await where(c, soap, main, other), [10, 4, 0, 6]);
    assert.deepEqual(await where(c, oil, main, other), [4, 2.5, 0, 1.5]);
    // The main shop cannot send what already left, and a count there is of what is on its shelf.
    assert.match((await send(main, other, [{ itemId: soap, quantity: '5' }])).json().error.message, /only 4 at Belize City/);
    await call(c, 'POST', '/v1/inventory/count', { counts: [{ itemId: soap, quantity: '3' }] });
    assert.deepEqual(await where(c, soap, main, other), [9, 3, 0, 6]);
    assert.equal((await call(c, 'PUT', `/v1/inventory/${oil}/settings`, { track: false })).json().error.code, 'on_the_way');
    assert.equal((await call(c, 'DELETE', `/v1/locations/${other}`)).json().error.code, 'on_the_way');
    assert.deepEqual((await call(c, 'GET', '/v1/transfers?status=sent')).json().data.map((x: { number: string }) => x.number), ['TR-0001']);

    // Received: on the other shop's shelf. Once.
    const received = await call(c, 'POST', `/v1/transfers/${t.id}/receive`);
    assert.deepEqual([received.statusCode, received.json().status], [200, 'received']);
    assert.deepEqual(await where(c, soap, main, other), [9, 3, 6, 0]);
    assert.equal((await call(c, 'POST', `/v1/transfers/${t.id}/receive`)).statusCode, 409);
    assert.equal((await call(c, 'POST', `/v1/transfers/${t.id}/cancel`)).statusCode, 409);
    const moves = (await stockOf(c, soap)).movements as Array<{ reason: string; change: number; balance: number; location: string; note: string }>;
    assert.deepEqual(moves.slice(0, 1).map((m) => [m.reason, m.change, m.balance, m.location, m.note]), [['transfer_in', 6, 9, 'San Pedro', 'TR-0001 from Belize City']]);
    assert.ok(moves.some((m) => m.reason === 'transfer_out' && m.change === -6 && m.location === 'Belize City' && m.note === 'TR-0001 to San Pedro'));

    // Some sent back, then cancelled before it left: it is where it was.
    const back = (await send(other, main, [{ itemId: soap, quantity: '2' }])).json();
    assert.equal(back.number, 'TR-0002');
    assert.deepEqual(await where(c, soap, main, other), [9, 3, 4, 2]);
    assert.equal((await call(c, 'POST', `/v1/transfers/${back.id}/cancel`)).json().status, 'cancelled');
    assert.deepEqual(await where(c, soap, main, other), [9, 3, 6, 0]);
    // And for real this time.
    const again = (await send(other, main, [{ itemId: soap, quantity: '2' }])).json();
    await call(c, 'POST', `/v1/transfers/${again.id}/receive`);
    assert.deepEqual(await where(c, soap, main, other), [9, 5, 4, 0]);

    // Who may: a cashier sees transfers but cannot send or receive.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cash@biz.example');
    assert.equal((await call(c, 'GET', '/v1/transfers', undefined, cashier)).statusCode, 200);
    assert.equal((await call(c, 'POST', '/v1/transfers', { fromLocationId: main, toLocationId: other, lines: [{ itemId: soap, quantity: '1' }] }, cashier)).statusCode, 403);
    assert.equal((await call(c, 'POST', '/v1/locations', { name: 'Mine' }, cashier)).statusCode, 403);
  }));

test('landed cost: freight and duty spread over a delivery by value, into each item’s cost', () =>
  withBusiness(async (c) => {
    // By value, to the cent: 300 of freight and duty over 1,000 and 3,000 of goods is 75 and 225.
    assert.deepEqual(spreadLanded([{ quantity: '100', unitCost: '10.00' }, { quantity: '50', unitCost: '60.00' }], [100000n, 300000n], 30000n), ['10.750000', '64.500000']);
    // Odd cents go to the largest line; nothing to spread leaves the costs as they are.
    assert.deepEqual(spreadLanded([{ quantity: '1', unitCost: '1.00' }, { quantity: '1', unitCost: '1.00' }, { quantity: '1', unitCost: '1.00' }], [100n, 100n, 100n], 100n), ['1.340000', '1.330000', '1.330000']);
    assert.deepEqual(spreadLanded([{ quantity: '2', unitCost: '5.00' }], [1000n], 0n), ['5.00']);

    const fan = await item(c, 'Fan');
    const tv = await item(c, 'Television');
    const got = await call(c, 'POST', '/v1/inventory/receipts', {
      supplierName: 'Miami Wholesale', reference: 'INV-9', receivedOn: today(),
      lines: [{ itemId: fan, quantity: '100', unitCost: '10.00' }, { itemId: tv, quantity: '50', unitCost: '60.00' }],
      landed: [{ label: 'Freight', amount: '120.00' }, { label: 'Import duty', amount: '150' }, { label: 'Customs broker', amount: '30.00' }, { label: 'Nothing', amount: '0' }],
      expense: { gstTreatment: 'none', paid: null, dueDate: today() },
    });
    assert.equal(got.statusCode, 201, got.body);
    // The supplier's bill is the goods; the cost on the shelf has the rest in it.
    assert.deepEqual([got.json().totalCost, got.json().landedCost], ['4000.00', '300.00']);
    assert.deepEqual([(await stockOf(c, fan)).averageCost, (await stockOf(c, fan)).value], ['10.75', '1075.00']);
    assert.deepEqual([(await stockOf(c, tv)).averageCost, (await stockOf(c, tv)).value], ['64.50', '3225.00']);
    const expense = (await call(c, 'GET', `/v1/expenses/${got.json().expenseId}`)).json();
    assert.equal(expense.total ?? expense.amount?.total, '4000.00');
    assert.equal((await call(c, 'GET', '/v1/inventory/receipts')).json().data[0].landedCost, '300.00');
    // Costs with nothing to spread them over are refused.
    const free = await call(c, 'POST', '/v1/inventory/receipts', { receivedOn: today(), lines: [{ itemId: fan, quantity: '1', unitCost: '0' }], landed: [{ label: 'Freight', amount: '5.00' }] });
    assert.equal(free.statusCode, 422);
  }));
