/**
 * Money out: suppliers, expenses and bills with receipts; the GST return
 * worksheet (GST on sales against claimable GST on purchases) and profit and
 * loss.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { gstInside } from '../src/api/expenses.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - 6 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
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

// The smallest valid-looking files: a JPEG and a PDF header.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString('base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 32)]).toString('base64');

test('GST inside a standard-rated total', () => {
  assert.equal(gstInside(11250n), 1250n);
  assert.equal(gstInside(10000n), 1111n);
  assert.equal(gstInside(100n), 11n);
  assert.equal(gstInside(0n), 0n);
});

test('expenses and bills: suppliers, GST worked out, claimable only with a TIN, receipts, paying, who may', () =>
  withBusiness(async (c) => {
    const sup = await c.app.inject({ method: 'POST', url: '/v1/suppliers', headers: c.owner, payload: { name: 'Belize Wholesale Ltd.', tin: '123456', email: 'sales@bzw.example' } });
    assert.equal(sup.statusCode, 201, sup.body);
    const add = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/expenses', headers: c.owner, payload: body });

    const stock = await add({ supplierId: sup.json().id, reference: 'INV-5521', date: today(), category: 'Stock for resale', gstTreatment: 'standard', total: '112.50', paid: { on: today(), method: 'bank_transfer' } });
    assert.equal(stock.statusCode, 201, stock.body);
    assert.deepEqual([stock.json().net, stock.json().gst, stock.json().claimableGst, stock.json().supplier.tin], ['100.00', '12.50', '12.50', '123456']);

    const lunch = await add({ supplierName: 'Corner cafe', date: today(), category: 'Meals and entertainment', gstTreatment: 'standard', total: '56.25', paid: { on: today(), method: 'cash' } });
    assert.deepEqual([lunch.json().gst, lunch.json().claimableGst], ['6.25', '0.00'], 'no supplier TIN: the GST is a cost, not claimed');
    const rounded = await add({ supplierName: 'Hardware', supplierTin: '654321', date: today(), category: 'Repairs and maintenance', gstTreatment: 'standard', total: '10.00', gst: '1.12' });
    assert.deepEqual([rounded.json().net, rounded.json().gst], ['8.88', '1.12'], 'the receipt’s own GST figure wins');
    const rent = await add({ supplierName: 'Landlord', date: daysAgo(20), dueDate: daysAgo(5), category: 'Rent', gstTreatment: 'exempt', total: '1500.00' });
    assert.deepEqual([rent.json().gst, rent.json().paid, rent.json().overdue], ['0.00', null, true], 'an unpaid bill, past due');

    assert.equal((await add({ supplierName: 'X', date: '2099-01-01', category: 'Other', gstTreatment: 'none', total: '1.00' })).statusCode, 422, 'not in the future');
    assert.equal((await add({ supplierName: 'X', date: today(), category: 'Other', gstTreatment: 'zero', total: '10.00', gst: '1.00' })).statusCode, 422, 'GST only on standard-rated');
    assert.equal((await add({ date: today(), category: 'Other', gstTreatment: 'none', total: '1.00' })).statusCode, 422, 'a supplier is needed');
    assert.equal((await add({ supplierName: 'X', date: today(), category: 'Other', gstTreatment: 'standard', total: '10.00', gst: '10.00' })).statusCode, 422);

    // Bills to pay.
    const unpaid = (await c.app.inject({ method: 'GET', url: '/v1/expenses?status=unpaid', headers: c.owner })).json();
    assert.deepEqual([unpaid.data.length, unpaid.totals.unpaid, unpaid.totals.overdue], [2, '1510.00', '1500.00']);
    const paid = await c.app.inject({ method: 'POST', url: `/v1/expenses/${rent.json().id}/pay`, headers: c.owner, payload: { paidOn: today(), method: 'cheque' } });
    assert.deepEqual([paid.json().paid, paid.json().overdue, paid.json().dueDate], [{ on: today(), method: 'cheque' }, false, daysAgo(5)]);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/expenses/${rent.json().id}/pay`, headers: c.owner, payload: { paidOn: today(), method: 'cheque' } })).statusCode, 409);

    // Receipts: photos or PDFs, private.
    const up = await c.app.inject({ method: 'POST', url: `/v1/expenses/${stock.json().id}/receipt`, headers: c.owner, payload: { dataBase64: JPEG } });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal(up.json().receipt.contentType, 'image/jpeg');
    const got = await c.app.inject({ method: 'GET', url: `/v1/expenses/${stock.json().id}/receipt`, headers: c.owner });
    assert.deepEqual([got.statusCode, got.headers['content-type'], got.headers['cache-control']], [200, 'image/jpeg', 'private, no-store']);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/expenses/${rent.json().id}/receipt`, headers: c.owner, payload: { dataBase64: PDF } })).json().receipt.contentType, 'application/pdf');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/expenses/${rent.json().id}/receipt`, headers: c.owner, payload: { dataBase64: Buffer.from('<html>not a receipt</html>').toString('base64') } })).statusCode, 422);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/expenses/${rent.json().id}/receipt`, headers: c.owner })).json().receipt, null);

    const all = (await c.app.inject({ method: 'GET', url: `/v1/expenses?from=${daysAgo(30)}&to=${today()}`, headers: c.owner })).json();
    assert.deepEqual([all.totals.count, all.totals.total, all.totals.claimableGst], [4, '1678.75', '13.62']);
    const csv = await c.app.inject({ method: 'GET', url: '/v1/expenses.csv', headers: c.owner });
    assert.match(csv.body, /Belize Wholesale Ltd\.,123456,INV-5521,Stock for resale,,standard,100\.00,12\.50,112\.50,12\.50/);
    const cats = (await c.app.inject({ method: 'GET', url: '/v1/expense-categories', headers: c.owner })).json();
    assert.ok(cats.used.includes('Rent') && cats.data.includes('Fuel and transport'));
    const sups = (await c.app.inject({ method: 'GET', url: '/v1/suppliers?q=whole', headers: c.owner })).json();
    assert.deepEqual([sups.data.length, sups.data[0].spent], [1, '112.50']);

    // Accountants keep the books; cashiers do not.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Acct', email: 'acct@biz.example', role: 'accountant', password: PASSWORD });
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    const acct = await c.login('acct@biz.example');
    const cashier = await c.login('cash@biz.example');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/expenses', headers: acct, payload: { supplierName: 'BEL', date: today(), category: 'Electricity', gstTreatment: 'standard', total: '225.00' } })).statusCode, 201);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/expenses', headers: cashier, payload: { supplierName: 'BEL', date: today(), category: 'Electricity', gstTreatment: 'standard', total: '225.00' } })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/expenses', headers: cashier })).statusCode, 403);

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/expenses/${lunch.json().id}`, headers: c.owner })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/expenses/${lunch.json().id}`, headers: c.owner })).statusCode, 404);
  }));

test('GST return: GST on sales less claimable GST on purchases; profit and loss by month', () =>
  withBusiness(async (c) => {
    const customer = { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' } };
    const inv = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '01', customer, lines: [{ description: 'Consulting', quantity: '2', unitCode: 'HUR', unitPrice: '100.00', gstCategory: 'S' }, { description: 'Export freight', quantity: '1', unitCode: 'EA', unitPrice: '50.00', gstCategory: 'Z' }], payment: { meansCode: '30', dueDate: '2026-12-31' } },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const credit = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '04', reference: { documentId: inv.json().id, reason: 'Discount' }, lines: [{ description: 'Discount', quantity: '1', unitCode: 'EA', unitPrice: '40.00', gstCategory: 'S' }], payment: { terms: 'Credited' } },
    });
    assert.equal(credit.statusCode, 201, credit.body);
    const add = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/expenses', headers: c.owner, payload: body });
    await add({ supplierName: 'Wholesaler', supplierTin: '123456', date: today(), category: 'Stock for resale', gstTreatment: 'standard', total: '112.50' });
    await add({ supplierName: 'Corner cafe', date: today(), category: 'Meals and entertainment', gstTreatment: 'standard', total: '56.25' });
    await add({ supplierName: 'Landlord', date: today(), category: 'Rent', gstTreatment: 'exempt', total: '300.00' });

    const q = `from=${monthStart()}&to=${today()}`;
    const r = (await c.app.inject({ method: 'GET', url: `/v1/reports/gst-return?${q}`, headers: c.owner })).json();
    assert.deepEqual(r.sales.standard, { net: '160.00', gst: '20.00' }, '200 less the 40 credit note');
    assert.deepEqual([r.sales.zero.net, r.sales.documents], ['50.00', 2]);
    assert.deepEqual(r.purchases.claimable, { net: '100.00', gst: '12.50' });
    assert.deepEqual(r.purchases.notClaimable, { net: '50.00', gst: '6.25' });
    assert.equal(r.purchases.exempt.net, '300.00');
    assert.deepEqual([r.outputGst, r.inputGst, r.net], ['20.00', '12.50', '7.50']);
    assert.ok(r.warnings.some((w: string) => /no supplier TIN/.test(w)));
    assert.ok(r.warnings.some((w: string) => /test environment/.test(w)));

    const csv = await c.app.inject({ method: 'GET', url: `/v1/reports/gst-return?${q}&format=csv`, headers: c.owner });
    assert.match(csv.body, /GST to pay for the period,,7\.50/);
    const pdf = await c.app.inject({ method: 'GET', url: `/v1/reports/gst-return.pdf?${q}`, headers: c.owner });
    assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');

    const pl = (await c.app.inject({ method: 'GET', url: `/v1/reports/profit?${q}`, headers: c.owner })).json();
    // Income: 160 + 50 net. Costs: 100 (GST claimed) + 56.25 (GST not claimable is a cost) + 300.
    assert.deepEqual(pl.totals, { income: '210.00', expenses: '456.25', profit: '-246.25' });
    assert.equal(pl.months.length, 1);
    assert.deepEqual(pl.categories[0], { category: 'Rent', amount: '300.00' });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/reports/profit?from=${today()}&to=${monthStart()}T`, headers: c.owner })).statusCode, 400);
  }));
