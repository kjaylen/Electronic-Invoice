/**
 * Web app features: editing the catalog, document search, sending documents
 * (email, share links) and reports. Accounts and passwords: accounts.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { csvCell } from '../src/api/reports.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { applicationResponse } from './fake-bts.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const PUBLIC_URL = 'https://app.example.test';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  key: string;
  as: (key: string) => { authorization: string };
}

async function withApp(fn: (c: Ctx) => Promise<void>, options: { mail?: boolean; publicUrl?: boolean } = {}) {
  resetLoginAttempts();
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({
    pipeline: f.deps,
    cookieSecure: true,
    ...(options.mail !== false && { mailer: mail }),
    ...(options.publicUrl !== false && { publicUrl: PUBLIC_URL }),
  });
  const key = (await createApiKey(f.db, f.tenantA, 'tests')).key;
  try {
    await fn({ f, app, mail, key, as: (k) => ({ authorization: `Bearer ${k}` }) });
  } finally {
    await app.close();
    await f.close();
  }
}


async function issue(c: Ctx, body: Record<string, unknown>) {
  const res = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.as(c.key), payload: { payment: { meansCode: '10', terms: 'Paid in cash' }, ...body } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const line = (description: string, quantity: string, unitPrice: string, gstCategory = 'S') => ({ description, quantity, unitCode: 'H87', unitPrice, gstCategory, ...(gstCategory === 'E' && { exemptionReasonCode: 'MED' }) });

// ---------- catalog ----------

test('customers can be edited and archived; issued documents keep the old details', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const created = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.as(c.key), payload: { name: 'Old Name Ltd', address: { street: '1 Main', city: 'Belmopan', districtCode: '2' } } })).json();
    const doc = await issue(c, { type: '01', customerId: created.id, lines: [line('Desk', '1', '100')] });

    const put = await c.app.inject({ method: 'PUT', url: `/v1/customers/${created.id}`, headers: c.as(c.key), payload: { name: 'New Name Ltd', tin: '111222', contact: { email: 'a@new.example' } } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().name, 'New Name Ltd');
    assert.equal(put.json().address, null, 'PUT replaces every field');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: c.as(c.key) })).json().customer.name, 'Old Name Ltd');

    const found = (await c.app.inject({ method: 'GET', url: '/v1/customers?q=a@new', headers: c.as(c.key) })).json();
    assert.equal(found.data.length, 1, 'search also matches email');

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/customers/${created.id}`, headers: c.as(c.key) })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/customers', headers: c.as(c.key) })).json().data.length, 0, 'archived customers leave the list');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/customers/${created.id}`, headers: c.as(c.key) })).json().archived, true);

    const otherKey = (await createApiKey(c.f.db, c.f.tenantB, 'b')).key;
    assert.equal((await c.app.inject({ method: 'PUT', url: `/v1/customers/${created.id}`, headers: c.as(otherKey), payload: { name: 'x' } })).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/customers/${created.id}`, headers: c.as(otherKey) })).statusCode, 404);
  }));

test('items: edit, favourite, barcode lookup, search, archive', () =>
  withApp(async (c) => {
    const post = (payload: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/items', headers: c.as(c.key), payload });
    const coffee = (await post({ name: 'Coffee', unitCode: 'H87', unitPrice: '4.50', gstCategory: 'S', barcode: '7501234567890', favorite: true })).json();
    await post({ name: 'Tea', sellerCode: 'TEA-1', unitCode: 'H87', unitPrice: '3', gstCategory: 'S' });
    const dup = await post({ name: 'Other', unitCode: 'H87', unitPrice: '1', gstCategory: 'S', barcode: '7501234567890' });
    assert.equal(dup.statusCode, 409);

    const get = async (q: string) => (await c.app.inject({ method: 'GET', url: `/v1/items?${q}`, headers: c.as(c.key) })).json().data.map((i: { name: string }) => i.name);
    assert.deepEqual(await get('code=7501234567890'), ['Coffee']);
    assert.deepEqual(await get('code=tea-1'), ['Tea'], 'your own code matches regardless of case');
    assert.deepEqual(await get('favorite=true'), ['Coffee']);
    assert.deepEqual(await get('q=te'), ['Tea']);

    const put = await c.app.inject({ method: 'PUT', url: `/v1/items/${coffee.id}`, headers: c.as(c.key), payload: { name: 'Coffee, large', unitCode: 'H87', unitPrice: '5.25', gstCategory: 'S', barcode: '7501234567890' } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().unitPrice, '5.25');
    assert.equal(put.json().favorite, false);

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/items/${coffee.id}`, headers: c.as(c.key) })).statusCode, 204);
    assert.deepEqual(await get('code=7501234567890'), []);
    assert.equal((await post({ name: 'New coffee', unitCode: 'H87', unitPrice: '5', gstCategory: 'S', barcode: '7501234567890' })).statusCode, 201, 'archiving frees the barcode');
  }));

// ---------- documents ----------

test('document search: number, customer name or TIN, date range, customer; detail has lines', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const cust = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.as(c.key), payload: { name: 'Sunrise Bakery', tin: '445566', address: { street: '2 Front St', city: 'Dangriga', districtCode: '5' } } })).json();
    const inv = await issue(c, { type: '01', customerId: cust.id, lines: [line('Flour sack', '3', '45.00')] });
    await issue(c, { type: '02', lines: [line('Bread', '2', '2.50')] });
    await issue(c, { type: '02', customer: { name: 'Maya Gomez' }, lines: [line('Cake', '1', '30')] });

    const ids = async (q: string) => (await c.app.inject({ method: 'GET', url: `/v1/documents?${q}`, headers: c.as(c.key) })).json().data.map((d: { id: string }) => d.id);
    assert.deepEqual(await ids('q=sunrise'), [inv.id]);
    assert.deepEqual(await ids('q=445566'), [inv.id]);
    assert.deepEqual(await ids(`q=${inv.etdui}`), [inv.id]);
    assert.deepEqual(await ids('q=001-000000001&type=01'), [inv.id]);
    assert.equal((await ids('q=1')).length, 2, 'serial 1 of the invoice series and of the receipt series');
    assert.equal((await ids(`customerId=${cust.id}`)).length, 1);
    assert.equal((await ids('q=maya')).length, 1);
    assert.equal((await ids(`from=${inv.issueDate}&to=${inv.issueDate}`)).length, 3);
    assert.equal((await ids('from=2001-01-01&to=2001-12-31')).length, 0);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents?from=yesterday', headers: c.as(c.key) })).statusCode, 400);

    const detail = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}`, headers: c.as(c.key) })).json();
    assert.deepEqual(detail.lines, [{ lineNumber: 1, description: 'Flour sack', quantity: '3', unitCode: 'H87', unitPrice: '45.00', gstCategory: 'S', net: '135.00', gst: '16.88', tax: '16.88', total: '151.88' }]);
  }));

test('email a document: PDF and XML attached, recorded; needs email set up', async () => {
  await withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const doc = await issue(c, { type: '01', customer: { name: 'Coral Reef Tours', address: { street: '9 Barrier Rd', city: 'San Pedro', districtCode: '1' } }, lines: [line('Snorkel tour', '2', '80')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'billing@coralreef.example', message: 'Thank you!' } });
    assert.equal(res.statusCode, 200, res.body);
    const sent = c.mail.sent.at(-1)!;
    assert.equal(sent.to, 'billing@coralreef.example');
    assert.match(sent.subject, /Tax Invoice 001-000000001/i);
    assert.match(sent.text, /Thank you!/);
    assert.deepEqual(sent.attachments!.map((a) => a.contentType), ['application/pdf', 'application/xml']);
    assert.equal((sent.attachments![0]!.content as Buffer).subarray(0, 5).toString(), '%PDF-');
    assert.ok(sent.replyTo, 'replies go to the business');

    const log = (await c.app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/messages`, headers: c.as(c.key) })).json();
    assert.deepEqual(log.data.map((m: { recipient: string; status: string }) => [m.recipient, m.status]), [['billing@coralreef.example', 'sent']]);

    const bad = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'a@b.example, c@d.example' } });
    assert.equal(bad.statusCode, 400, 'one recipient only');
  });
  await withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const doc = await issue(c, { type: '01', customer: { name: 'X', address: { street: '1', city: 'Y', districtCode: '1' } }, lines: [line('A', '1', '1')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'a@b.example' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'email_unavailable');
  }, { mail: false });
});

test('share links: the customer opens the PDF without logging in; cancelled documents stop working', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['05'], { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44) }) });
    const doc = await issue(c, { type: '02', lines: [line('Haircut', '1', '25')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/share`, headers: c.as(c.key) });
    assert.equal(res.statusCode, 201, res.body);
    const url = new URL(res.json().url);
    assert.equal(url.origin, PUBLIC_URL);
    assert.match(url.pathname, /^\/d\/[A-Za-z0-9_-]{43}$/);

    const pdf = await c.app.inject({ method: 'GET', url: url.pathname });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['x-robots-tag'], 'noindex');
    assert.match(String(pdf.headers['cache-control']), /no-store/);
    assert.equal((await c.app.inject({ method: 'GET', url: `${url.pathname}?format=receipt` })).statusCode, 200);

    const wrong = await c.app.inject({ method: 'GET', url: `/d/${'A'.repeat(43)}` });
    assert.equal(wrong.statusCode, 404);
    assert.match(String(wrong.headers['content-type']), /text\/html/);

    await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: c.as(c.key), payload: { reason: 'Wrong price' } });
    const after = await c.app.inject({ method: 'GET', url: url.pathname });
    assert.equal(after.statusCode, 404);
    assert.match(after.body, /no longer valid/);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/share`, headers: c.as(c.key) })).statusCode, 409);
  }));

test('reports: totals and GST by rate, credit notes subtract, rejected documents do not count, CSV', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
    const customer = { name: '=HYPERLINK("http://evil")', tin: '998877', address: { street: '1 A St', city: 'Orange Walk', districtCode: '4' } };
    const inv = await issue(c, { type: '01', customer, lines: [line('Cement bag', '10', '20.00'), line('Rice', '5', '2.00', 'Z')] });
    await issue(c, { type: '02', lines: [line('Cement bag', '2', '20.00'), line('Clinic fee', '1', '50', 'E')] });
    await issue(c, { type: '04', reference: { documentId: inv.id, reason: 'Returned 1 bag' }, customer, lines: [line('Cement bag', '1', '20.00')] });
    c.f.bts.script(SUBMIT_PATHS['02'], { status: 201, body: applicationResponse({ responseCode: '003', referencedEtdui: '0'.repeat(44), conditions: [{ code: '271', description: 'x' }] }) });
    const rejected = await issue(c, { type: '02', lines: [line('Ignored', '1', '1000')] });
    assert.equal(rejected.status, 'rejected');

    const day = inv.issueDate;
    const summary = (await c.app.inject({ method: 'GET', url: `/v1/reports/summary?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    // Standard: 200 + 40 - 20 = 220 net, GST 25.00 + 5.00 - 2.50 = 27.50. Zero-rated 10. Exempt 50.
    assert.deepEqual(summary.byRate.map((r: { category: string; net: string; gst: string }) => [r.category, r.net, r.gst]), [['E', '50.00', '0.00'], ['S', '220.00', '27.50'], ['Z', '10.00', '0.00']]);
    assert.deepEqual(summary.totals, { documents: 3, net: '280.00', gst: '27.50', tax: '27.50', total: '307.50' });
    assert.deepEqual(summary.byDay, [{ date: day, documents: 3, total: '307.50' }]);
    assert.equal(summary.byType.find((t: { type: string }) => t.type === '04').total, '22.50', 'per type, credit notes are shown as issued');

    const customers = (await c.app.inject({ method: 'GET', url: `/v1/reports/customers?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    assert.deepEqual(customers.data.map((r: { name: string; total: string }) => [r.name, r.total]), [['=HYPERLINK("http://evil")', '212.50'], ['Walk-in customers', '95.00']]);
    const items = (await c.app.inject({ method: 'GET', url: `/v1/reports/items?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    assert.deepEqual(items.data.find((r: { description: string }) => r.description === 'Cement bag'), { description: 'Cement bag', unitCode: 'H87', quantity: '11', net: '220.00', gst: '27.50', total: '247.50' });

    const csv = await c.app.inject({ method: 'GET', url: `/v1/reports/customers?from=${day}&to=${day}&format=csv`, headers: c.as(c.key) });
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /attachment; filename="sales-by-customer-/);
    assert.ok(csv.body.includes(`"'=HYPERLINK(""http://evil"")"`), 'formulas are neutralised and quotes escaped');
    assert.ok(csv.body.includes(',212.50'), 'amounts stay numbers');

    const register = await c.app.inject({ method: 'GET', url: `/v1/reports/documents?from=${day}&to=${day}`, headers: c.as(c.key) });
    const rows = register.body.trim().split('\r\n');
    assert.equal(rows.length, 1 + 4, 'the register lists every document, rejected ones included');
    assert.ok(rows.some((r) => r.includes(',rejected,')));

    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/reports/summary?from=${day}`, headers: c.as(c.key) })).statusCode, 400);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/reports/summary?from=2026-02-01&to=2026-01-01', headers: c.as(c.key) })).statusCode, 400);
  }));

test('csvCell neutralises formulas and quotes', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('-5', false), '-5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
});
