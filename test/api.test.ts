import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { runWorkerOnce } from '../src/api/worker.ts';
import { createApiKey, revokeApiKey } from '../src/db/apikeys.ts';
import { DOCUMENT_QUERY_PATH, SUBMIT_PATHS } from '../src/engine/transport.ts';
import { applicationResponse } from './fake-bts.ts';
import { AUTHORIZED, readCert, rejectedWith, setupPipeline, TENANT_A, type PipelineFixture } from './pipeline-setup.ts';

const ADMIN = 'admin-token-for-tests-0123456789abcdef';
const INVOICE = SUBMIT_PATHS['01'];
const DOWN = { status: 500, body: 'Rejection: Server error' };
const NOT_FOUND = { status: 200, contentType: 'application/json', body: JSON.stringify({ GetDocument: { ResponseCode: '004' } }) };

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  keyA: string;
  keyB: string;
  as: (key: string) => Record<string, string>;
}

async function withApi(fn: (c: Ctx) => Promise<void>, adminToken: string | null = ADMIN) {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, ...(adminToken !== null && { adminToken }) });
  const keyA = (await createApiKey(f.db, f.tenantA, 'POS 1')).key;
  const keyB = (await createApiKey(f.db, f.tenantB, 'Connector')).key;
  try {
    await fn({ f, app, keyA, keyB, as: (key) => ({ authorization: `Bearer ${key}` }) });
  } finally {
    await app.close();
    await f.close();
  }
}

const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
  type: '01',
  customer: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile Northern Highway', city: 'Belize City', districtCode: '1' } },
  lines: [{ description: 'Phone charger', quantity: '2', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' }],
  payment: { meansCode: '30', dueDate: '2026-12-31', terms: 'Net 30' },
  ...overrides,
});

// ---------- basics and auth ----------

test('health check and JSON 404s', () =>
  withApi(async ({ app }) => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not_found');
  }));

test('tenant routes need a valid, unrevoked API key', () =>
  withApi(async ({ app, f, keyA, as }) => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: as('etd_aaaaaaaaaaaa_' + 'x'.repeat(43)) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: as(keyA.slice(0, -1) + (keyA.endsWith('A') ? 'B' : 'A')) })).statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: '/v1/me', headers: as(keyA) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().tin, '123456');

    const fresh = await createApiKey(f.db, f.tenantA, 'temp');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: as(fresh.key) })).statusCode, 200);
    await revokeApiKey(f.db, f.tenantA, fresh.id);
    const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: as(fresh.key) });
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.json().error.code, 'unauthorized');
  }));

test('admin routes need the admin token, and are off when no token is configured', async () => {
  await withApi(async ({ app, keyA, as }) => {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/tenants', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/tenants', headers: as(keyA), payload: {} })).statusCode, 401, 'a tenant key is not an admin token');
  });
  await withApi(async ({ app }) => {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/tenants', headers: { authorization: `Bearer ${ADMIN}` }, payload: {} })).statusCode, 401);
  }, null); // no admin token configured: admin routes are off
  await assert.rejects(buildApp({ pipeline: {} as never, adminToken: 'short' }), /at least 32/);
});

test('onboarding: create a business, upload its certificate, issue an API key, use it', () =>
  withApi(async ({ app, as }) => {
    const admin = as(ADMIN);
    const created = await app.inject({ method: 'POST', url: '/v1/admin/tenants', headers: admin, payload: { ...TENANT_A, environment: 'production' } });
    assert.equal(created.statusCode, 201);
    const tenantId = created.json().id;

    const dup = await app.inject({ method: 'POST', url: '/v1/admin/tenants', headers: admin, payload: { ...TENANT_A, environment: 'production' } });
    assert.equal(dup.statusCode, 409);

    const wrongTin = await app.inject({
      method: 'POST', url: `/v1/admin/tenants/${tenantId}/certificate`, headers: admin,
      payload: { certificatePem: readCert('signer-654321.cert.pem'), privateKeyPem: readCert('signer-654321.key.pem') },
    });
    assert.equal(wrongTin.statusCode, 422);
    assert.deepEqual([wrongTin.json().error.code, wrongTin.json().error.details], ['certificate_problem', { btsCode: 243 }]);

    const cert = await app.inject({
      method: 'POST', url: `/v1/admin/tenants/${tenantId}/certificate`, headers: admin,
      payload: { certificatePem: readCert('signer-123456.cert.pem'), privateKeyPem: readCert('signer-123456.key.pem') },
    });
    assert.equal(cert.statusCode, 201);
    assert.equal(cert.json().tin, '123456');
    assert.ok(cert.json().daysLeft > 3000);

    const key = await app.inject({ method: 'POST', url: `/v1/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { name: 'Web app' } });
    assert.equal(key.statusCode, 201);
    assert.match(key.json().key, /^etd_[a-z0-9]{12}_/);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: as(key.json().key) });
    assert.equal(me.json().environment, 'production');
    assert.equal(me.json().certificate.status, 'active');
    assert.equal(me.json().contingency.active, false);

    const bad = await app.inject({ method: 'POST', url: '/v1/admin/tenants', headers: admin, payload: { ...TENANT_A, tin: '12' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'invalid_request');
  }));

// ---------- catalog ----------

test('customers and items: create, get, list with search and pagination; other tenants see nothing', () =>
  withApi(async ({ app, keyA, keyB, as }) => {
    const created = [];
    for (const name of ['Alpha Ltd', 'Beta Ltd', 'Gamma Stores']) {
      const r = await app.inject({ method: 'POST', url: '/v1/customers', headers: as(keyA), payload: { name, tin: '111222', address: { street: '1 Main St', city: 'Belmopan', districtCode: '2' }, contact: { email: 'a@b.example' } } });
      assert.equal(r.statusCode, 201);
      created.push(r.json());
    }
    assert.deepEqual(created[0].address, { street: '1 Main St', city: 'Belmopan', districtCode: '2' });

    const page1 = (await app.inject({ method: 'GET', url: '/v1/customers?limit=2', headers: as(keyA) })).json();
    assert.equal(page1.data.length, 2);
    const page2 = (await app.inject({ method: 'GET', url: `/v1/customers?limit=2&cursor=${page1.nextCursor}`, headers: as(keyA) })).json();
    assert.equal(page2.data.length, 1);
    assert.equal(page2.nextCursor, null);
    assert.deepEqual(new Set([...page1.data, ...page2.data].map((c: { name: string }) => c.name)), new Set(['Alpha Ltd', 'Beta Ltd', 'Gamma Stores']));
    const search = (await app.inject({ method: 'GET', url: '/v1/customers?q=gamma', headers: as(keyA) })).json();
    assert.deepEqual(search.data.map((c: { name: string }) => c.name), ['Gamma Stores']);

    assert.equal((await app.inject({ method: 'GET', url: `/v1/customers/${created[0].id}`, headers: as(keyB) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/customers', headers: as(keyB) })).json().data.length, 0);

    const item = await app.inject({ method: 'POST', url: '/v1/items', headers: as(keyA), payload: { name: 'Charger', description: 'USB-C phone charger', sellerCode: 'CHG-01', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' } });
    assert.equal(item.statusCode, 201);
    assert.equal(item.json().unitPrice, '24.99');
    const exempt = await app.inject({ method: 'POST', url: '/v1/items', headers: as(keyA), payload: { name: 'Clinic visit', unitCode: 'H87', unitPrice: '50', gstCategory: 'E' } });
    assert.equal(exempt.statusCode, 422);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/items/${item.json().id}`, headers: as(keyB) })).statusCode, 404);
  }));

// ---------- issuing ----------

test('issue an invoice from a saved customer and catalog item; read it back as JSON, XML and PDF', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const customer = (await app.inject({ method: 'POST', url: '/v1/customers', headers: as(keyA), payload: { name: 'Island Logistics Ltd.', tin: '777888', address: { street: '4 Mile', city: 'Belize City', districtCode: '1' } } })).json();
    const item = (await app.inject({ method: 'POST', url: '/v1/items', headers: as(keyA), payload: { name: 'Charger', description: 'USB-C phone charger', sellerCode: 'CHG-01', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' } })).json();

    const res = await app.inject({
      method: 'POST', url: '/v1/documents', headers: as(keyA),
      payload: { type: '01', customerId: customer.id, lines: [{ itemId: item.id, quantity: '2' }, { description: 'Gift wrap', quantity: '1', unitCode: 'H87', unitPrice: '5.00', gstCategory: 'S' }], payment: { meansCode: '30', terms: 'Net 30' } },
    });
    assert.equal(res.statusCode, 201);
    const doc = res.json();
    assert.equal(res.headers.location, `/v1/documents/${doc.id}`);
    assert.equal(doc.status, 'authorized');
    assert.equal(doc.protocolNumber, '05000000100013326800126012820091024411146627');
    assert.equal(doc.number, '000000001');
    assert.equal(doc.series, '001');
    assert.equal(doc.customerId, customer.id);
    assert.equal(doc.customer.name, 'Island Logistics Ltd.');
    // 2 x 24.99 + 5.00 = 54.98; GST 12.5% = 6.8725 -> 6.87
    assert.deepEqual(doc.totals, { lineExtension: '54.98', gst: '6.87', tax: '6.87', taxInclusive: '61.85', payable: '61.85' });

    const xml = await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/xml`, headers: as(keyA) });
    assert.match(String(xml.headers['content-type']), /application\/xml/);
    assert.equal(xml.body, f.bts.requests.find((r) => r.path === INVOICE)!.body, 'the XML served is exactly what BTS received');
    assert.match(xml.body, /<cbc:Description>USB-C phone charger<\/cbc:Description>/);
    assert.match(xml.body, /<cbc:ID>CHG-01<\/cbc:ID>/);

    const pdf = await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf`, headers: as(keyA) });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    const receipt = await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf?format=receipt&widthMm=58`, headers: as(keyA) });
    assert.equal(receipt.statusCode, 200);

    const got = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(keyA) })).json();
    assert.deepEqual(got, doc);
    const listed = (await app.inject({ method: 'GET', url: '/v1/documents?status=authorized&type=01', headers: as(keyA) })).json();
    assert.deepEqual(listed.data.map((d: { id: string }) => d.id), [doc.id]);
  }));

test('Idempotency-Key: a retry replays the original response and never issues twice', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const headers = { ...as(keyA), 'idempotency-key': 'sale-0001' };
    const first = await app.inject({ method: 'POST', url: '/v1/documents', headers, payload: invoiceBody() });
    const retry = await app.inject({ method: 'POST', url: '/v1/documents', headers, payload: invoiceBody() });
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 201);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(retry.json().id, first.json().id);
    assert.equal(f.bts.requests.filter((r) => r.path === INVOICE).length, 1, 'sent to BTS once');

    const reused = await app.inject({ method: 'POST', url: '/v1/documents', headers, payload: invoiceBody({ note: 'different' }) });
    assert.equal(reused.statusCode, 422);
    assert.equal(reused.json().error.code, 'idempotency_key_reused');

    // A request that fails validation releases its key, so the corrected request can reuse it.
    const k2 = { ...as(keyA), 'idempotency-key': 'sale-0002' };
    const bad = await app.inject({ method: 'POST', url: '/v1/documents', headers: k2, payload: invoiceBody({ customer: undefined }) });
    assert.equal(bad.statusCode, 422);
    const fixed = await app.inject({ method: 'POST', url: '/v1/documents', headers: k2, payload: invoiceBody() });
    assert.equal(fixed.statusCode, 201);
    assert.equal(fixed.json().serial, 2);
  }));

test('validation: schema errors are 400, document rule errors are 422 with a clear message', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const noLines = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: { type: '01', lines: [] } });
    assert.equal(noLines.statusCode, 400);
    const floatPrice = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody({ lines: [{ description: 'x', quantity: '1', unitCode: 'H87', unitPrice: 24.99, gstCategory: 'S' }] }) });
    assert.equal(floatPrice.statusCode, 400, 'money must be a decimal string, never a JSON number');
    const incomplete = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody({ lines: [{ quantity: '1' }] }) });
    assert.equal(incomplete.statusCode, 422);
    assert.match(incomplete.json().error.message, /Line 1: give an itemId/);
    const noCustomer = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody({ customer: undefined }) });
    assert.equal(noCustomer.statusCode, 422);
    assert.match(noCustomer.json().error.message, /code 283/);
    assert.equal(f.bts.requests.length, 0, 'nothing invalid reached BTS');
  }));

test('a document BTS rejects is created (201) with status rejected and the rule codes', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, rejectedWith('271', 'Rejection: Invalid hash of sequence information tracing of this ETD'));
    const res = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody() });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'rejected');
    assert.deepEqual(res.json().conditions.map((c: { code: string }) => c.code), ['271']);
    const pdf = await app.inject({ method: 'GET', url: `/v1/documents/${res.json().id}/pdf`, headers: as(keyA) });
    assert.equal(pdf.statusCode, 409, 'a rejected document has no valid printed copy');
  }));

test('contingency through the API, recovered by the worker when BTS returns', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, DOWN);
    f.bts.script(DOCUMENT_QUERY_PATH, NOT_FOUND);
    const res = await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody() });
    assert.equal(res.statusCode, 201);
    const doc = res.json();
    assert.equal(doc.status, 'contingency_pending');
    assert.equal(doc.contingency, true);
    assert.equal(doc.series, '900');
    assert.ok(doc.supersedes);
    const original = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.supersedes}`, headers: as(keyA) })).json();
    assert.equal(original.status, 'superseded');
    assert.equal(original.supersededBy, doc.id);

    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: as(keyA) })).json();
    assert.equal(me.contingency.active, true);
    assert.equal(me.contingency.queued, 1);
    const pdf = await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf`, headers: as(keyA) });
    assert.equal(pdf.statusCode, 200, 'a contingency document can be printed: it says "Pending of BTS authorization"');

    // BTS is back: one worker tick sends the queue and reconciles the original.
    f.bts.script(INVOICE, AUTHORIZED);
    const tick = await runWorkerOnce(f.deps);
    assert.equal(tick.delivered, 1);
    assert.equal(tick.reconciled, 1);
    assert.deepEqual(tick.failures, []);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(keyA) })).json().status, 'authorized');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: as(keyA) })).json().contingency.active, false);
    assert.equal((await runWorkerOnce(f.deps)).tenants, 0, 'nothing left to do');
  }));

test('cancel an authorized document; cannot cancel twice or touch another tenant', () =>
  withApi(async ({ app, f, keyA, keyB, as }) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['05'], { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44) }) });
    const doc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody() })).json();
    assert.equal((await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: as(keyB), payload: { reason: 'x' } })).statusCode, 404);
    const res = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: as(keyA), payload: { reason: 'Issued to the wrong customer' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cancellation.status, 'registered');
    assert.equal(res.json().document.status, 'cancelled');
    const again = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: as(keyA), payload: { reason: 'again' } });
    assert.equal(again.statusCode, 409);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf`, headers: as(keyA) })).statusCode, 409);
  }));

test('a credit note can reference the original by its document id', () =>
  withApi(async ({ app, f, keyA, as }) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
    const invoice = (await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody() })).json();
    const credit = await app.inject({
      method: 'POST', url: '/v1/documents', headers: as(keyA),
      payload: invoiceBody({ type: '04', reference: { documentId: invoice.id, reason: 'Returned one charger' }, lines: [{ description: 'Phone charger', quantity: '1', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' }] }),
    });
    assert.equal(credit.statusCode, 201);
    assert.equal(credit.json().referencedEtdui, invoice.etdui);
    const xml = (await app.inject({ method: 'GET', url: `/v1/documents/${credit.json().id}/xml`, headers: as(keyA) })).body;
    assert.match(xml, new RegExp(`<cbc:UUID>${invoice.etdui}</cbc:UUID>`));
    assert.match(xml, /<cbc:IssueTime>\d{2}:\d{2}:\d{2}-06:00<\/cbc:IssueTime><cbc:DocumentTypeCode>01/);
  }));

test('the worker finishes a pending document; tenants never see each other\'s documents', () =>
  withApi(async ({ app, f, keyA, keyB, as }) => {
    f.deps.contingency = { enabled: false };
    f.bts.script(INVOICE, DOWN);
    f.bts.script(DOCUMENT_QUERY_PATH, NOT_FOUND);
    const doc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: as(keyA), payload: invoiceBody() })).json();
    assert.equal(doc.status, 'pending');
    assert.equal(doc.problem.kind, 'undetermined');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf`, headers: as(keyA) })).statusCode, 409);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/pdf?draft=true`, headers: as(keyA) })).statusCode, 200);

    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(keyB) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/xml`, headers: as(keyB) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/documents', headers: as(keyB) })).json().data.length, 0);

    f.bts.script(INVOICE, AUTHORIZED);
    const tick = await runWorkerOnce(f.deps, { pendingAgeMs: 0 });
    assert.equal(tick.resumed, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(keyA) })).json().status, 'authorized');
  }));
