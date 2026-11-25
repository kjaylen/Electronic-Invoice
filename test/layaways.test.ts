/**
 * Layaway: goods put aside for a customer who pays over time. A tax invoice
 * whose goods stay in the shop until it is paid; payments against it; the
 * customer collecting; cancelling with the goods back on the shelf and the
 * money given back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, rejectedWith, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
type Headers = Record<string, string>;
interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Headers; cashier: Headers; other: Headers; customer: string; bike: string }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

const inDays = (n: number) => new Date(Date.now() - 6 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

async function withShop(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const login = async (tenantId: string, email: string, role: 'owner' | 'cashier') => {
    await createUser(f.db, { tenantId, name: email.split('@')[0]!, email, role, password: PASSWORD });
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  try {
    const owner = await login(f.tenantA, 'olive@shop.example', 'owner');
    const customer = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Marta Chan', contact: { telephone: '+501 610-2233' } } })).json().id as string;
    // A bicycle at BZ$200 before GST (BZ$225 with it), three in the shop.
    const bike = (await app.inject({ method: 'POST', url: '/v1/items', headers: owner, payload: { name: 'Bicycle', unitCode: 'H87', unitPrice: '200.00', gstCategory: 'S' } })).json().id as string;
    await app.inject({ method: 'PUT', url: `/v1/inventory/${bike}/settings`, headers: owner, payload: { track: true, quantity: '3' } });
    await app.inject({ method: 'POST', url: '/v1/shifts', headers: owner, payload: { openingFloat: '50.00' } });
    await fn({ f, app, owner, cashier: await login(f.tenantA, 'cass@shop.example', 'cashier'), other: await login(f.tenantB, 'omar@other.example', 'owner'), customer, bike });
  } finally {
    await app.close();
    await f.close();
  }
}

const layaway = (c: Ctx, headers: Headers, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  c.app.inject({ method: 'POST', url: '/v1/documents', headers, payload: { type: '01', customerId: c.customer, lines: [{ itemId: c.bike, quantity: '1' }], layaway: { holdUntil: inDays(28), deposit: { amount: '50.00', method: 'cash' }, ...over }, ...extra } });
const list = async (c: Ctx, headers: Headers, status = 'open') => (await c.app.inject({ method: 'GET', url: `/v1/layaways?status=${status}`, headers })).json();
const stock = async (c: Ctx) => (await c.app.inject({ method: 'GET', url: `/v1/inventory/${c.bike}`, headers: c.owner })).json().stock as number;
const report = async (c: Ctx) => (await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: c.owner })).json().report;

test('a layaway: a deposit now, the goods off the shelf, payments over time, collected when nothing is owed', () =>
  withShop(async (c) => {
    // What a layaway needs.
    for (const [payload, why] of [
      [{ type: '02', customerId: c.customer, lines: [{ itemId: c.bike, quantity: '1' }], payment: { meansCode: '10' }, layaway: { holdUntil: inDays(7) } }, /a tax invoice/],
      [{ type: '01', customer: { name: 'Someone' }, lines: [{ itemId: c.bike, quantity: '1' }], layaway: { holdUntil: inDays(7) } }, /needs a saved customer/],
      [{ type: '01', customerId: c.customer, lines: [{ itemId: c.bike, quantity: '1' }], layaway: { holdUntil: inDays(0) } }, /a day after today/],
      [{ type: '01', customerId: c.customer, lines: [{ itemId: c.bike, quantity: '1' }], layaway: { holdUntil: inDays(400) } }, /a year at most/],
    ] as const) {
      const res = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload });
      assert.equal(res.statusCode, 422, res.body);
      assert.match(res.json().error.message, why);
    }
    assert.equal(await stock(c), 3, 'nothing was taken for a layaway that did not start');

    // A cashier starts one: a tax invoice due the day the goods are kept until, with the deposit recorded.
    const made = await layaway(c, c.cashier, { note: 'Blue, for her son' });
    assert.equal(made.statusCode, 201, made.body);
    const invoice = made.json();
    assert.deepEqual([invoice.type, invoice.totals.payable, invoice.payment.status, invoice.payment.balance, invoice.payment.dueDate], ['01', '225.00', 'partial', '175.00', inDays(28)]);
    const xml = (await c.f.db.query<{ signed_xml: string }>('select signed_xml from documents where id = $1', [invoice.id])).rows[0]!.signed_xml;
    assert.match(xml, /Layaway: the goods are kept until paid in full/);
    assert.equal(await stock(c), 2, 'the bicycle is put aside');

    const open = await list(c, c.cashier);
    assert.deepEqual(open.summary, { open: 1, owed: '175.00', ready: 0, expired: 0 });
    const l = open.data[0];
    assert.deepEqual([l.id, l.status, l.customer.name, l.customer.phone, l.total, l.paid, l.balance, l.ready, l.holdUntil, l.daysLeft, l.note, l.createdBy],
      [invoice.id, 'open', 'Marta Chan', '+501 610-2233', '225.00', '50.00', '175.00', false, inDays(28), 28, 'Blue, for her son', 'cass']);
    assert.deepEqual(l.items, [{ description: 'Bicycle', quantity: '1' }]);
    // Another business sees nothing of it.
    assert.deepEqual((await list(c, c.other)).data, []);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/collect`, headers: c.other })).statusCode, 404);

    // Not collected while money is owed.
    const early = await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/collect`, headers: c.cashier });
    assert.equal(early.statusCode, 409);
    assert.match(early.json().error.message, /BZ\$175\.00 is still owed/);

    // She pays the rest in two visits: ordinary invoice payments.
    const pay = (amount: string, method: string) => c.app.inject({ method: 'POST', url: `/v1/documents/${invoice.id}/payments`, headers: c.owner, payload: { amount, method } });
    assert.equal((await pay('100.00', 'card')).statusCode, 201);
    assert.equal((await list(c, c.owner)).data[0].balance, '75.00');
    assert.equal((await pay('75.00', 'cash')).statusCode, 201);
    const paid = (await list(c, c.owner)).data[0];
    assert.deepEqual([paid.balance, paid.ready], ['0.00', true]);
    assert.deepEqual((await list(c, c.owner)).summary, { open: 1, owed: '0.00', ready: 1, expired: 0 });

    const collected = await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/collect`, headers: c.cashier });
    assert.equal(collected.statusCode, 200, collected.body);
    assert.equal(collected.json().status, 'collected');
    assert.ok(collected.json().collectedAt);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/collect`, headers: c.cashier })).statusCode, 409, 'once');
    assert.deepEqual((await list(c, c.owner)).data, []);
    assert.equal((await list(c, c.owner, 'collected')).data.length, 1);
    assert.equal(await stock(c), 2, 'the stock left when it was put aside, not again when it was collected');

    // The owner's drawer: the two later payments came in on her shift (the deposit was taken by the cashier, who has no drawer open).
    const r = await report(c);
    assert.deepEqual([r.invoicePayments.cash, r.invoicePayments.card, r.cash.expected], ['75.00', '100.00', '125.00']);
  }));

test('cancelling a layaway: a credit note for the whole invoice, the goods back on the shelf, the money given back', () =>
  withShop(async (c) => {
    const invoice = (await layaway(c, c.owner)).json();
    assert.equal(await stock(c), 2);
    // A cashier does not give money back or credit an invoice.
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/cancel`, headers: c.cashier, payload: { refundMethod: 'cash' } })).statusCode, 403);

    const cancelled = await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/cancel`, headers: c.owner, payload: { refundMethod: 'cash' } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.deepEqual([cancelled.json().status, cancelled.json().refunded, cancelled.json().balance], ['cancelled', '50.00', '0.00']);
    const credit = (await c.f.db.query<{ etd_type: string; payable_cents: string; referenced_etdui: string; status: string }>('select etd_type, payable_cents::text, referenced_etdui, status from documents where id = $1', [cancelled.json().creditNoteId])).rows[0]!;
    assert.deepEqual([credit.etd_type, credit.payable_cents, credit.referenced_etdui], ['04', '22500', invoice.etdui]);
    assert.equal(await stock(c), 3, 'back on the shelf');
    // The customer's account is square: nothing owed either way.
    const after = (await c.app.inject({ method: 'GET', url: `/v1/documents/${invoice.id}`, headers: c.owner })).json();
    assert.deepEqual([after.payment.status, after.payment.balance], ['paid', '0.00']);
    // And so is the drawer: 50 in, 50 out.
    assert.equal((await report(c)).cash.expected, '50.00');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/cancel`, headers: c.owner, payload: {} })).statusCode, 409, 'once');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/layaways/${invoice.id}/collect`, headers: c.owner })).statusCode, 409);
    assert.deepEqual((await list(c, c.owner)).summary, { open: 0, owed: '0.00', ready: 0, expired: 0 });

    // BTS rejects the credit note: the layaway stays open, nothing is given back, the goods stay put aside.
    const second = (await layaway(c, c.owner, { deposit: { amount: '30.00', method: 'card' } })).json();
    c.f.bts.script(SUBMIT_PATHS['04'], rejectedWith('283', 'Something wrong'));
    const refused = await c.app.inject({ method: 'POST', url: `/v1/layaways/${second.id}/cancel`, headers: c.owner, payload: { refundMethod: 'card' } });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, 'credit_rejected');
    const still = (await list(c, c.owner)).data[0];
    assert.deepEqual([still.id, still.status, still.paid, still.balance], [second.id, 'open', '30.00', '195.00']);
    assert.equal(await stock(c), 2);
  }));

test('a layaway does not need the customer’s credit: the goods stay in the shop; one past its day is flagged; a rejected invoice starts none', () =>
  withShop(async (c) => {
    // A customer allowed BZ$10 on account still puts a BZ$225 bicycle on layaway.
    await c.app.inject({ method: 'PUT', url: `/v1/customers/${c.customer}`, headers: c.owner, payload: { name: 'Marta Chan', contact: { telephone: '+501 610-2233' }, creditLimit: '10.00' } });
    const onAccount = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.cashier, payload: { type: '01', customerId: c.customer, lines: [{ itemId: c.bike, quantity: '1' }], payment: { meansCode: '30', dueDate: inDays(30) } } });
    assert.equal(onAccount.json().error.code, 'credit_limit', 'on account, the limit holds');
    const made = await layaway(c, c.cashier, { deposit: undefined });
    assert.equal(made.statusCode, 201, made.body);
    assert.equal(made.json().payment.balance, '225.00', 'no deposit: all of it is owed');

    // Its day passes with money still owed.
    await c.f.db.query(`update layaways set hold_until = (now() at time zone 'America/Belize')::date - 3 where document_id = $1`, [made.json().id]);
    const late = await list(c, c.owner);
    assert.equal(late.data[0].daysLeft, -3);
    assert.deepEqual(late.summary, { open: 1, owed: '225.00', ready: 0, expired: 1 });

    // An invoice BTS rejects is not a layaway, and takes no deposit.
    c.f.bts.script(SUBMIT_PATHS['01'], rejectedWith('283', 'Something wrong'));
    const rejected = await layaway(c, c.owner);
    assert.equal(rejected.statusCode, 201, rejected.body);
    assert.equal(rejected.json().status, 'rejected');
    assert.equal((await list(c, c.owner, 'all')).data.length, 1);
    assert.equal((await c.f.db.query('select 1 from invoice_payments')).rows.length, 0);
  }));
