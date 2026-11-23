/**
 * Repeating expenses: recorded on schedule (each date once, missed ones caught up), as bills or as
 * paid, until their end date; paused ones wait; deleting keeps what was recorded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { runRecurringExpenses } from '../src/api/recurring-expenses.ts';
import { createUser } from '../src/db/users.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const daysFrom = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('repeating expenses are recorded on schedule', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const today = belizeToday();
    const count = async (where = '') => (await f.db.query<{ n: number }>(`select count(*)::int as n from expenses where tenant_id = $1 ${where}`, [f.tenantA])).rows[0]!.n;

    // Weekly internet from three weeks ago, paid by transfer: four dates are due (3 weeks ago … today).
    const weekly = await app.inject({ method: 'POST', url: '/v1/recurring-expenses', headers: owner, payload: { supplierName: 'NetCo', category: 'Utilities', gstTreatment: 'standard', total: '112.50', frequency: 'weekly', startDate: daysFrom(today, -21), paidBy: 'bank_transfer' } });
    assert.equal(weekly.statusCode, 201, weekly.body);
    assert.equal(weekly.json().nextDate, daysFrom(today, 7));
    assert.equal(await count("and supplier_name = 'NetCo'"), 4);
    const one = (await f.db.query<{ net_cents: string; gst_cents: string; paid_on: string | null; payment_method: string }>(`select net_cents::text, gst_cents::text, paid_on::text, payment_method from expenses where supplier_name = 'NetCo' order by expense_date limit 1`)).rows[0]!;
    assert.deepEqual(one, { net_cents: '10000', gst_cents: '1250', paid_on: daysFrom(today, -21), payment_method: 'bank_transfer' });

    // Monthly rent starting next week: nothing yet. Then the day comes: a bill due 5 days later.
    const rent = (await app.inject({ method: 'POST', url: '/v1/recurring-expenses', headers: owner, payload: { supplierName: 'Landlord', category: 'Rent', gstTreatment: 'exempt', total: '1500', frequency: 'monthly', startDate: daysFrom(today, 7), dueDays: 5 } })).json();
    assert.equal(await count("and supplier_name = 'Landlord'"), 0);
    assert.deepEqual(await runRecurringExpenses(f.db, { today: daysFrom(today, 7) }), { recorded: 2 }); // rent, and the next week's internet
    const bill = (await f.db.query<{ due_date: string; paid_on: string | null }>(`select due_date::text, paid_on::text from expenses where supplier_name = 'Landlord'`)).rows[0]!;
    assert.deepEqual(bill, { due_date: daysFrom(today, 12), paid_on: null });
    // Once per date, even when run again.
    assert.deepEqual(await runRecurringExpenses(f.db, { today: daysFrom(today, 7) }), { recorded: 0 });

    // Paused: nothing is recorded; an end date stops it.
    const paused = await app.inject({ method: 'PUT', url: `/v1/recurring-expenses/${rent.id}`, headers: owner, payload: { supplierName: 'Landlord', category: 'Rent', gstTreatment: 'exempt', total: '1500', frequency: 'monthly', startDate: daysFrom(today, 40), dueDays: 5, active: false } });
    assert.equal(paused.json().active, false);
    assert.deepEqual(await runRecurringExpenses(f.db, { today: daysFrom(today, 45), tenantId: f.tenantA }), { recorded: 5 }); // only internet: 5 more weeks
    const list = (await app.inject({ method: 'GET', url: '/v1/recurring-expenses', headers: owner })).json();
    assert.equal(list.data.length, 2);
    assert.equal(list.monthly, '487.50'); // the running one: 112.50 × 52 / 12
    assert.equal((await app.inject({ method: 'GET', url: '/v1/recurring-expenses', headers: cashier })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/recurring-expenses', headers: owner, payload: { supplierName: 'X', category: 'Rent', gstTreatment: 'none', total: '10', frequency: 'monthly', startDate: today, endDate: daysFrom(today, -1) } })).statusCode, 422);

    // Deleted: what it recorded stays.
    const before = await count();
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/recurring-expenses/${weekly.json().id}`, headers: owner })).statusCode, 204);
    assert.equal(await count(), before);
  } finally {
    await app.close();
    await f.close();
  }
});
