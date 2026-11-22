/**
 * Quotes (sent, accepted online, turned into a tax invoice) and recurring
 * invoices (issued on schedule, emailed, once per date).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { nextOccurrence, runRecurring } from '../src/api/recurring.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, rejectedWith, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC_URL = 'https://app.example.test';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  owner: Record<string, string>;
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC_URL, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  try {
    await fn({ f, app, mail, owner: { ...CSRF, cookie: cookieFrom(login), 'x-business': slug } });
  } finally {
    await app.close();
    await f.close();
  }
}

const customer = { name: 'Hotel San Ignacio Ltd.', tin: '777888', address: { street: '18 Buena Vista', city: 'San Ignacio', districtCode: '2' }, contact: { email: 'accounts@hotel.example' } };
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

test('schedule dates: months keep their day, the 31st falls back, weeks and years', () => {
  assert.equal(nextOccurrence('2026-01-31', 'monthly', 1, 31), '2026-02-28');
  assert.equal(nextOccurrence('2026-02-28', 'monthly', 1, 31), '2026-03-31', 'back to the 31st');
  assert.equal(nextOccurrence('2026-11-15', 'monthly', 3, 15), '2027-02-15', 'every 3 months, across the year');
  assert.equal(nextOccurrence('2026-12-28', 'weekly', 1, 28), '2027-01-04');
  assert.equal(nextOccurrence('2028-02-29', 'yearly', 1, 29), '2029-02-28');
});

test('quotes: prices kept, sent with a link, accepted online, turned into a tax invoice once', () =>
  withBusiness(async (c) => {
    const item = await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name: 'Website design', description: 'Website design (5 pages)', unitCode: 'EA', unitPrice: '2000.00', gstCategory: 'S' } });
    assert.equal(item.statusCode, 201, item.body);
    const created = await c.app.inject({
      method: 'POST', url: '/v1/quotes', headers: c.owner,
      payload: { document: { type: '01', customer, lines: [{ itemId: item.json().id, quantity: '1' }, { description: 'Hosting, first year', quantity: '12', unitCode: 'MON', unitPrice: '25.00', gstCategory: 'S' }], payment: { meansCode: '30', dueDate: '2030-01-01' }, note: 'Includes two rounds of changes' }, dueDays: 14 },
    });
    assert.equal(created.statusCode, 201, created.body);
    const q = created.json();
    assert.deepEqual([q.number, q.status, q.totals.total, q.validUntil > today()], ['Q-1001', 'draft', '2587.50', true]);
    assert.equal(q.document.lines[0].unitPrice, '2000.00', 'the catalog price is written into the quote');
    assert.equal(q.document.payment.dueDate, undefined, 'the due date is set when invoiced');
    await c.app.inject({ method: 'PUT', url: `/v1/items/${item.json().id}`, headers: c.owner, payload: { name: 'Website design', description: 'Website design (5 pages)', unitCode: 'EA', unitPrice: '2500.00', gstCategory: 'S' } });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/quotes/${q.id}`, headers: c.owner })).json().totals.total, '2587.50', 'a later price change does not change the quote');

    const pdf = await c.app.inject({ method: 'GET', url: `/v1/quotes/${q.id}/pdf`, headers: c.owner });
    assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');

    const sent = await c.app.inject({ method: 'POST', url: `/v1/quotes/${q.id}/send`, headers: c.owner, payload: { message: 'Happy to discuss.' } });
    assert.equal(sent.statusCode, 200, sent.body);
    const m = c.mail.sent.at(-1)!;
    assert.equal(m.to, 'accounts@hotel.example');
    assert.match(m.subject, /^Quotation Q-1001 from /);
    assert.equal(m.attachments?.[0]?.contentType, 'application/pdf');
    const token = /\/q\/([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
    assert.equal(sent.json().status, 'sent');

    const view = (await c.app.inject({ method: 'GET', url: `/v1/quote/${token}` })).json();
    assert.deepEqual([view.quote.number, view.quote.totals.total, view.canRespond, view.lines.length], ['Q-1001', '2587.50', true, 2]);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/quote/${token}/pdf` })).headers['content-type'], 'application/pdf');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/quote/${token}/accept`, payload: { name: 'M' } })).statusCode, 400, 'a name is needed');
    const accepted = await c.app.inject({ method: 'POST', url: `/v1/quote/${token}/accept`, payload: { name: 'Maria Chan' } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.match(c.mail.sent.at(-1)!.subject, /Quote Q-1001: accepted by Maria Chan/, 'the business is told');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/quote/${token}/accept`, payload: { name: 'Maria Chan' } })).statusCode, 409);
    assert.equal((await c.app.inject({ method: 'PUT', url: `/v1/quotes/${q.id}`, headers: c.owner, payload: { document: { type: '01', customer, lines: [{ description: 'X', quantity: '1', unitCode: 'EA', unitPrice: '1.00', gstCategory: 'S' }] } } })).statusCode, 409, 'an accepted quote is not changed');

    const inv = await c.app.inject({ method: 'POST', url: `/v1/quotes/${q.id}/invoice`, headers: c.owner, payload: { email: true } });
    assert.equal(inv.statusCode, 200, inv.body);
    assert.equal(inv.json().quote.status, 'invoiced');
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.json().document.id}`, headers: c.owner })).json();
    assert.deepEqual([doc.type, doc.status, doc.totals.payable, doc.payment.status], ['01', 'authorized', '2587.50', 'unpaid']);
    const due = new Date(Date.parse(`${today()}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(doc.payment.dueDate, due, 'due 14 days after the invoice');
    assert.match(c.mail.sent.at(-1)!.text, /Amount due: BZ\$2,587\.50/, 'emailed with what is due');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/quotes/${q.id}/invoice`, headers: c.owner, payload: {} })).statusCode, 409, 'invoiced once');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/quote/${token}` })).json().quote.status, 'invoiced');
  }));

test('quotes: declined online, expired ones cannot be accepted, numbering, the list', () =>
  withBusiness(async (c) => {
    const make = async () => (await c.app.inject({ method: 'POST', url: '/v1/quotes', headers: c.owner, payload: { document: { type: '01', customer, lines: [{ description: 'Tour for 4', quantity: '1', unitCode: 'EA', unitPrice: '400.00', gstCategory: 'S' }] } } })).json();
    const a = await make();
    const b = await make();
    assert.deepEqual([a.number, b.number], ['Q-1001', 'Q-1002']);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/quotes', headers: c.owner, payload: { document: { type: '04', customer, lines: [{ description: 'X', quantity: '1', unitCode: 'EA', unitPrice: '1.00', gstCategory: 'S' }] } } })).statusCode, 422);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/quotes', headers: c.owner, payload: { document: { type: '01', lines: [{ description: 'X', quantity: '1', unitCode: 'EA', unitPrice: '1.00', gstCategory: 'S' }] } } })).statusCode, 422, 'a tax invoice needs a customer');

    const link = (await c.app.inject({ method: 'POST', url: `/v1/quotes/${a.id}/link`, headers: c.owner })).json().url as string;
    const tokenA = link.split('/q/')[1]!;
    const declined = await c.app.inject({ method: 'POST', url: `/v1/quote/${tokenA}/decline`, payload: { reason: 'Found a cheaper option' } });
    assert.equal(declined.statusCode, 200, declined.body);
    const after = (await c.app.inject({ method: 'GET', url: `/v1/quotes/${a.id}`, headers: c.owner })).json();
    assert.deepEqual([after.status, after.declineReason], ['declined', 'Found a cheaper option']);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/quotes/${a.id}/invoice`, headers: c.owner, payload: {} })).statusCode, 409);

    const tokenB = ((await c.app.inject({ method: 'POST', url: `/v1/quotes/${b.id}/link`, headers: c.owner })).json().url as string).split('/q/')[1]!;
    await c.f.db.query("update quotes set valid_until = current_date - 2 where id = $1", [b.id]);
    const view = (await c.app.inject({ method: 'GET', url: `/v1/quote/${tokenB}` })).json();
    assert.deepEqual([view.quote.expired, view.canRespond], [true, false]);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/quote/${tokenB}/accept`, payload: { name: 'Maria Chan' } })).statusCode, 409);
    // Accepted by phone, the business marks it.
    const marked = await c.app.inject({ method: 'POST', url: `/v1/quotes/${b.id}/status`, headers: c.owner, payload: { status: 'accepted', name: 'Maria (by phone)' } });
    assert.equal(marked.json().status, 'accepted');

    const open = (await c.app.inject({ method: 'GET', url: '/v1/quotes?status=open', headers: c.owner })).json();
    assert.deepEqual(open.data.map((x: { number: string }) => x.number), ['Q-1002']);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/quotes?q=q-1001', headers: c.owner })).json().data.length, 1);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/quote/${'x'.repeat(43)}` })).statusCode, 404);
  }));

test('recurring invoices: issued on schedule once, emailed with a pay link, run now, ends after the count', () =>
  withBusiness(async (c) => {
    const created = await c.app.inject({
      method: 'POST', url: '/v1/recurring', headers: c.owner,
      payload: { name: 'Monthly retainer', document: { type: '01', customer, lines: [{ description: 'IT support, monthly', quantity: '1', unitCode: 'MON', unitPrice: '300.00', gstCategory: 'S' }] }, frequency: 'monthly', startDate: today(), count: 2, dueDays: 10, autoSend: true },
    });
    assert.equal(created.statusCode, 201, created.body);
    const r = created.json();
    assert.deepEqual([r.status, r.total, r.nextDate, r.remaining], ['active', '337.50', today(), 2]);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/recurring', headers: c.owner, payload: { name: 'Back-dated', document: { type: '01', customer, lines: [{ description: 'X', quantity: '1', unitCode: 'EA', unitPrice: '1.00', gstCategory: 'S' }] }, frequency: 'monthly', startDate: '2020-01-01' } })).statusCode, 422);

    const ctx = { mailer: c.mail, mailConfigured: true, publicUrl: PUBLIC_URL, cookieSecure: true, allowSignup: true };
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 1, failed: 0 });
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 0, failed: 0 }, 'once per date');
    const mail = c.mail.sent.at(-1)!;
    assert.equal(mail.to, 'accounts@hotel.example');
    assert.match(mail.text, /Amount due: BZ\$337\.50/);
    assert.match(mail.text, /Pay online: https:\/\/app\.example\.test\/pay\//);

    const detail = (await c.app.inject({ method: 'GET', url: `/v1/recurring/${r.id}`, headers: c.owner })).json();
    assert.equal(detail.runs.length, 1);
    assert.deepEqual([detail.runs[0].status, detail.runs[0].emailed, detail.runs[0].documentStatus], ['issued', true, 'authorized']);
    assert.equal(detail.remaining, 1);
    assert.equal(detail.upcoming.length, 1, 'one left');
    assert.ok(detail.nextDate > today());
    const doc = (await c.app.inject({ method: 'GET', url: `/v1/documents/${detail.runs[0].documentId}`, headers: c.owner })).json();
    assert.equal(doc.payment.dueDate, new Date(Date.parse(`${today()}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10));

    const now = await c.app.inject({ method: 'POST', url: `/v1/recurring/${r.id}/run`, headers: c.owner });
    assert.equal(now.statusCode, 200, now.body);
    assert.deepEqual([now.json().status, now.json().remaining], ['finished', 0], 'ended after 2');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/recurring/${r.id}/run`, headers: c.owner })).statusCode, 409);
  }));

test('recurring invoices: a rejected invoice is retried later, not at once; pausing skips missed dates', () =>
  withBusiness(async (c) => {
    const make = async (name: string) => (await c.app.inject({
      method: 'POST', url: '/v1/recurring', headers: c.owner,
      payload: { name, document: { type: '01', customer, lines: [{ description: 'Rent', quantity: '1', unitCode: 'MON', unitPrice: '1500.00', gstCategory: 'E', exemptionReasonCode: 'VATEX-EU-79-C' }] }, frequency: 'monthly', startDate: today(), autoSend: false },
    })).json();
    const rent = await make('Rent');
    c.f.bts.script(SUBMIT_PATHS['01'], rejectedWith('283', 'Customer name missing'));
    const ctx = { mailer: c.mail, mailConfigured: true, publicUrl: PUBLIC_URL, cookieSecure: true, allowSignup: true };
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 0, failed: 1 });
    const failed = (await c.app.inject({ method: 'GET', url: `/v1/recurring/${rent.id}`, headers: c.owner })).json();
    assert.match(failed.lastError, /BTS rejected the invoice/);
    assert.equal(failed.nextDate, today(), 'the date is kept for the retry');
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 0, failed: 0 }, 'not retried within the hour');
    await c.f.db.query("update recurring_runs set created_at = now() - interval '2 hours'");
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 1, failed: 0 }, 'retried an hour later');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/recurring/${rent.id}`, headers: c.owner })).json().lastError, null);

    const other = await make('Parking');
    await c.app.inject({ method: 'POST', url: `/v1/recurring/${other.id}/pause`, headers: c.owner });
    await c.f.db.query("update recurring_invoices set next_date = current_date - 70 where id = $1", [other.id]);
    assert.deepEqual(await runRecurring(c.f.deps, ctx), { issued: 0, failed: 0 }, 'paused: nothing');
    const resumed = (await c.app.inject({ method: 'POST', url: `/v1/recurring/${other.id}/resume`, headers: c.owner })).json();
    assert.ok(resumed.nextDate >= today(), 'missed dates are skipped');
    const list = (await c.app.inject({ method: 'GET', url: '/v1/recurring', headers: c.owner })).json();
    assert.equal(list.data.length, 2);
  }));
