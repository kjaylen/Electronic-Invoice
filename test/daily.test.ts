/**
 * The morning summary email: what it says about a day, once per day, only when turned on, and
 * not before 7 am Belize time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { createMailService } from '../src/mail/service.ts';
import { dailySummary, runDailySummaries } from '../src/notify/daily.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/** Today in Belize, and 8 am Belize time the next morning. */
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const nextMorning = (hourBelize: number) => {
  const tomorrow = new Date(new Date(`${belizeToday()}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  return new Date(`${tomorrow}T${String(hourBelize + 6).padStart(2, '0')}:00:00Z`);
};

test('the daily summary: sales against last week, how customers paid, best sellers, discounts; sent once, only when on, from 7 am', async () => {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const line = (description: string, price: string, extra: Record<string, unknown> = {}) => ({ description, quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S', ...extra });
    const sell = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '02', ...payload } });

    // 45.00 cash; 22.50 by card for coffee with 10% off (20 x 0.9 = 18 + GST); 45.00 split 30 card + 15 cash.
    const first = await sell({ lines: [line('Coffee beans', '40.00')], payment: { meansCode: '10', terms: 'Paid' } });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((await sell({ lines: [line('Cappuccino', '20.00', { allowanceCharges: [{ isCharge: false, reason: 'Discount', percent: '10' }] })], payment: { meansCode: '48', terms: 'Paid' } })).statusCode, 201);
    assert.equal((await sell({ lines: [line('Coffee beans', '40.00')], tenders: [{ meansCode: '48', amount: '30.00' }, { meansCode: '10', amount: '15.00' }] })).statusCode, 201);

    const s = (await dailySummary(f.db, f.tenantA, belizeToday()))!;
    assert.equal(s.sales.receipts, 3);
    assert.equal(s.sales.net, 11025n); // 45.00 + 20.25 + 45.00
    assert.equal(s.taken.cash, 6000n);
    assert.equal(s.taken.card, 5025n);
    assert.deepEqual(s.bestSellers.map((b) => [b.name, b.quantity]), [['Coffee beans', 2], ['Cappuccino', 1]]);
    assert.deepEqual(s.discounts, { count: 1, total: 200n });
    assert.equal(await dailySummary(f.db, f.tenantA, '2001-01-01'), null, 'a quiet day says nothing');

    // The same day in the reports: by person and by hour.
    const period = `from=${belizeToday()}&to=${belizeToday()}`;
    const staff = (await app.inject({ method: 'GET', url: `/v1/reports/staff?${period}`, headers: owner })).json().data;
    assert.deepEqual(staff, [{ name: 'Olive', documents: 3, total: '110.25', discounts: '2.00', receipts: 3, averageReceipt: '36.75' }]);
    const csv = await app.inject({ method: 'GET', url: `/v1/reports/staff?${period}&format=csv`, headers: owner });
    assert.match(csv.body, /Olive/);
    const hours = (await app.inject({ method: 'GET', url: `/v1/reports/hours?${period}`, headers: owner })).json().data as Array<{ documents: number }>;
    assert.equal(hours.reduce((a, h) => a + h.documents, 0), 3);

    // Bills to pay and late deliveries, as of the next morning.
    const morning = new Date(new Date(`${belizeToday()}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    const bill = (due: string, cents: number) => f.db.query(
      `insert into expenses (id, tenant_id, supplier_name, expense_date, due_date, category, gst_treatment, net_cents, gst_cents, total_cents)
       values (gen_random_uuid(), $1, 'Roaster', $2::date, $3::date, 'Stock for resale', 'none', $4, 0, $4)`, [f.tenantA, belizeToday(), due, cents]);
    await bill(belizeToday(), 2000);
    await bill(morning, 1000);
    await f.db.query(`insert into purchase_orders (id, tenant_id, number, supplier_name, status, expected_on) values (gen_random_uuid(), $1, 7, 'Roaster', 'sent', $2::date)`, [f.tenantA, belizeToday()]);
    const later = (await dailySummary(f.db, f.tenantA, belizeToday()))!;
    assert.deepEqual(later.bills, { overdue: 1, overdueTotal: 2000n, dueSoon: 1, dueSoonTotal: 1000n });
    assert.deepEqual(later.lateOrders, ['PO-7 (Roaster)']);

    const mail = memoryMailer();
    // Through the mail service, as the server sends it: the service adds the way to stop these emails.
    const mailer = await createMailService(f.db, f.deps.keys, { transport: mail, publicUrl: 'https://app.example.test' });
    // Off by default.
    assert.deepEqual(await runDailySummaries(f.db, { mailer, now: nextMorning(8) }), { sent: 0, failed: 0 });
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/business/daily-summary', headers: owner, payload: { dailySummary: true } })).json().dailySummary, true);
    // Not before 7 am.
    assert.deepEqual(await runDailySummaries(f.db, { mailer, now: nextMorning(6) }), { sent: 0, failed: 0 });
    assert.deepEqual(await runDailySummaries(f.db, { mailer, now: nextMorning(8), publicUrl: 'https://app.example.test' }), { sent: 1, failed: 0 });
    const email = mail.sent.at(-1)!;
    assert.equal(email.to, 'olive@biz.example');
    assert.match(email.subject, /: BZ\$110\.25 in sales \w+day \d+ \w+$/);
    assert.match(email.text, /Sales: BZ\$110\.25 from 3 receipts\. GST: BZ\$12\.25\./);
    assert.match(email.text, /Taken: cash BZ\$60\.00, card BZ\$50\.25\./);
    assert.match(email.text, /Best sellers: Coffee beans \(2, BZ\$80\.00\), Cappuccino \(1, BZ\$18\.00\)\./);
    assert.match(email.text, /Discounts given: BZ\$2\.00 on 1 sale\./);
    assert.match(email.text, /Bills to pay: 1 bill for BZ\$10\.00 due by tomorrow; 1 bill for BZ\$20\.00 overdue\./);
    assert.match(email.text, /Late deliveries: PO-7 \(Roaster\)\./);
    assert.ok(email.text.includes(`https://app.example.test/${slug}/reports`));
    // Not transactional: it says how to stop it, in the text, in the HTML and for the mail app's own button.
    assert.match(email.headers!['List-Unsubscribe']!, /^<https:\/\/app\.example\.test\/v1\/mail\/unsubscribe\/[A-Za-z0-9_-]+>$/);
    assert.equal(email.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(email.text, /To stop getting these emails: https:\/\/app\.example\.test\/v1\/mail\/unsubscribe\//);
    assert.match(email.html!, /Stop getting these emails<\/a>/);
    assert.equal(email.from, '"Floreo" <no-reply@localhost>');
    // Once a day.
    assert.deepEqual(await runDailySummaries(f.db, { mailer, now: nextMorning(9) }), { sent: 0, failed: 0 });
  } finally {
    await app.close();
    await f.close();
  }
});

test('a customer at a glance: what they bought, what they owe, recent documents, favourite items', async () => {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const customer = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Hotel San Ignacio Ltd.', tin: '777888', address: { street: '18 Buena Vista', city: 'San Ignacio', districtCode: '2' } } })).json();
    const line = (description: string, price: string) => ({ description, quantity: '2', unitCode: 'H87', unitPrice: price, gstCategory: 'S' });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '02', customerId: customer.id, lines: [line('Coffee beans', '20.00')], payment: { meansCode: '10', terms: 'Paid' } } })).statusCode, 201);
    const inv = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '01', customerId: customer.id, lines: [line('Coffee beans', '20.00'), line('Mugs', '10.00')], payment: { meansCode: '30', dueDate: '2099-12-31' } } });
    assert.equal(inv.statusCode, 201, inv.body);

    const s = (await app.inject({ method: 'GET', url: `/v1/customers/${customer.id}/summary`, headers: owner })).json();
    assert.equal(s.customer.name, 'Hotel San Ignacio Ltd.');
    assert.deepEqual([s.sales.documents, s.sales.lifetime, s.sales.thisYear], [2, '112.50', '112.50']); // 45.00 + 67.50
    assert.deepEqual([s.owed.total, s.owed.overdue, s.owed.invoices.length], ['67.50', '0.00', 1]);
    assert.equal(s.recent.length, 2);
    assert.deepEqual(s.topItems[0], { name: 'Coffee beans', quantity: '4', total: '90.00' });
    assert.equal(s.key, `c:${customer.id}`);
  } finally {
    await app.close();
    await f.close();
  }
});
