/**
 * Getting paid: payments against invoices, balances with credit notes,
 * ageing, statements, reminders, and paying an invoice from its link.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { reminderStep, runReminders } from '../src/api/receivables.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC_URL = 'https://app.example.test';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  slug: string;
  owner: Record<string, string>;
  login: (email: string) => Promise<Record<string, string>>;
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '03', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC_URL, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  try {
    await fn({ f, app, mail, slug, owner: await login('olive@biz.example'), login });
  } finally {
    await app.close();
    await f.close();
  }
}

const customer = (tin: string, name: string, email?: string) => ({
  name, tin, address: { street: '4 Mile Northern Highway', city: 'Belize City', districtCode: '1' }, ...(email && { contact: { email } }),
});

async function issueInvoice(c: Ctx, opts: { tin?: string; name?: string; email?: string; price?: string; dueDate?: string; paid?: { method: string } } = {}) {
  const res = await c.app.inject({
    method: 'POST', url: '/v1/documents', headers: c.owner,
    payload: {
      type: '01',
      customer: customer(opts.tin ?? '777888', opts.name ?? 'Island Logistics Ltd.', opts.email ?? 'accounts@island.example'),
      lines: [{ description: 'Consulting', quantity: '1', unitCode: 'H87', unitPrice: opts.price ?? '100.00', gstCategory: 'S' }],
      payment: { meansCode: '30', dueDate: opts.dueDate ?? '2026-12-31', terms: 'Net 30' },
      ...(opts.paid && { paid: opts.paid }),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; totals: { payable: string }; payment: { status: string; balance: string } | null };
}

/** Move an invoice back in time (tests only: issued documents are otherwise permanent). */
async function backdate(c: Ctx, id: string, issueDate: string, dueDate: string) {
  await c.f.db.query('alter table documents disable trigger documents_guard');
  await c.f.db.query('update documents set issue_date = $2, due_date = $3 where id = $1', [id, issueDate, dueDate]);
  await c.f.db.query('alter table documents enable trigger documents_guard');
}

const daysAgo = (n: number) => new Date(Date.now() - 6 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

test('reminder steps: the latest one reached, never on or before the day of issue', () => {
  const offsets = [-3, 3, 14, 30];
  assert.equal(reminderStep(offsets, '2026-10-01', '2026-11-01', '2026-10-28'), null, 'more than 3 days before');
  assert.equal(reminderStep(offsets, '2026-10-01', '2026-11-01', '2026-10-29'), -3);
  assert.equal(reminderStep(offsets, '2026-10-01', '2026-11-01', '2026-11-05'), 3);
  assert.equal(reminderStep(offsets, '2026-10-01', '2026-11-01', '2027-02-01'), 30, 'turned on late: only the latest step');
  assert.equal(reminderStep(offsets, '2026-10-31', '2026-11-01', '2026-10-31'), null, 'issued the day before it is due: no "due in 3 days"');
  assert.equal(reminderStep([0], '2026-11-01', '2026-11-01', '2026-11-01'), null, 'due on the day of issue');
});

test('payments: partial, paid, too much refused, voided, credit notes count, events and the documents list', () =>
  withBusiness(async (c) => {
    const inv = await issueInvoice(c);
    assert.equal(inv.totals.payable, '112.50');
    assert.deepEqual({ status: inv.payment?.status, balance: inv.payment?.balance }, { status: 'unpaid', balance: '112.50' });
    const pay = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: `/v1/documents/${inv.id}/payments`, headers: c.owner, payload: body });

    const first = await pay({ amount: '50.00', method: 'cash' });
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual([first.json().invoice.status, first.json().invoice.balance], ['partial', '62.50']);
    assert.equal((await pay({ amount: '62.51', method: 'cash' })).statusCode, 422, 'more than the balance');
    assert.equal((await pay({ amount: '0', method: 'cash' })).statusCode, 422);
    assert.equal((await pay({ amount: '1.00', method: 'cash', paidOn: '2099-01-01' })).statusCode, 422, 'not in the future');
    assert.equal((await pay({ amount: '1.00', method: 'refund' })).statusCode, 400, 'refunds are not entered by hand');

    const second = await pay({ amount: '62.50', method: 'bank_transfer', reference: 'TRF-889' });
    assert.deepEqual([second.json().invoice.status, second.json().invoice.balance], ['paid', '0.00']);
    assert.equal((await pay({ amount: '1.00', method: 'cash' })).statusCode, 422, 'already paid');
    const events = (await c.f.db.query<{ type: string }>("select type from event_outbox where type in ('invoice.paid', 'payment.recorded') order by id")).rows.map((r) => r.type);
    assert.deepEqual(events, ['payment.recorded', 'payment.recorded', 'invoice.paid']);

    // The list and the document show it.
    const list = (await c.app.inject({ method: 'GET', url: '/v1/documents', headers: c.owner })).json();
    assert.equal(list.data.find((d: { id: string }) => d.id === inv.id).payment.status, 'paid');

    // A mistake is voided, never deleted.
    const voided = await c.app.inject({ method: 'POST', url: `/v1/payments/${first.json().payment.id}/void`, headers: c.owner, payload: { reason: 'Entered on the wrong invoice' } });
    assert.equal(voided.statusCode, 200, voided.body);
    assert.deepEqual([voided.json().invoice.status, voided.json().invoice.balance], ['partial', '50.00']);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/payments/${first.json().payment.id}/void`, headers: c.owner, payload: { reason: 'again' } })).statusCode, 422);
    await assert.rejects(c.f.db.query('delete from invoice_payments'), /permanent/);
    const history = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}/payments`, headers: c.owner })).json();
    assert.equal(history.payments.length, 2);
    assert.equal(history.payments.find((p: { voided: boolean }) => p.voided).voidReason, 'Entered on the wrong invoice');

    // A credit note for more than what is left leaves the customer in credit.
    const credit = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '04', reference: { documentId: inv.id, reason: 'Discount agreed' }, payment: { terms: 'Credited to the account' }, lines: [{ description: 'Discount', quantity: '1', unitCode: 'H87', unitPrice: '60.00', gstCategory: 'S' }] },
    });
    assert.equal(credit.statusCode, 201, credit.body);
    const after = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}`, headers: c.owner })).json();
    assert.deepEqual([after.payment.status, after.payment.credited, after.payment.balance], ['credit', '67.50', '-17.50']);

    // Receipts and credit notes carry no payment state.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/documents/${credit.json().id}`, headers: c.owner })).json().payment, null);
  }));

test('paid when issued, and who may record payments', () =>
  withBusiness(async (c) => {
    const paidNow = await issueInvoice(c, { paid: { method: 'card' } });
    assert.equal(paidNow.payment?.status, 'paid');
    const p = (await c.app.inject({ method: 'GET', url: `/v1/documents/${paidNow.id}/payments`, headers: c.owner })).json();
    assert.deepEqual([p.payments.length, p.payments[0].method, p.payments[0].amount], [1, 'card', '112.50']);

    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Acct', email: 'acct@biz.example', role: 'accountant', password: PASSWORD });
    const open = await issueInvoice(c);
    const cashier = await c.login('cash@biz.example');
    const accountant = await c.login('acct@biz.example');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/documents/${open.id}/payments`, headers: cashier, payload: { amount: '10.00', method: 'cash' } })).statusCode, 201);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/documents/${open.id}/payments`, headers: accountant, payload: { amount: '10.00', method: 'cheque', reference: '000123' } })).statusCode, 201);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/receivable-settings', headers: cashier, payload: { reminders: { enabled: true, offsets: [3] }, payOnline: true, instructions: '' } })).statusCode, 403, 'settings are for owners and admins');
    // Another business never sees them.
    const other = await c.app.inject({ method: 'GET', url: `/v1/documents/${open.id}/payments`, headers: { ...c.owner, 'x-business': 'nope' } });
    assert.notEqual(other.statusCode, 200);
  }));

test('ageing, statements (JSON, PDF, email), the CSV and settings', () =>
  withBusiness(async (c) => {
    const old = await issueInvoice(c, { price: '200.00' });
    await backdate(c, old.id, daysAgo(80), daysAgo(45));
    const late = await issueInvoice(c, { price: '100.00' });
    await backdate(c, late.id, daysAgo(35), daysAgo(5));
    await issueInvoice(c, { tin: '555444', name: 'Reef Divers', email: 'reef@divers.example', price: '40.00' });

    const overview = (await c.app.inject({ method: 'GET', url: '/v1/receivables', headers: c.owner })).json();
    assert.equal(overview.summary.outstanding, '382.50');
    assert.equal(overview.summary.overdue, '337.50');
    assert.equal(overview.summary.overdueInvoices, 2);
    assert.equal(overview.summary.customersOwing, 2);
    const island = overview.ageing.customers[0];
    assert.equal(island.name, 'Island Logistics Ltd.');
    assert.deepEqual([island.buckets['31-60'], island.buckets['1-30'], island.total], ['225.00', '112.50', '337.50']);
    assert.equal(overview.ageing.totals.current, '45.00');

    const overdue = (await c.app.inject({ method: 'GET', url: '/v1/receivables/invoices?status=overdue', headers: c.owner })).json();
    assert.equal(overdue.data.length, 2);
    assert.equal(overdue.data[0].daysOverdue, 45, 'oldest first');

    const s = (await c.app.inject({ method: 'GET', url: `/v1/receivables/statement?customer=${encodeURIComponent(island.key)}`, headers: c.owner })).json();
    assert.deepEqual([s.open.length, s.totalDue, s.overdue], [2, '337.50', '337.50']);
    const pdf = await c.app.inject({ method: 'GET', url: `/v1/receivables/statement.pdf?customer=${encodeURIComponent(island.key)}`, headers: c.owner });
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');

    await c.app.inject({ method: 'PUT', url: '/v1/receivable-settings', headers: c.owner, payload: { reminders: { enabled: false, offsets: [14, -3] }, payOnline: true, instructions: 'Belize Bank, account 000-111. Use the invoice number.' } });
    const sent = await c.app.inject({ method: 'POST', url: '/v1/receivables/statement/send', headers: c.owner, payload: { customer: island.key } });
    assert.equal(sent.statusCode, 200, sent.body);
    const mail = c.mail.sent.at(-1)!;
    assert.equal(mail.to, 'accounts@island.example');
    assert.match(mail.subject, /Statement of account/);
    assert.equal(mail.attachments?.[0]?.contentType, 'application/pdf');
    assert.match(mail.text, /Total due: BZ\$337\.50, of which BZ\$337\.50 is overdue/);
    assert.match(mail.text, /Pay online: https:\/\/app\.example\.test\/pay\//, 'each invoice has a pay link (test payments in the test environment)');
    assert.match(mail.text, /Belize Bank, account 000-111/);

    const csv = await c.app.inject({ method: 'GET', url: '/v1/receivables/ageing.csv', headers: c.owner });
    assert.match(csv.body, /Island Logistics Ltd\.,777888,accounts@island\.example,2,/);
    assert.match(csv.body, /Total,,,,,45\.00,112\.50,225\.00,0\.00,0\.00,382\.50/);

    const settings = (await c.app.inject({ method: 'GET', url: '/v1/receivable-settings', headers: c.owner })).json();
    assert.deepEqual(settings.reminders.offsets, [-3, 14], 'kept in order');
    assert.equal(settings.onlineProvider, 'test');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/receivables/statement?customer=t:000000', headers: c.owner })).statusCode, 422);
  }));

test('reminders: sent once per step, with the invoice and a pay link; a manual reminder too', () =>
  withBusiness(async (c) => {
    const due = await issueInvoice(c);
    await backdate(c, due.id, daysAgo(40), daysAgo(10));
    const noEmail = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '01', customer: { name: 'No Email Co', tin: '121212', address: { street: '1 Main', city: 'Orange Walk', districtCode: '2' } }, lines: [{ description: 'X', quantity: '1', unitCode: 'H87', unitPrice: '10.00', gstCategory: 'S' }], payment: { dueDate: '2026-12-31' } },
    });
    await backdate(c, noEmail.json().id, daysAgo(40), daysAgo(10));
    const ctx = { mailer: c.mail, mailConfigured: true, publicUrl: PUBLIC_URL, cookieSecure: true, allowSignup: true };

    assert.deepEqual(await runReminders(c.f.deps, ctx), { sent: 0, failed: 0 }, 'off until turned on');
    await c.app.inject({ method: 'PUT', url: '/v1/receivable-settings', headers: c.owner, payload: { reminders: { enabled: true, offsets: [-3, 3, 14] }, payOnline: true, instructions: '' } });
    assert.deepEqual(await runReminders(c.f.deps, ctx), { sent: 1, failed: 0 });
    assert.deepEqual(await runReminders(c.f.deps, ctx), { sent: 0, failed: 0 }, 'once per step');
    const m = c.mail.sent.at(-1)!;
    assert.equal(m.to, 'accounts@island.example');
    assert.match(m.subject, /^Overdue: invoice/);
    assert.match(m.text, /10 days overdue/);
    assert.match(m.text, /Pay online: https:\/\/app\.example\.test\/pay\/[A-Za-z0-9_-]{43}/);
    assert.ok(m.attachments?.some((a) => a.contentType === 'application/pdf'));
    const logged = (await c.f.db.query<{ n: number }>("select count(*)::int as n from document_messages where document_id = $1 and status = 'sent'", [due.id])).rows[0]!.n;
    assert.equal(logged, 1, 'in the document’s email history');

    // Paid in full: no more reminders, and a manual one is refused.
    await c.app.inject({ method: 'POST', url: `/v1/documents/${due.id}/payments`, headers: c.owner, payload: { amount: '112.50', method: 'cash' } });
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/documents/${due.id}/remind`, headers: c.owner, payload: {} })).statusCode, 409);
    const open = await issueInvoice(c);
    const manual = await c.app.inject({ method: 'POST', url: `/v1/documents/${open.id}/remind`, headers: c.owner, payload: { to: 'boss@island.example' } });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.match(c.mail.sent.at(-1)!.subject, /^Reminder: invoice .* is due in \d+ days/);
  }));

test('paying an invoice from its link: the page, a test payment, recorded once, and an expired link', () =>
  withBusiness(async (c) => {
    const inv = await issueInvoice(c);
    const share = await c.app.inject({ method: 'POST', url: `/v1/documents/${inv.id}/share`, headers: c.owner });
    const token = /\/d\/([A-Za-z0-9_-]{43})/.exec(share.json().url)![1]!;

    const page = await c.app.inject({ method: 'GET', url: `/v1/pay/${token}` });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.deepEqual([page.json().invoice.balance, page.json().online.provider, page.json().pdfUrl], ['112.50', 'test', `/d/${token}`]);

    const start = await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/start` });
    assert.equal(start.statusCode, 200, start.body);
    const paymentId = start.json().paymentId;
    assert.equal(start.json().redirectUrl, `/pay/${token}?test=${paymentId}`);
    const pending = await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/payments/${paymentId}/confirm` });
    assert.equal(pending.json().status, 'pending');

    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/test/${paymentId}`, payload: { decision: 'approved' } })).statusCode, 200);
    const done = await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/payments/${paymentId}/confirm` });
    assert.deepEqual([done.json().status, done.json().balance], ['paid', '0.00']);
    await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/payments/${paymentId}/confirm` });
    const payments = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}/payments`, headers: c.owner })).json().payments;
    assert.equal(payments.length, 1, 'recorded once, however often it is confirmed');
    assert.deepEqual([payments[0].method, payments[0].amount], ['online', '112.50']);
    assert.match(payments[0].reference, /^Test payment TEST-/);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/pay/${token}/start` })).statusCode, 409, 'nothing left to pay');

    // Someone else's payment id, a made-up token, an expired link.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/pay/${'x'.repeat(43)}` })).statusCode, 404);
    await c.f.db.query("update share_links set expires_at = now() - interval '1 day'");
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/pay/${token}` })).statusCode, 404);
  }));
