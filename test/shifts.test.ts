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

test('a sale paid partly by card and partly in cash: the parts must add up, the receipt lists them, the drawer counts only the cash', () =>
  withBusiness(async (c) => {
    const shift = (await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '0.00' } })).json().shift;
    // 40.00 plus 12.5% GST is 45.00.
    const sale = (tenders: Array<{ meansCode: string; amount: string }>, type = '02') =>
      c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type, lines: [line('40.00')], tenders, ...(type === '01' && { customer: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' } } }) } });
    const short = await sale([{ meansCode: '48', amount: '30.00' }, { meansCode: '10', amount: '10.00' }]);
    assert.equal(short.statusCode, 422);
    assert.equal(short.json().error.code, 'invalid_tenders');
    assert.match(short.json().error.message, /BZ\$40\.00, not the total BZ\$45\.00/);
    assert.equal((await sale([{ meansCode: '48', amount: '30.00' }, { meansCode: '10', amount: '15.00' }], '01')).statusCode, 422, 'only receipts');
    assert.equal((await c.f.db.query("select count(*)::int as n from documents where etd_type = '02'")).rows[0]!.n, 0, 'nothing was signed');

    const ok = await sale([{ meansCode: '48', amount: '30.00' }, { meansCode: '10', amount: '15.00' }]);
    assert.equal(ok.statusCode, 201, ok.body);
    const view = (await c.app.inject({ method: 'GET', url: `/v1/documents/${ok.json().id}/view`, headers: c.owner })).json();
    assert.ok(view.printed.info.includes('Terms: Paid BZ$30.00 card, BZ$15.00 cash'), JSON.stringify(view.printed.info));

    const report = (await c.app.inject({ method: 'GET', url: `/v1/shifts/${shift.id}`, headers: c.owner })).json().report;
    assert.equal(report.sales.card, '30.00');
    assert.equal(report.sales.cash, '15.00');
    assert.equal(report.cash.expected, '15.00');
    assert.equal(report.totalTakings, '45.00');
  }));

test('a cashier discounts within the limit the owner sets; managers and owners are not limited', () =>
  withBusiness(async (c) => {
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cass@biz.example');
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers: cashier, payload: { cashierDiscountLimit: '50' } })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers: c.owner, payload: { cashierDiscountLimit: '101' } })).statusCode, 400);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers: c.owner, payload: { cashierDiscountLimit: '10' } })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: cashier })).json().counter.cashierDiscountLimit, '10');

    const sale = (headers: Record<string, string>, allowanceCharges: unknown[]) => c.app.inject({
      method: 'POST', url: '/v1/documents', headers,
      payload: { type: '02', lines: [{ ...line('20.00'), allowanceCharges }], payment: { meansCode: '10', terms: 'Paid' } },
    });
    const over = await sale(cashier, [{ isCharge: false, reason: 'Discount', percent: '15' }]);
    assert.equal(over.statusCode, 403);
    assert.equal(over.json().error.code, 'discount_over_limit');
    // A line discount and a sale discount count together: 5% + 6% is over 10%.
    assert.equal((await sale(cashier, [{ isCharge: false, reason: 'Discount', percent: '5' }, { isCharge: false, reason: 'Sale discount 6%', percent: '6' }])).statusCode, 403);
    assert.equal((await sale(cashier, [{ isCharge: false, reason: 'Discount', amount: '2.00' }])).statusCode, 201, 'BZ$2 off BZ$20 is 10%');
    assert.equal((await sale(cashier, [{ isCharge: false, reason: 'Discount', percent: '10' }])).statusCode, 201);
    assert.equal((await sale(c.owner, [{ isCharge: false, reason: 'Discount', percent: '50' }])).statusCode, 201);

    // No limit again.
    await c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers: c.owner, payload: { cashierDiscountLimit: null } });
    assert.equal((await sale(cashier, [{ isCharge: false, reason: 'Discount', percent: '40' }])).statusCode, 201);
  }));

test('a mobile wallet is a way to pay of its own: on the receipt, in a split, and on its own line of the shift report', () =>
  withBusiness(async (c) => {
    const shift = (await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '20.00' } })).json().shift;
    // Paid on the customer's phone (DigiWallet, E-Kyash); the cashier types the confirmation number.
    const wallet = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('16.00')], payment: { meansCode: '68', terms: 'Paid by mobile wallet (ref DW-48213)' } } });
    assert.equal(wallet.statusCode, 201, wallet.body);
    const xml = (await c.f.db.query<{ signed_xml: string }>('select signed_xml from documents where id = $1', [wallet.json().id])).rows[0]!.signed_xml;
    assert.match(xml, /<cbc:PaymentMeansCode>68<\/cbc:PaymentMeansCode>/);
    assert.match(xml, /Paid by mobile wallet \(ref DW-48213\)/);
    // Part by wallet, the rest in cash.
    const split = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('40.00')], tenders: [{ meansCode: '68', amount: '30.00' }, { meansCode: '10', amount: '15.00' }] } });
    assert.equal(split.statusCode, 201, split.body);
    await receipt(c, c.owner, '8.00', '30');

    const r = (await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: c.owner })).json().report;
    assert.deepEqual([r.takings.wallet, r.takings.cash, r.takings.bank_transfer, r.takings.other, r.totalTakings], ['48.00', '15.00', '9.00', '0.00', '72.00'], 'wallet 18 + 30; cash 15; a bank transfer stays a bank transfer');
    assert.equal(r.cash.expected, '35.00', 'only the cash is in the drawer');
    // On the printed Z report too.
    const count = await c.app.inject({ method: 'POST', url: `/v1/shifts/${shift.id}/close`, headers: c.owner, payload: { countedCash: '35.00' } });
    assert.equal(count.statusCode, 200, count.body);
    const z = await c.app.inject({ method: 'GET', url: `/v1/shifts/${shift.id}/report.pdf`, headers: c.owner });
    assert.equal(z.statusCode, 200);
  }));

test('counter settings: US$ totals, a service charge and tips are set by owners, one at a time, and reach every till', () =>
  withBusiness(async (c) => {
    const put = (headers: Record<string, string>, payload: Record<string, unknown>) => c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers, payload });
    const counter = async () => (await c.app.inject({ method: 'GET', url: '/v1/me', headers: c.owner })).json().counter;
    assert.deepEqual(await counter(), { cashierDiscountLimit: null, loyalty: null, showUsd: false, serviceChargePercent: null, tips: false });

    const saved = await put(c.owner, { showUsd: true, serviceChargePercent: '10.00', tips: true });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json(), { cashierDiscountLimit: null, showUsd: true, serviceChargePercent: '10', tips: true });
    // A page that only knows the discount limit (a till not updated yet) changes only that.
    assert.equal((await put(c.owner, { cashierDiscountLimit: '5' })).statusCode, 200);
    assert.deepEqual(await counter(), { cashierDiscountLimit: '5', loyalty: null, showUsd: true, serviceChargePercent: '10', tips: true });
    assert.deepEqual((await put(c.owner, { serviceChargePercent: null })).json(), { cashierDiscountLimit: '5', showUsd: true, serviceChargePercent: null, tips: true });

    for (const bad of [{ serviceChargePercent: '45' }, { serviceChargePercent: '-1' }, { serviceChargePercent: 'ten' }, { showUsd: 'yes' }, {}, { other: true }]) {
      assert.equal((await put(c.owner, bad)).statusCode, 400, JSON.stringify(bad));
    }
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    assert.equal((await put(await c.login('cass@biz.example'), { tips: false })).statusCode, 403);
  }));

test('a service charge is part of the sale (on the receipt, with GST); a tip is not; the shift report says what is held for the staff', () =>
  withBusiness(async (c) => {
    await c.app.inject({ method: 'PUT', url: '/v1/counter-settings', headers: c.owner, payload: { serviceChargePercent: '10', tips: true } });
    await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '50.00' } });
    const service = { isCharge: true, reason: 'Service charge 10%', percent: '10' };
    const dinner = { type: '02', lines: [{ ...line('40.00'), description: 'Dinner for two', allowanceCharges: [service] }], payment: { meansCode: '48', terms: 'Paid by card' }, tip: { amount: '5.00', meansCode: '48' } };

    // What the till shows before the sale: the charge on its own, inside the subtotal.
    const preview = await c.app.inject({ method: 'POST', url: '/v1/documents/preview', headers: c.owner, payload: { ...dinner, tip: undefined } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().totals, { lineExtension: '44.00', gst: '5.50', tax: '5.50', taxInclusive: '49.50', payable: '49.50', charges: '4.00' });

    const sold = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: dinner });
    assert.equal(sold.statusCode, 201, sold.body);
    assert.equal(sold.json().totals.payable, '49.50', 'the tip is not in the total');
    const xml = (await c.f.db.query<{ signed_xml: string }>('select signed_xml from documents where id = $1', [sold.json().id])).rows[0]!.signed_xml;
    assert.match(xml, /<cbc:AllowanceChargeReason>Service charge 10%<\/cbc:AllowanceChargeReason>/);
    assert.ok(!xml.includes('5.00'), 'nothing of the tip on the tax document');

    // A discount and a service charge on the same line: both are counted, neither hides the other.
    const lunch = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [{ ...line('20.00'), allowanceCharges: [{ isCharge: false, reason: 'Discount', percent: '10' }, service] }], payment: { meansCode: '10', terms: 'Paid by cash' } } });
    assert.equal(lunch.statusCode, 201, lunch.body);
    assert.equal(lunch.json().totals.payable, '22.50', '20 − 2 + 2, plus GST');
    // A cash sale with no charge, and a tip left on a wallet payment.
    await receipt(c, c.owner, '8.00', '10');
    const coffee = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('8.00')], payment: { meansCode: '68', terms: 'Paid by mobile wallet' }, tip: { amount: '1.50', meansCode: '68' } } });
    assert.equal(coffee.statusCode, 201, coffee.body);

    const r = (await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: c.owner })).json().report;
    assert.deepEqual(r.serviceCharge, { count: 2, total: '6.00' });
    assert.deepEqual([r.tips.count, r.tips.total, r.tips.byMeans.card, r.tips.byMeans.wallet, r.tips.byMeans.cash], [2, '6.50', '5.00', '1.50', '0.00']);
    assert.deepEqual(r.discounts, { count: 1, total: '2.00' });
    assert.deepEqual([r.takings.card, r.takings.cash, r.takings.wallet, r.totalTakings], ['49.50', '31.50', '9.00', '90.00'], 'tips are not takings');
    assert.equal(r.cash.expected, '81.50', 'tips paid by card and wallet are not in the drawer');

    // A tip on a sale BTS rejects, or on an invoice, is not kept.
    const invoice = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '01', customer: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' } }, lines: [line('10.00')], payment: { meansCode: '30', dueDate: '2026-12-31' }, tip: { amount: '2.00', meansCode: '48' } } });
    assert.equal(invoice.statusCode, 201, invoice.body);
    assert.equal((await c.f.db.query('select 1 from sale_tips')).rows.length, 2);
  }));
