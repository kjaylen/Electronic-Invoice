/**
 * Businesses that sell services: what the business sells (products, services
 * or both), and billable work logged for customers and invoiced in one go.
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
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>, options: { allowSignup?: boolean } = {}) {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, ...(options.allowSignup && { allowSignup: true }) });
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

const address = { street: '1 Main St', city: 'Belize City', districtCode: '1' };

test('what the business sells: both by default, chosen at sign-up, changed in settings', () =>
  withBusiness(async (c) => {
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: c.owner })).json().sells, 'both');
    const changed = await c.app.inject({ method: 'PUT', url: '/v1/business/sells', headers: c.owner, payload: { sells: 'services' } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().sells, 'services');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: c.owner })).json().sells, 'services');
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/business/sells', headers: c.owner, payload: { sells: 'everything' } })).statusCode, 400);
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cal', email: 'cal@biz.example', role: 'cashier', password: PASSWORD });
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/business/sells', headers: await c.login('cal@biz.example'), payload: { sells: 'products' } })).statusCode, 403);

    const signup = await c.app.inject({
      method: 'POST', url: '/v1/auth/signup', headers: CSRF,
      payload: { sells: 'services', business: { legalName: 'Belize Bookkeeping Ltd.', tin: '777888', address, contact: { telephone: '501-600-0000', email: 'hello@books.example' } }, owner: { name: 'Bea', email: 'bea@books.example', password: PASSWORD } },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    assert.equal((await c.f.db.query<{ sells: string }>('select sells from tenants where id = $1', [signup.json().business.id])).rows[0]!.sells, 'services');
  }, { allowSignup: true }));

test('billable work: logged per customer from a service or at its own rate, invoiced in one go, never twice', () =>
  withBusiness(async (c) => {
    const service = (await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name: 'Bookkeeping', unitCode: 'HUR', unitPrice: '75.00', gstCategory: 'S' } })).json();
    const client = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.owner, payload: { name: 'Corner Shop', tin: '111222', address, contact: { email: 'accounts@corner.example' } } })).json();
    const other = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.owner, payload: { name: 'Cafe', tin: '333444', address } })).json();
    const log = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/work', headers: c.owner, payload: body });

    const hours = await log({ customerId: client.id, date: today(), description: 'Monthly reconciliation', quantity: '2.5', itemId: service.id });
    assert.equal(hours.statusCode, 201, hours.body);
    assert.deepEqual([hours.json().unitCode, hours.json().unitPrice, hours.json().amount, hours.json().by], ['HUR', '75', '187.50', 'Olive'], 'the service fills the rate and unit');
    const job = await log({ customerId: client.id, date: today(), description: 'Payroll setup', quantity: '1', unitCode: 'E48', unitPrice: '150' });
    assert.equal(job.statusCode, 201, job.body);
    const mistake = (await log({ customerId: client.id, date: today(), description: 'Typo', quantity: '9', unitPrice: '1' })).json();
    await log({ customerId: other.id, date: today(), description: 'Menu costing', quantity: '1', itemId: service.id });
    assert.equal((await log({ customerId: client.id, date: today(), description: 'No rate', quantity: '1' })).json().error.code, 'price_required');
    assert.equal((await log({ customerId: client.id, date: today(), description: 'Nothing', quantity: '0', unitPrice: '5' })).json().error.code, 'invalid_quantity');

    // Corrected and removed while not invoiced.
    const fixed = await c.app.inject({ method: 'PUT', url: `/v1/work/${hours.json().id}`, headers: c.owner, payload: { customerId: client.id, date: today(), description: 'Monthly reconciliation and VAT check', quantity: '3', itemId: service.id } });
    assert.equal(fixed.json().amount, '225.00');
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/work/${mistake.id}`, headers: c.owner })).statusCode, 204);

    let list = (await c.app.inject({ method: 'GET', url: '/v1/work', headers: c.owner })).json();
    const corner = list.toInvoice.find((x: { customer: { id: string } }) => x.customer.id === client.id);
    assert.deepEqual([corner.entries, corner.hours, corner.amount], [2, '3', '375.00']);

    const invoiced = await c.app.inject({ method: 'POST', url: '/v1/work/invoice', headers: c.owner, payload: { customerId: client.id, dueDays: 15, note: 'November' } });
    assert.equal(invoiced.statusCode, 200, invoiced.body);
    assert.equal(invoiced.json().status, 'authorized');
    assert.equal(invoiced.json().invoiced, 2);
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${invoiced.json().documentId}`, headers: c.owner })).json();
    assert.equal(doc.type, '01');
    assert.equal(doc.lines.length, 2);
    assert.ok(doc.lines.some((l: { description: string; quantity: string; unitCode: string }) => l.description.endsWith('· Monthly reconciliation and VAT check') && l.unitCode === 'HUR' && Number(l.quantity) === 3));
    assert.equal(doc.totals.payable, '421.88', '375.00 + 12.5% GST');

    list = (await c.app.inject({ method: 'GET', url: '/v1/work?status=billed', headers: c.owner })).json();
    assert.equal(list.data.length, 2);
    assert.ok(list.data.every((w: { invoice: { documentId: string; number: string } }) => w.invoice.documentId === invoiced.json().documentId && /^\d{3}-\d{9}$/.test(w.invoice.number)));
    assert.equal(list.toInvoice.length, 1, 'only the cafe still has work to invoice');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/work/invoice', headers: c.owner, payload: { customerId: client.id } })).json().error.code, 'nothing_to_invoice', 'never twice');
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/work/${job.json().id}`, headers: c.owner })).statusCode, 409, 'invoiced work stays');
  }));

test('billable work: a rejected invoice leaves the work to invoice; who may log, invoice and see it', () =>
  withBusiness(async (c) => {
    const client = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.owner, payload: { name: 'Corner Shop', tin: '111222', address } })).json();
    const entry = (await c.app.inject({ method: 'POST', url: '/v1/work', headers: c.owner, payload: { customerId: client.id, date: today(), description: 'Site visit', quantity: '1', unitCode: 'E48', unitPrice: '80' } })).json();
    c.f.bts.script(SUBMIT_PATHS['01'], rejectedWith('A01', 'Rejected for the test'));
    const rejected = await c.app.inject({ method: 'POST', url: '/v1/work/invoice', headers: c.owner, payload: { customerId: client.id, entryIds: [entry.id] } });
    assert.equal(rejected.json().status, 'rejected');
    assert.equal(rejected.json().invoiced, 0);
    const still = (await c.app.inject({ method: 'GET', url: '/v1/work', headers: c.owner })).json();
    assert.equal(still.data[0].invoice, null, 'still to invoice');
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/work/invoice', headers: c.owner, payload: { customerId: client.id, entryIds: [entry.id] } })).json().invoiced, 1);

    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Ava', email: 'ava@biz.example', role: 'accountant', password: PASSWORD });
    const accountant = await c.login('ava@biz.example');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/work?status=all', headers: accountant })).statusCode, 200, 'accountants see it');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/work', headers: accountant, payload: { customerId: client.id, date: today(), description: 'x', quantity: '1', unitPrice: '1' } })).statusCode, 403);
  }));
