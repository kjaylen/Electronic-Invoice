/**
 * Cash registers and shifts: open with a float, sales and invoice payments
 * attach to the shift, refunds and cash in/out, the drawer count against
 * what is expected, the end-of-day report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

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

const line = (price: string) => ({ description: 'Goods', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' });
const receipt = (c: Ctx, headers: Record<string, string>, price: string, meansCode: string) =>
  c.app.inject({ method: 'POST', url: '/v1/documents', headers, payload: { type: '02', lines: [line(price)], payment: { meansCode, terms: 'Paid' } } });

test('a day at the counter: float, sales by payment, an invoice payment, a refund, cash in and out, the count, the Z report', () =>
  withBusiness(async (c) => {
    // Opening the first shift creates the register.
    const opened = await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '100.00' } });
    assert.equal(opened.statusCode, 201, opened.body);
    const shift = opened.json().shift;
    assert.deepEqual([shift.number, shift.register.name, shift.openingFloat, shift.status], [1, 'Main register', '100.00', 'open']);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '50.00' } })).statusCode, 409, 'one open shift per person');

    const cash = await receipt(c, c.owner, '40.00', '10');
    assert.equal(cash.statusCode, 201, cash.body);
    await receipt(c, c.owner, '20.00', '48');
    const inv = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '01', customer: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' } }, lines: [line('100.00')], payment: { meansCode: '30', dueDate: '2026-12-31' } },
    });
    assert.equal(inv.statusCode, 201, inv.body);
    await c.app.inject({ method: 'POST', url: `/v1/documents/${inv.json().id}/payments`, headers: c.owner, payload: { amount: '50.00', method: 'cash' } });
    const refund = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '04', reference: { documentId: cash.json().id, reason: 'Returned' }, lines: [line('8.00')], payment: { meansCode: '10', terms: 'Refunded in cash' } },
    });
    assert.equal(refund.statusCode, 201, refund.body);
    const cashMove = (kind: string, amount: string, reason: string) => c.app.inject({ method: 'POST', url: `/v1/shifts/${shift.id}/cash`, headers: c.owner, payload: { kind, amount, reason } });
    assert.equal((await cashMove('pay_out', '20.00', 'Cleaning supplies')).statusCode, 201);
    assert.equal((await cashMove('pay_in', '10.00', 'Change from the bank')).statusCode, 201);
    await assert.rejects(c.f.db.query('delete from cash_movements'), /permanent/);

    const live = (await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: c.owner })).json();
    const r = live.report;
    assert.deepEqual(r.documents.map((d: { type: string; count: number; total: string }) => [d.type, d.count, d.total]), [['01', 1, '112.50'], ['02', 2, '67.50'], ['04', 1, '9.00']]);
    assert.equal(r.gst, '19.00');
    assert.deepEqual([r.takings.cash, r.takings.card, r.totalTakings], ['86.00', '22.50', '108.50'], 'cash 45 + invoice payment 50 − refund 9; card 22.50; the invoice on credit is not money in');
    assert.deepEqual([r.invoicePayments.cash, r.refunds.cash, r.refundCount], ['50.00', '9.00', 1]);
    assert.deepEqual(r.cash, { float: '100.00', in: '86.00', payIn: '10.00', payOut: '20.00', expected: '176.00', counted: null, difference: null });
    assert.equal((await c.f.db.query<{ payment_means: string }>('select payment_means from documents where id = $1', [cash.json().id])).rows[0]!.payment_means, '10');

    // Counting the drawer: the notes and coins must add up.
    const bad = await c.app.inject({ method: 'POST', url: `/v1/shifts/${shift.id}/close`, headers: c.owner, payload: { countedCash: '175.00', counted: { 100: 1, 50: 1 } } });
    assert.equal(bad.statusCode, 422);
    const closed = await c.app.inject({ method: 'POST', url: `/v1/shifts/${shift.id}/close`, headers: c.owner, payload: { countedCash: '175.00', counted: { 100: 1, 50: 1, 20: 1, 5: 1 }, note: 'One dollar short' } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.deepEqual([closed.json().shift.status, closed.json().shift.expectedCash, closed.json().shift.countedCash, closed.json().shift.difference], ['closed', '176.00', '175.00', '-1.00']);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/shifts/${shift.id}/close`, headers: c.owner, payload: { countedCash: '175.00' } })).statusCode, 409);
    assert.equal((await cashMove('pay_in', '1.00', 'Late')).statusCode, 409, 'a closed shift takes nothing more');

    // After closing, sales no longer attach to it.
    const later = await receipt(c, c.owner, '10.00', '10');
    assert.equal((await c.f.db.query<{ shift_id: string | null }>('select shift_id from documents where id = $1', [later.json().id])).rows[0]!.shift_id, null);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/shifts/${shift.id}`, headers: c.owner })).json().report.cash.counted, '175.00');

    for (const format of ['receipt', 'sheet']) {
      const pdf = await c.app.inject({ method: 'GET', url: `/v1/shifts/${shift.id}/report.pdf?format=${format}`, headers: c.owner });
      assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF', format);
    }
  }));

test('registers: one open shift per drawer; cashiers see their own shifts; managers close anyone’s', () =>
  withBusiness(async (c) => {
    const front = (await c.app.inject({ method: 'POST', url: '/v1/registers', headers: c.owner, payload: { name: 'Front counter' } })).json();
    const bar = (await c.app.inject({ method: 'POST', url: '/v1/registers', headers: c.owner, payload: { name: 'Bar' } })).json();
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/registers', headers: c.owner, payload: { name: 'bar' } })).statusCode, 409);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '50.00' } })).statusCode, 422, 'with several registers, choose one');

    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Manny', email: 'manny@biz.example', role: 'manager', password: PASSWORD });
    const cashier = await c.login('cash@biz.example');
    const manager = await c.login('manny@biz.example');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/registers', headers: cashier, payload: { name: 'Mine' } })).statusCode, 403);

    const mine = (await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: cashier, payload: { registerId: front.id, openingFloat: '80.00' } })).json().shift;
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { registerId: front.id, openingFloat: '80.00' } })).statusCode, 409, 'that drawer is in use');
    const own = await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { registerId: bar.id, openingFloat: '0' } });
    assert.equal(own.statusCode, 201);
    const regs = (await c.app.inject({ method: 'GET', url: '/v1/registers', headers: cashier })).json().data;
    assert.deepEqual(regs.map((r: { name: string; openBy: string | null }) => [r.name, r.openBy]), [['Bar', 'Olive'], ['Front counter', 'Cash']]);

    await receipt(c, cashier, '10.00', '10');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: cashier })).json().report.cash.expected, '91.25');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/shifts', headers: cashier })).json().data.length, 1, 'cashiers see their own');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/shifts', headers: c.owner })).json().data.length, 2);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/shifts/${own.json().shift.id}`, headers: cashier })).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/shifts/${own.json().shift.id}/close`, headers: cashier, payload: { countedCash: '0' } })).statusCode, 403);
    const byManager = await c.app.inject({ method: 'POST', url: `/v1/shifts/${mine.id}/close`, headers: manager, payload: { countedCash: '91.25' } });
    assert.deepEqual([byManager.statusCode, byManager.json().shift.difference, byManager.json().shift.closedBy], [200, '0.00', 'Manny']);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/registers/${bar.id}`, headers: c.owner })).statusCode, 409, 'an open drawer is not archived');
  }));
