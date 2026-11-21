import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBigInt } from '../src/db/database.ts';
import { KeystoreError } from '../src/db/keystore.ts';
import { addCertificate, loadTenantContext } from '../src/db/tenants.ts';
import { CertificateError } from '../src/engine/certificate.ts';
import { SUBMIT_PATHS, DOCUMENT_QUERY_PATH } from '../src/engine/transport.ts';
import { UblError } from '../src/engine/ubl.ts';
import { issueDocument, resumePending } from '../src/pipeline/issue.ts';
import {
  AUTHORIZED,
  invoiceRequest,
  LINE,
  queryReply,
  readCert,
  rejectedWith,
  setupPipeline,
  type PipelineFixture,
} from './pipeline-setup.ts';

const INVOICE = SUBMIT_PATHS['01'];

async function withPipeline(fn: (f: PipelineFixture) => Promise<void>) {
  const f = await setupPipeline();
  try {
    await fn(f);
  } finally {
    await f.close();
  }
}

const seriesRow = async (f: PipelineFixture, tenantId: string, etdType = '01', seriesNumber = 1) =>
  (await f.db.query<{ next_serial: unknown; last_sequence_hash: string | null }>(
    'select next_serial, last_sequence_hash from series where tenant_id = $1 and etd_type = $2 and series_number = $3',
    [tenantId, etdType, seriesNumber],
  )).rows[0]!;

const docs = async (f: PipelineFixture, tenantId: string) =>
  (await f.db.query<{ id: string; serial: unknown; status: string; sequence_hash: string; previous_sequence_hash: string | null; signed_xml: string; protocol_number: string | null }>(
    'select id, serial, status, sequence_hash, previous_sequence_hash, signed_xml, protocol_number from documents where tenant_id = $1 order by serial',
    [tenantId],
  )).rows;

test('issues an invoice end to end and keeps the legal record', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'authorized');
    assert.equal(r.serial, 1);
    assert.equal(r.protocolNumber, '05000000100013326800126012820091024411146627');

    const [doc] = await docs(f, f.tenantA);
    assert.equal(doc!.status, 'authorized');
    assert.equal(doc!.protocol_number, r.protocolNumber);
    assert.equal(doc!.signed_xml, f.bts.requests[0]!.body, 'stored XML is exactly what was sent');

    const subs = (await f.db.query<{ action: string; raw_reply: string; http_status: number }>('select action, raw_reply, http_status from submissions where document_id = $1', [doc!.id])).rows;
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.raw_reply, AUTHORIZED.body, "BTS's reply stored exactly as received");

    const lines = (await f.db.query<{ net_cents: unknown }>('select net_cents from document_lines where document_id = $1', [doc!.id])).rows;
    assert.equal(toBigInt(lines[0]!.net_cents), 4998n);

    const series = await seriesRow(f, f.tenantA);
    assert.equal(toBigInt(series.next_serial), 2n);
    assert.equal(series.last_sequence_hash, doc!.sequence_hash);
  }));

test('serial numbers and the hash chain run on across documents', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    for (let i = 0; i < 3; i++) await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const rows = await docs(f, f.tenantA);
    assert.deepEqual(rows.map((d) => Number(d.serial)), [1, 2, 3]);
    assert.equal(rows[0]!.previous_sequence_hash, null);
    assert.equal(rows[1]!.previous_sequence_hash, rows[0]!.sequence_hash);
    assert.equal(rows[2]!.previous_sequence_hash, rows[1]!.sequence_hash);
    // And the chain is what was actually signed and sent.
    assert.match(rows[1]!.signed_xml, new RegExp(`<efdr:sequenceInfoPreviousETD>${rows[0]!.sequence_hash.replace(/[+/]/g, '\\$&')}<`));
  }));

test('many documents issued at once on one series get unique serials and an unbroken chain', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const results = await Promise.all(Array.from({ length: 15 }, () => issueDocument(f.deps, f.tenantA, invoiceRequest())));
    assert.deepEqual(results.map((r) => r.serial).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
    const rows = await docs(f, f.tenantA);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.previous_sequence_hash, rows[i - 1]!.sequence_hash, `link ${i}`);
    assert.equal(toBigInt((await seriesRow(f, f.tenantA)).next_serial), 16n);
  }));

test('separate series number independently', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const a = await issueDocument(f.deps, f.tenantA, invoiceRequest({ seriesNumber: 1 }));
    const b = await issueDocument(f.deps, f.tenantA, invoiceRequest({ seriesNumber: 2 }));
    const receipt = await issueDocument(f.deps, f.tenantA, { etdType: '02', lines: [LINE], payment: { meansCode: '10', terms: 'Cash' } });
    assert.deepEqual([a.serial, b.serial, receipt.serial], [1, 1, 1]);
  }));

test('a rejection is stored with its rule codes, and the chain skips the rejected serial', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED, rejectedWith('271', 'Rejection: Invalid hash of sequence information tracing of this ETD'), AUTHORIZED);
    const first = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const rejected = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual(rejected.conditions.map((c) => c.code), ['271']);
    const third = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(third.serial, 3, 'the rejected serial stays used');
    const rows = await docs(f, f.tenantA);
    assert.equal(rows[2]!.previous_sequence_hash, rows[0]!.sequence_hash, 'serial 3 chains to serial 1, skipping the rejected 2');
    assert.equal(first.status, 'authorized');
  }));

test('invalid input never consumes a serial number', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    await assert.rejects(issueDocument(f.deps, f.tenantA, invoiceRequest({ customer: undefined })), UblError); // invoice needs a customer
    await assert.rejects(issueDocument(f.deps, f.tenantA, invoiceRequest({ lines: [{ ...LINE, quantity: '0' }] })), /greater than zero/);
    assert.equal((await docs(f, f.tenantA)).length, 0);
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.serial, 1);
    assert.equal(f.bts.requests.length, 1);
  }));

test('BTS down with contingency off: the document stays pending, and resumePending finishes it later', () =>
  withPipeline(async (f) => {
    f.deps.contingency = { enabled: false }; // this test is about the pending path, not contingency
    f.bts.script(INVOICE, { status: 500, body: 'Rejection: Server error' });
    f.bts.script(DOCUMENT_QUERY_PATH, queryReply('004'));
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'pending');
    assert.equal(r.delivery, 'undetermined');

    f.bts.script(INVOICE, AUTHORIZED);
    const [resumed] = await resumePending(f.deps, f.tenantA, { olderThanMs: 0 });
    assert.equal(resumed!.status, 'authorized');
    assert.equal(resumed!.documentId, r.documentId);
    const attempts = (await f.db.query<{ attempt: number }>('select attempt from submissions where document_id = $1 order by id', [r.documentId])).rows.map((x) => x.attempt);
    assert.ok(attempts.length > 3);
    assert.deepEqual(attempts, [...attempts].sort((a, b) => a - b), 'attempt numbers keep counting up across runs');
  }));

test('after a crash, resumePending asks Document Query first and does not resend a document BTS already holds', () =>
  withPipeline(async (f) => {
    f.deps.contingency = { enabled: false }; // this test is about the pending path, not contingency
    // First run: BTS keeps failing and its queries say "not found" yet.
    f.bts.script(INVOICE, { status: 500, body: '' });
    f.bts.script(DOCUMENT_QUERY_PATH, queryReply('004'));
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'pending');
    // Meanwhile BTS processed one of those attempts after all.
    f.bts.script(DOCUMENT_QUERY_PATH, queryReply('005'));
    f.bts.script(INVOICE, AUTHORIZED);
    const sendsBefore = f.bts.requests.filter((q) => q.path === INVOICE).length;
    const [resumed] = await resumePending(f.deps, f.tenantA, { olderThanMs: 0 });
    assert.equal(resumed!.status, 'authorized');
    assert.equal(f.bts.requests.filter((q) => q.path === INVOICE).length, sendsBefore, 'not sent again');
    const detail = (await f.db.query<{ status_detail: { recoveredBy?: string } }>('select status_detail from documents where id = $1', [r.documentId])).rows[0]!.status_detail;
    assert.equal(detail.recoveredBy, 'query');
  }));

test('a resend answered with 255 (already authorized) settles as authorized', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, rejectedWith('255', 'Rejection: The ETDUI used in the XML file is the same of one that has already been authorized by EFDR'));
    f.bts.script(DOCUMENT_QUERY_PATH, queryReply('005'));
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'authorized');
    const detail = (await f.db.query<{ status_detail: { recoveredBy?: string } }>('select status_detail from documents where id = $1', [r.documentId])).rows[0]!.status_detail;
    assert.equal(detail.recoveredBy, 'duplicate');
  }));

test('a certificate problem (401) leaves the document pending and says why', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, { status: 401, body: '' });
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'pending');
    assert.equal(r.delivery, 'certificate_problem');
    const detail = (await f.db.query<{ status_detail: { problem: string } }>('select status_detail from documents where id = $1', [r.documentId])).rows[0]!.status_detail;
    assert.equal(detail.problem, 'certificate');
  }));

test('issued documents are permanent: no edits, no deletes, only allowed status changes', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const id = r.documentId;
    await assert.rejects(f.db.query(`update documents set signed_xml = 'x' where id = $1`, [id]), /cannot be modified/);
    await assert.rejects(f.db.query(`update documents set payable_cents = 1 where id = $1`, [id]), /cannot be modified/);
    await assert.rejects(f.db.query(`delete from documents where id = $1`, [id]), /permanent/);
    await assert.rejects(f.db.query(`update documents set status = 'pending' where id = $1`, [id]), /cannot change from authorized to pending/);
    await assert.rejects(f.db.query(`delete from submissions where document_id = $1`, [id]), /permanent/);
    await assert.rejects(f.db.query(`update document_lines set net_cents = 0 where document_id = $1`, [id]), /permanent/);
    await f.db.query(`update documents set status = 'cancelled' where id = $1`, [id]); // the one allowed change
  }));

test('tenants are isolated: own series, own certificate, own pending work', () =>
  withPipeline(async (f) => {
    f.deps.contingency = { enabled: false }; // this test is about the pending path, not contingency
    f.bts.script(INVOICE, { status: 500, body: '' });
    f.bts.script(DOCUMENT_QUERY_PATH, queryReply('004'));
    const [a, b] = await Promise.all([
      issueDocument(f.deps, f.tenantA, invoiceRequest()),
      issueDocument(f.deps, f.tenantB, invoiceRequest()),
    ]);
    assert.deepEqual([a.serial, b.serial], [1, 1]);
    assert.ok(a.etdui.slice(3, 9) === '123456' && b.etdui.slice(3, 9) === '654321');
    // Each tenant's documents were sent over its own certificate.
    const cns = new Set(f.bts.requests.filter((q) => q.path === INVOICE).map((q) => q.clientCn));
    assert.deepEqual([...cns].sort(), ['CaribFuel C=BZ TIN=123456', 'Other Business C=BZ TIN=654321']);
    assert.equal(f.clients.size, 2);

    f.bts.script(INVOICE, AUTHORIZED);
    const resumedB = await resumePending(f.deps, f.tenantB, { olderThanMs: 0 });
    assert.deepEqual(resumedB.map((r) => r.documentId), [b.documentId]);
    assert.equal((await docs(f, f.tenantA))[0]!.status, 'pending', "B's worker never touches A's documents");
  }));

test("a private key copied onto another tenant's row cannot be used", () =>
  withPipeline(async (f) => {
    await f.db.query(
      `update certificates set encrypted_key = (select encrypted_key from certificates where tenant_id = $1 and status = 'active')
       where tenant_id = $2 and status = 'active'`,
      [f.tenantA, f.tenantB],
    );
    await assert.rejects(loadTenantContext(f.db, f.deps.keys, f.tenantB), KeystoreError);
  }));

test('a certificate for another TIN, or a mismatched key, is refused at onboarding', () =>
  withPipeline(async (f) => {
    await assert.rejects(
      addCertificate(f.db, f.deps.keys, f.tenantA, { certificatePem: readCert('signer-654321.cert.pem'), privateKeyPem: readCert('signer-654321.key.pem') }),
      (e: unknown) => e instanceof CertificateError && e.btsCode === 243,
    );
    await assert.rejects(
      addCertificate(f.db, f.deps.keys, f.tenantA, { certificatePem: readCert('signer-123456.cert.pem'), privateKeyPem: readCert('signer-654321.key.pem') }),
      /does not match/,
    );
    const active = (await f.db.query<{ n: number }>(`select count(*)::int as n from certificates where tenant_id = $1 and status = 'active'`, [f.tenantA])).rows[0]!.n;
    assert.equal(active, 1);
  }));

test('a renewed certificate replaces the old one and gets its own connection', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    await issueDocument(f.deps, f.tenantA, invoiceRequest());
    await addCertificate(f.db, f.deps.keys, f.tenantA, { certificatePem: readCert('signer-123456.cert.pem'), privateKeyPem: readCert('signer-123456.key.pem') });
    const statuses = (await f.db.query<{ status: string }>('select status from certificates where tenant_id = $1 order by created_at', [f.tenantA])).rows.map((r) => r.status);
    assert.deepEqual(statuses.sort(), ['active', 'retired']);
    await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(f.clients.size, 1, 'same certificate bytes, same pooled client');
  }));
