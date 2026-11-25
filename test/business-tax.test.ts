/**
 * Business tax and what is due when: the worksheet (receipts by kind, the
 * rate for each, less contract tax withheld), its settings, the list of what
 * is coming up, and the once-a-month reminder by email.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { dueDates, nextOccurrence, nextReturn, percentOfCents, returnDueOn, taxSettings } from '../src/api/business-tax.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { dueLine, runFilingReminders } from '../src/notify/filing.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const address = { street: '1 Main St', city: 'Belmopan', districtCode: '2' };

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }
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
const call = (c: Ctx, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = c.owner) => c.app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });

/** A shop that also rents out a room and does some consulting, with a month of sales. */
async function mixedBusiness(c: Ctx) {
  const item = async (name: string, price: string, category?: string) => {
    const r = await call(c, 'POST', '/v1/items', { name, unitCode: 'H87', unitPrice: price, gstCategory: 'S', ...(category && { category }) });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const soap = await item('Soap', '10.00');
  const room = await item('Room for a night', '200.00', 'Rentals');
  const advice = await item('Advice, one day', '500.00', 'Consulting');
  const saved = await call(c, 'PUT', '/v1/tax-settings', { kinds: [{ name: 'Trade or business', rate: '1.75' }, { name: 'Rents', rate: '3', categories: ['rentals'] }, { name: 'Profession or vocation', rate: '6.0', categories: ['Consulting', 'Rentals'] }] });
  assert.equal(saved.statusCode, 200, saved.body);
  // Tidy: the first kind takes what is left; a category belongs to one kind; rates without trailing zeros.
  assert.deepEqual(saved.json().kinds, [{ name: 'Trade or business', rate: '1.75', categories: [] }, { name: 'Rents', rate: '3', categories: ['rentals'] }, { name: 'Profession or vocation', rate: '6', categories: ['Consulting'] }]);
  const receipt = await call(c, 'POST', '/v1/documents', { type: '02', lines: [{ itemId: soap, quantity: '3' }, { itemId: room, quantity: '1' }, { description: 'Typed in at the counter', quantity: '1', unitCode: 'H87', unitPrice: '4.00', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Paid in cash' } });
  assert.equal(receipt.statusCode, 201, receipt.body);
  const ministry = (await call(c, 'POST', '/v1/customers', { name: 'Ministry of Works', tin: '100200', address, withholdsContractTax: true })).json();
  const invoice = await call(c, 'POST', '/v1/documents', { type: '01', customerId: ministry.id, lines: [{ itemId: advice, quantity: '1' }], payment: { meansCode: '30', dueDate: '2099-12-31' }, contractTax: true });
  assert.equal(invoice.statusCode, 201, invoice.body);
  // One soap comes back.
  const credit = await call(c, 'POST', '/v1/documents', { type: '04', lines: [{ itemId: soap, quantity: '1' }], reference: { documentId: receipt.json().id, reason: 'Returned' }, payment: { meansCode: '10', terms: 'Refunded in cash' } });
  assert.equal(credit.statusCode, 201, credit.body);
  return { soap, room, advice };
}

test('business tax: the pieces', () => {
  // Nothing saved: one kind, trade at 1.75%; both returns filed; the reminder on.
  assert.deepEqual(taxSettings(null), { kinds: [{ name: 'Trade or business', rate: '1.75', categories: [] }], gstReturn: true, businessTax: true, email: true, dates: [] });
  assert.equal(taxSettings({ kinds: [{ name: 'x', rate: 'lots' }], email: false }).kinds[0]!.name, 'Trade or business');
  assert.equal(taxSettings({ email: false }).email, false);
  // To the cent, half up.
  assert.equal(percentOfCents(1000n, '1.75'), 18n);
  assert.equal(percentOfCents(100000n, '1.75'), 1750n);
  assert.equal(percentOfCents(50000n, '6'), 3000n);
  assert.equal(percentOfCents(-1000n, '1.75'), -18n);
  assert.equal(percentOfCents(0n, '24.5'), 0n);
  // A month's return is due on the 15th of the next.
  assert.equal(returnDueOn('2026-11-30'), '2026-12-15');
  assert.equal(returnDueOn('2026-12-31'), '2027-01-15');
  assert.deepEqual(nextReturn('2026-11-08'), { dueOn: '2026-11-15', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(nextReturn('2026-11-15'), { dueOn: '2026-11-15', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(nextReturn('2026-12-16'), { dueOn: '2027-01-15', from: '2026-12-01', to: '2026-12-31' });
  // An owner's own dates: once, every month (never past the month's end), every year.
  assert.equal(nextOccurrence({ repeats: 'once', date: '2026-12-01' }, '2026-11-24'), '2026-12-01');
  assert.equal(nextOccurrence({ repeats: 'once', date: '2026-11-01' }, '2026-11-24'), null);
  assert.equal(nextOccurrence({ repeats: 'monthly', date: '2026-01-14' }, '2026-11-24'), '2026-12-14');
  assert.equal(nextOccurrence({ repeats: 'monthly', date: '2026-01-31' }, '2027-02-03'), '2027-02-28');
  assert.equal(nextOccurrence({ repeats: 'yearly', date: '2025-01-31' }, '2026-11-24'), '2027-01-31');
  assert.equal(nextOccurrence({ repeats: 'yearly', date: '2025-12-31' }, '2026-11-24'), '2026-12-31');
  // How the email says it.
  assert.equal(dueLine({ key: 'k', kind: 'gst', name: 'GST return for October 2026', dueOn: '2026-11-15', daysLeft: 7, amount: '120.50' }), 'GST return for October 2026: due Sunday 15 November (in 7 days); about BZ$120.50 to pay from the records so far.');
  assert.match(dueLine({ key: 'k', kind: 'business-tax', name: 'Business tax for October 2026', dueOn: '2026-11-15', daysLeft: 1, amount: '-30.00' }), /tomorrow\); a credit of about BZ\$30\.00/);
  assert.equal(dueLine({ key: 'k', kind: 'own', name: 'Trade licence', dueOn: '2026-11-30', daysLeft: 0 }), 'Trade licence: Monday 30 November (today).');
});

test('the business tax worksheet: receipts by kind at each rate, less contract tax withheld; CSV, PDF and the accountant’s pack', () =>
  withBusiness(async (c) => {
    // Before anything is set: everything is trade at 1.75%.
    const month = `${today().slice(0, 7)}-01`;
    const empty = (await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}`)).json();
    assert.deepEqual([empty.kinds.length, empty.kinds[0].rate, empty.receipts, empty.toPay], [1, '1.75', '0.00', '0.00']);

    await mixedBusiness(c);
    const r = (await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}`)).json();
    // Trade: 3 soaps less 1 returned (20.00) and 4.00 typed in = 24.00 at 1.75% = 0.42. Rents: 200.00 at 3% = 6.00. Profession: 500.00 at 6% = 30.00.
    assert.deepEqual(r.kinds.map((k: { name: string; receipts: string; rate: string; tax: string }) => [k.name, k.receipts, k.rate, k.tax]), [
      ['Trade or business', '24.00', '1.75', '0.42'], ['Rents', '200.00', '3', '6.00'], ['Profession or vocation', '500.00', '6', '30.00'],
    ]);
    assert.deepEqual([r.documents, r.receipts, r.tax], [3, '724.00', '36.42']);
    // The ministry withheld 6% of 500.00 and pays it to BTS itself.
    assert.deepEqual(r.withheld, { invoices: 1, amount: '30.00' });
    assert.equal(r.toPay, '6.42');
    assert.equal(r.dueOn, returnDueOn(today()));
    assert.ok(r.warnings.some((w: string) => /test environment/.test(w)));

    const csv = await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}&format=csv`);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(csv.body, /Rents,200\.00,3,6\.00/);
    assert.match(csv.body, /Total receipts and business tax,724\.00,,36\.42/);
    assert.match(csv.body, new RegExp(`Business tax to pay by ${r.dueOn},,,6\\.42`));
    const pdf = await call(c, 'GET', `/v1/reports/business-tax.pdf?from=${month}&to=${today()}`);
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    const pack = await call(c, 'GET', `/v1/reports/accountant-pack?from=${month}&to=${today()}`);
    assert.equal(pack.statusCode, 200);
    for (const name of ['business-tax.pdf', 'business-tax.csv']) assert.ok(pack.rawPayload.includes(Buffer.from(name)), name);

    // A business whose customers withhold more than its tax has a credit.
    await call(c, 'PUT', '/v1/tax-settings', { kinds: [{ name: 'Trade or business', rate: '1.75' }] });
    const trade = (await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}`)).json();
    assert.deepEqual([trade.kinds.length, trade.receipts, trade.tax, trade.toPay], [1, '724.00', '12.67', '-17.33']);
    assert.match((await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}&format=csv`)).body, /Credit to carry forward,,,17\.33/);

    // Who may: a cashier neither reads the worksheet nor changes the rates; settings are checked.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cash@biz.example');
    assert.equal((await call(c, 'GET', `/v1/reports/business-tax?from=${month}&to=${today()}`, undefined, cashier)).statusCode, 403);
    assert.equal((await call(c, 'PUT', '/v1/tax-settings', { email: false }, cashier)).statusCode, 403);
    assert.equal((await call(c, 'PUT', '/v1/tax-settings', { kinds: [{ name: 'Trade', rate: '75' }] })).statusCode, 422);
    assert.equal((await call(c, 'PUT', '/v1/tax-settings', { kinds: [{ name: 'Trade', rate: '1.75' }, { name: 'trade', rate: '6' }] })).statusCode, 422);
    assert.equal((await call(c, 'PUT', '/v1/tax-settings', { kinds: [{ name: 'Trade', rate: 'two' }] })).statusCode, 400);
    assert.equal((await call(c, 'PUT', '/v1/tax-settings', { kinds: [] })).statusCode, 400);
  }));

test('what is due and when: the two returns with about how much, the owner’s own dates, and one reminder a month by email', () =>
  withBusiness(async (c) => {
    await mixedBusiness(c);
    // Seen from the 8th of next month: the returns for this month are a week away.
    const next = new Date(`${today().slice(0, 7)}-01T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const eighth = `${next.toISOString().slice(0, 7)}-08`;
    const due = await dueDates(c.f.db, c.f.tenantA, eighth);
    assert.deepEqual(due.map((d) => [d.kind, d.dueOn, d.daysLeft, d.amount]), [
      ['gst', `${eighth.slice(0, 7)}-15`, 7, '90.50'], // 12.5% of 724.00
      ['business-tax', `${eighth.slice(0, 7)}-15`, 7, '6.42'],
    ]);
    assert.match(due[0]!.name, /^GST return for [A-Z][a-z]+ \d{4}$/);
    assert.equal(due[0]!.period!.from, `${today().slice(0, 7)}-01`);

    // The owner adds dates of their own; a business not registered for GST turns that return off.
    const saved = await call(c, 'PUT', '/v1/tax-settings', { gstReturn: false, dates: [
      { name: ' Social Security  contributions ', repeats: 'monthly', date: `${today().slice(0, 7)}-14` },
      { name: 'Trade licence', repeats: 'yearly', date: `${eighth.slice(0, 7)}-20` },
      { name: 'Long past', repeats: 'once', date: '2020-01-01' },
    ] });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().dates.map((d: { name: string; repeats: string }) => [d.name, d.repeats]), [['Social Security contributions', 'monthly'], ['Trade licence', 'yearly'], ['Long past', 'once']]);
    assert.deepEqual((await dueDates(c.f.db, c.f.tenantA, eighth)).map((d) => [d.kind, d.name, d.dueOn.slice(8)]), [
      ['own', 'Social Security contributions', '14'], ['business-tax', due[1]!.name, '15'], ['own', 'Trade licence', '20'],
    ]);
    // The same list over the API, from today.
    const listed = await call(c, 'GET', '/v1/reports/due-dates?days=400');
    assert.equal(listed.statusCode, 200, listed.body);
    assert.ok(listed.json().data.some((d: { name: string }) => d.name === 'Trade licence'));
    assert.ok(!listed.json().data.some((d: { kind: string }) => d.kind === 'gst'));

    // The reminder: from the 8th at 7 am Belize time, once that month, to the owners.
    const mail = memoryMailer();
    const at = (day: string, hourBelize: number) => new Date(`${day}T${String(hourBelize + 6).padStart(2, '0')}:00:00Z`);
    const seventh = `${eighth.slice(0, 7)}-07`;
    assert.deepEqual(await runFilingReminders(c.f.db, { mailer: mail, now: at(seventh, 9) }), { sent: 0, failed: 0 });
    assert.deepEqual(await runFilingReminders(c.f.db, { mailer: mail, now: at(eighth, 6) }), { sent: 0, failed: 0 });
    const first = await runFilingReminders(c.f.db, { mailer: mail, now: at(eighth, 8), publicUrl: 'https://app.example.test' });
    assert.equal(first.failed, 0);
    assert.ok(first.sent >= 1);
    const email = mail.sent.find((m) => m.type === 'filing-reminder' && m.tenantId === c.f.tenantA)!;
    assert.ok(email, 'the business got its reminder');
    assert.match(email.subject, /what is due this month$/);
    assert.match(email.text, /Social Security contributions: [A-Z][a-z]+ 14 /);
    assert.match(email.text, /Business tax for [A-Z][a-z]+ \d{4}: due [A-Z][a-z]+ 15 [A-Z][a-z]+ \(in 7 days\); about BZ\$6\.42 to pay/);
    assert.match(email.text, /Trade licence: [A-Z][a-z]+ 20 /);
    assert.doesNotMatch(email.text, /GST return/);
    assert.match(email.text, /https:\/\/app\.example\.test\/[a-z0-9-]+\/reports/);
    const count = mail.sent.length;
    assert.deepEqual(await runFilingReminders(c.f.db, { mailer: mail, now: at(`${eighth.slice(0, 7)}-09`, 8) }), { sent: 0, failed: 0 });
    assert.equal(mail.sent.length, count, 'once a month');

    // Turned off: nothing the month after.
    await call(c, 'PUT', '/v1/tax-settings', { email: false });
    const after = new Date(`${eighth}T12:00:00Z`);
    after.setUTCMonth(after.getUTCMonth() + 1);
    await runFilingReminders(c.f.db, { mailer: mail, now: at(after.toISOString().slice(0, 10), 8) });
    assert.ok(!mail.sent.slice(count).some((m) => m.tenantId === c.f.tenantA));
  }));
