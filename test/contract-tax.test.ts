/**
 * Contract tax: customers who withhold 6% of an invoice (before GST) and pay
 * it to BTS. The invoice keeps its full total and says so; its balance is the
 * rest; the accountant pack lists what was withheld.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
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

async function withBusiness(fn: (c: { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string> }) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  try {
    await fn({ f, app, owner: { ...CSRF, cookie: cookieFrom(res), 'x-business': slug } });
  } finally {
    await app.close();
    await f.close();
  }
}

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLength = buf.readUInt16LE(i + 26);
    const extraLength = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLength);
    const start = i + 30 + nameLength + extraLength;
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    i = start + size;
  }
  return files;
}

const job = { description: 'Office renovation', quantity: '1', unitCode: 'E48', unitPrice: '1000.00', gstCategory: 'S' };

test('contract tax: the customer withholds 6% before GST; the invoice says so and its balance is the rest', () =>
  withBusiness(async ({ app, owner }) => {
    const ministry = await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Ministry of Works', tin: '100200', address, withholdsContractTax: true } });
    assert.equal(ministry.statusCode, 201, ministry.body);
    assert.equal(ministry.json().withholdsContractTax, true);
    const edited = await app.inject({ method: 'PUT', url: `/v1/customers/${ministry.json().id}`, headers: owner, payload: { name: 'Ministry of Works', tin: '100200', address } });
    assert.equal(edited.json().withholdsContractTax, true, 'left out: it stays');

    const res = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '01', customerId: ministry.json().id, lines: [job], payment: { meansCode: '30', dueDate: '2099-12-31' }, contractTax: true } });
    assert.equal(res.statusCode, 201, res.body);
    const doc = res.json();
    assert.equal(doc.totals.payable, '1125.00', 'the invoice keeps its full total');
    assert.deepEqual(doc.payment.withheld, { percent: '6', amount: '60.00' });
    assert.equal(doc.payment.balance, '1065.00');
    const xml = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/xml`, headers: owner })).body;
    assert.match(xml, /Contract tax of 6% \(BZ\$60\.00 on BZ\$1000\.00 before GST\) is withheld by the customer and paid to BTS\. Amount to pay: BZ\$1065\.00\./);

    // Paying the rest settles it.
    const paid = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/payments`, headers: owner, payload: { amount: '1065.00', method: 'bank_transfer', paidOn: today() } });
    assert.equal(paid.statusCode, 201, paid.body);
    const after = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: owner })).json();
    assert.equal(after.payment.status, 'paid');
    assert.equal(after.payment.balance, '0.00');

    // Paid on the spot: only the rest is recorded.
    const spot = (await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '01', customerId: ministry.json().id, lines: [job], payment: { meansCode: '30', dueDate: '2099-12-31' }, contractTax: true, paid: { method: 'cheque' } } })).json();
    assert.equal(spot.payment.status, 'paid');
    assert.equal(spot.payment.paid, '1065.00');

    // Receipts are paid at the counter: no withholding there.
    const receipt = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '02', lines: [job], payment: { meansCode: '10', terms: 'Cash' }, contractTax: true } });
    assert.equal(receipt.json().error.code, 'contract_tax_invoices_only');
  }));

test('contract tax: work invoiced for a customer who withholds it, and the accountant pack lists it', () =>
  withBusiness(async ({ app, owner }) => {
    const ministry = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Ministry of Works', tin: '100200', address, withholdsContractTax: true } })).json();
    await app.inject({ method: 'POST', url: '/v1/work', headers: owner, payload: { customerId: ministry.id, date: today(), description: 'Site survey', quantity: '10', unitCode: 'HUR', unitPrice: '50' } });
    const inv = await app.inject({ method: 'POST', url: '/v1/work/invoice', headers: owner, payload: { customerId: ministry.id } });
    assert.equal(inv.statusCode, 200, inv.body);
    const doc = (await app.inject({ method: 'GET', url: `/v1/documents/${inv.json().documentId}`, headers: owner })).json();
    assert.deepEqual(doc.payment.withheld, { percent: '6', amount: '30.00' });
    assert.equal(doc.payment.balance, '532.50', '562.50 less 30.00 withheld');

    const month = `${today().slice(0, 7)}-01`;
    const pack = await app.inject({ method: 'GET', url: `/v1/reports/accountant-pack?from=${month}&to=${today()}`, headers: owner });
    const csv = unzip(pack.rawPayload).get('contract-tax-withheld.csv')!.toString();
    assert.match(csv, /Ministry of Works,100200,500\.00,6,30\.00/);
    assert.match(csv, /Total,,,,,,30\.00/);
  }));
