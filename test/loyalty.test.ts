/**
 * Loyalty points: earned on sales to saved customers, used as a reward (a discount that lowers the
 * total by its value), taken back by credit notes, undone for cancelled documents, adjusted by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { reverseVoidedLoyalty } from '../src/api/loyalty.ts';
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

test('loyalty points: earn, use, take back, undo, adjust', async () => {
  const f = await setupPipeline();
  for (const t of ['02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = owner) => app.inject({ method, url, headers, ...(payload && { payload }) });
    const customer = (await call('POST', '/v1/customers', { name: 'Ana', tin: '333444', address: { street: '1 Main St', city: 'Belize City', districtCode: '1' } })).json() as { id: string };
    const line = (price: string) => ({ description: 'Coffee beans', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' });
    const receipt = (price: string, extra: Record<string, unknown> = {}, headers = owner) =>
      call('POST', '/v1/documents', { type: '02', customerId: customer.id, lines: [line(price)], payment: { meansCode: '10', terms: 'Paid' }, ...extra }, headers);
    const balance = async () => (await call('GET', `/v1/customers/${customer.id}/loyalty`)).json().balance as number;

    // Off: nothing is earned, and points cannot be used.
    assert.equal((await receipt('10.00')).statusCode, 201);
    assert.equal(await balance(), 0);
    assert.equal((await receipt('10.00', { redeemPoints: 10 })).statusCode, 422);

    // On: 1 point per BZ$1, a point worth 10 cents, at least 50 used at a time.
    assert.equal((await call('PUT', '/v1/loyalty-settings', { enabled: true, earnRate: '1', pointValue: '0.10', minRedeem: 50 }, cashier)).statusCode, 403);
    const set = await call('PUT', '/v1/loyalty-settings', { enabled: true, earnRate: '1', pointValue: '0.10', minRedeem: 50 });
    assert.equal(set.statusCode, 200, set.body);
    const first = (await receipt('100.00')).json() as { id: string };
    assert.equal(await balance(), 112); // BZ$112.50 paid

    // The preview shows the reward: 60 points = BZ$6.00 off the BZ$112.50 total.
    const preview = (await call('POST', '/v1/documents/preview', { type: '02', customerId: customer.id, lines: [line('100.00')], redeemPoints: 60 })).json();
    assert.equal(preview.totals.taxInclusive, '106.50');
    // Too few, or more than they have.
    assert.equal((await receipt('100.00', { redeemPoints: 40 })).json().error.code, 'not_enough_points');
    assert.equal((await receipt('100.00', { redeemPoints: 500 })).json().error.code, 'not_enough_points');

    // A cashier limited to 5% off can still use a 6% reward: it is not their discount.
    await call('PUT', '/v1/counter-settings', { cashierDiscountLimit: '5' });
    const used = await receipt('100.00', { redeemPoints: 60 }, cashier);
    assert.equal(used.statusCode, 201, used.body);
    const view = (await call('GET', `/v1/documents/${used.json().id}/view`)).json().view;
    assert.equal(view.totals.taxInclusive ?? used.json().totals.taxInclusive, '106.50');
    assert.equal(await balance(), 112 - 60 + 106);

    // A credit note of BZ$56.25 (50 + GST) takes back 56 points.
    const credit = await call('POST', '/v1/documents', { type: '04', reference: { documentId: first.id, reason: 'Returned' }, lines: [line('50.00')], payment: { meansCode: '10', terms: 'Refund' } });
    assert.equal(credit.statusCode, 201, credit.body);
    assert.equal(await balance(), 158 - 56);

    // The reward receipt cancelled: its 60 points come back and its 106 go.
    await f.db.query("update documents set status = 'cancelled' where id = $1", [used.json().id]);
    assert.equal(await reverseVoidedLoyalty(f.db), 2);
    assert.equal(await reverseVoidedLoyalty(f.db), 0, 'once');
    assert.equal(await balance(), 102 + 60 - 106);

    // By hand, with a note; never below zero.
    assert.equal((await call('POST', `/v1/customers/${customer.id}/loyalty/adjust`, { points: 25, note: 'Welcome bonus' })).json().balance, 81);
    assert.equal((await call('POST', `/v1/customers/${customer.id}/loyalty/adjust`, { points: -500, note: 'Oops' })).statusCode, 422);
    const info = (await call('GET', `/v1/customers/${customer.id}/loyalty`)).json();
    assert.deepEqual([info.balance, info.value], [81, '8.10']);
    assert.equal(info.entries[0].reason, 'adjusted');
    const me = (await call('GET', '/v1/me', undefined, cashier)).json();
    assert.deepEqual(me.counter.loyalty, { pointValue: '0.10', minRedeem: 50 });
  } finally {
    await app.close();
    await f.close();
  }
});
