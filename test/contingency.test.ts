import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { parseEtdui } from '../src/engine/etdui.ts';
import { DOCUMENT_QUERY_PATH, SUBMIT_PATHS } from '../src/engine/transport.ts';
import { NS } from '../src/engine/ubl.ts';
import { cancelDocument, catchUpContingency, issueDocument, PipelineError } from '../src/pipeline/issue.ts';
import { applicationResponse, type FakeBts } from './fake-bts.ts';
import { AUTHORIZED, invoiceRequest, LINE, rejectedWith, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const INVOICE = SUBMIT_PATHS['01'];
const RECEIPT = SUBMIT_PATHS['02'];
const EVENT = SUBMIT_PATHS['05'];
const DOWN = { status: 500, body: 'Rejection: Server error' };
const EVENT_REGISTERED = { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44), protocol: '05000000100000060300125060903091019472728439' }) };

async function withPipeline(fn: (f: PipelineFixture) => Promise<void>) {
  const f = await setupPipeline();
  try {
    await fn(f);
  } finally {
    await f.close();
  }
}

/** BTS unreachable for submissions; Document Query says nothing is there. */
function btsDown(bts: FakeBts) {
  for (const path of Object.values(SUBMIT_PATHS)) bts.script(path, DOWN);
  bts.script(DOCUMENT_QUERY_PATH, { status: 200, contentType: 'application/json', body: JSON.stringify({ GetDocument: { ResponseCode: '004' } }) });
}

/** Document Query answers per ETDUI: "authorized" for the ones listed, "not found" otherwise. */
function queryAnswers(bts: FakeBts, authorized: Set<string>) {
  bts.handle(DOCUMENT_QUERY_PATH, (req) => {
    const etdui = (JSON.parse(req.body) as { ETDUI: string }).ETDUI;
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ GetDocument: { UUID: etdui, ResponseCode: authorized.has(etdui) ? '005' : '004' } }) };
  });
}

const efdr = (xml: string, name: string) => new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS.efdr, name)[0]?.textContent ?? undefined;

const docRow = async (f: PipelineFixture, id: string) =>
  (await f.db.query<{ status: string; status_detail: Record<string, unknown> | null; series_number: number; oper_mode: number; supersedes_document_id: string | null }>(
    'select status, status_detail, series_number, oper_mode, supersedes_document_id from documents where id = $1',
    [id],
  )).rows[0]!;

test('BTS unreachable: the sale is reissued in contingency and the original is superseded', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(r.status, 'contingency_pending');
    assert.equal(r.contingency, true);
    assert.ok(r.supersededDocumentId);

    // The reissue: contingency series 900, operMode 2, contingency info, chained in its own series.
    const id = parseEtdui(r.etdui);
    assert.equal(id.series, 900);
    assert.equal(id.operMode, 2);
    assert.equal(r.serial, 1);
    assert.match(efdr(r.signedXml, 'contingencyReason')!, /^BTS reception unreachable/);
    assert.match(efdr(r.signedXml, 'contingencyInitTime')!, /^\d{2}:\d{2}:\d{2}-06:00$/);
    const row = await docRow(f, r.documentId);
    assert.equal(row.supersedes_document_id, r.supersededDocumentId);

    // The original: superseded, never to be sent again, linked to its replacement.
    const original = await docRow(f, r.supersededDocumentId!);
    assert.equal(original.status, 'superseded');
    assert.equal(original.status_detail?.supersededByEtdui, r.etdui);

    // The normal series no longer points at the superseded document's hash.
    const series = (await f.db.query<{ last_sequence_hash: string | null }>(`select last_sequence_hash from series where tenant_id = $1 and series_number = 1`, [f.tenantA])).rows[0]!;
    assert.equal(series.last_sequence_hash, null);
  }));

test('while in contingency, new documents go straight to contingency with the same contingency info', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    const first = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const sent = f.bts.requests.length;
    const second = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const receipt = await issueDocument(f.deps, f.tenantA, { etdType: '02', lines: [LINE], payment: { meansCode: '10', terms: 'Cash' } });
    assert.equal(f.bts.requests.length, sent, 'nothing is sent while the contingency period is open');
    assert.equal(second.delivery, 'not_sent');
    assert.equal(second.serial, 2);
    assert.equal(parseEtdui(receipt.etdui).operMode, 3, 'Tax Receipts use operMode 3');
    for (const name of ['contingencyReason', 'contingencyInitDate', 'contingencyInitTime']) {
      assert.equal(efdr(second.signedXml, name), efdr(first.signedXml, name), `${name} is shared across the period (manual 3.3.6.3)`);
    }
    // The contingency series has its own hash chain.
    assert.equal(efdr(second.signedXml, 'sequenceInfoPreviousETD'), efdr(first.signedXml, 'sequenceInfoThisETD'));
  }));

test('catch-up: when BTS is back, the queue is sent in order, the period closes, and normal mode resumes', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    const a = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const b = await issueDocument(f.deps, f.tenantA, invoiceRequest());

    f.bts.script(INVOICE, AUTHORIZED);
    queryAnswers(f.bts, new Set());
    const result = await catchUpContingency(f.deps, f.tenantA);
    assert.deepEqual(result.delivered.map((d) => d.documentId), [a.documentId, b.documentId]);
    assert.ok(result.delivered.every((d) => d.status === 'authorized'));
    assert.equal(result.remaining, 0);
    assert.equal(result.periodClosed, true);
    // The superseded original never reached BTS: nothing more to do.
    assert.deepEqual(result.reconciled.map((x) => [x.documentId, x.resolution]), [[a.supersededDocumentId, 'not_found']]);
    assert.equal((await docRow(f, a.supersededDocumentId!)).status_detail?.resolution, 'not_found');

    const next = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(next.contingency, false);
    assert.equal(next.status, 'authorized');
    assert.equal(parseEtdui(next.etdui).series, 1);
  }));

test('catch-up while BTS is still down stops at the first failure and keeps the period open', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    await issueDocument(f.deps, f.tenantA, invoiceRequest());
    await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const before = f.bts.requests.filter((r) => r.path === INVOICE).length;
    const result = await catchUpContingency(f.deps, f.tenantA);
    assert.equal(result.delivered.length, 0);
    assert.equal(result.remaining, 2);
    assert.equal(result.periodClosed, false);
    assert.ok(f.bts.requests.filter((r) => r.path === INVOICE).length - before <= 3, 'only the first queued document was tried');
  }));

test('if BTS had authorized the original after all, catch-up cancels it with event 050', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    const r = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const originalEtdui = (await f.db.query<{ etdui: string }>('select etdui from documents where id = $1', [r.supersededDocumentId])).rows[0]!.etdui;

    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(EVENT, EVENT_REGISTERED);
    queryAnswers(f.bts, new Set([originalEtdui]));
    const result = await catchUpContingency(f.deps, f.tenantA);
    assert.deepEqual(result.reconciled.map((x) => x.resolution), ['cancelled']);

    const original = await docRow(f, r.supersededDocumentId!);
    assert.equal(original.status, 'cancelled');
    assert.equal(original.status_detail?.resolution, 'cancelled');
    const event = (await f.db.query<{ status: string; event_code: string; reason: string; signed_xml: string; referenced_etdui: string }>(
      'select status, event_code, reason, signed_xml, referenced_etdui from events where document_id = $1', [r.supersededDocumentId],
    )).rows[0]!;
    assert.equal(event.status, 'registered');
    assert.equal(event.event_code, '050');
    assert.equal(event.referenced_etdui, originalEtdui);
    assert.match(event.reason, new RegExp(`Superseded by contingency document ${r.etdui}`));
    const sentEvent = f.bts.requests.find((q) => q.path === EVENT)!;
    assert.equal(sentEvent.body, event.signed_xml);
    assert.equal(efdr(sentEvent.body, 'series'), '050');
  }));

test('cancelDocument: registers event 050 and cancels the document; a second call does not register again', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(EVENT, EVENT_REGISTERED);
    const doc = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const c = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'Issued to the wrong customer');
    assert.equal(c.status, 'registered');
    assert.equal(c.documentStatus, 'cancelled');
    assert.equal(parseEtdui(c.eventEtdui).series, 50);
    assert.equal((await docRow(f, doc.documentId)).status, 'cancelled');
    const again = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'again').catch((e: Error) => e);
    assert.ok(again instanceof PipelineError, 'an already cancelled document cannot be cancelled again');
    assert.equal(f.bts.requests.filter((q) => q.path === EVENT).length, 1);
  }));

test('cancelDocument: a rejected cancellation leaves the document authorized', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(EVENT, rejectedWith('268', 'Rejection: Invalid author for event type'));
    const doc = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const c = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'test');
    assert.equal(c.status, 'rejected');
    assert.deepEqual(c.conditions.map((x) => x.code), ['268']);
    assert.equal((await docRow(f, doc.documentId)).status, 'authorized');
  }));

test('cancelDocument refuses documents that are not authorized, and refuses during contingency', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, rejectedWith('283', 'Rejection: Accounting Customer Party is mandatory'));
    const rejected = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    await assert.rejects(cancelDocument(f.deps, f.tenantA, rejected.documentId, 'x'), /Only an authorized document/);
    await assert.rejects(cancelDocument(f.deps, f.tenantA, rejected.documentId, ' '), /needs a reason/);

    f.bts.script(INVOICE, AUTHORIZED);
    const ok = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    btsDown(f.bts);
    await issueDocument(f.deps, f.tenantA, invoiceRequest()); // opens a contingency period
    await assert.rejects(cancelDocument(f.deps, f.tenantA, ok.documentId, 'x'), /while in contingency/);
    // Another tenant's document is invisible.
    await assert.rejects(cancelDocument(f.deps, f.tenantB, ok.documentId, 'x'), /Unknown document/);
  }));

test('a cancellation that cannot reach BTS stays pending and is resumed by the next call', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    const doc = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    f.bts.script(EVENT, DOWN);
    queryAnswers(f.bts, new Set());
    const first = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'Duplicate sale');
    assert.equal(first.status, 'pending');
    f.bts.script(EVENT, EVENT_REGISTERED);
    const second = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'Duplicate sale');
    assert.equal(second.status, 'registered');
    assert.equal(second.eventId, first.eventId, 'the same event is resumed, not a new one');
  }));

test('events are permanent records', () =>
  withPipeline(async (f) => {
    f.bts.script(INVOICE, AUTHORIZED);
    f.bts.script(EVENT, EVENT_REGISTERED);
    const doc = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    const c = await cancelDocument(f.deps, f.tenantA, doc.documentId, 'x');
    await assert.rejects(f.db.query(`update events set signed_xml = 'x' where id = $1`, [c.eventId]), /cannot be modified/);
    await assert.rejects(f.db.query(`update events set status = 'pending' where id = $1`, [c.eventId]), /cannot change/);
    await assert.rejects(f.db.query(`delete from events where id = $1`, [c.eventId]), /permanent/);
  }));

test('a receipt in contingency is sent to the receipt endpoint during catch-up', () =>
  withPipeline(async (f) => {
    btsDown(f.bts);
    const receipt = await issueDocument(f.deps, f.tenantA, { etdType: '02', lines: [LINE], payment: { meansCode: '10', terms: 'Cash' } });
    assert.equal(receipt.status, 'contingency_pending');
    f.bts.script(RECEIPT, AUTHORIZED);
    queryAnswers(f.bts, new Set());
    const result = await catchUpContingency(f.deps, f.tenantA);
    assert.equal(result.delivered[0]!.status, 'authorized');
    assert.ok(f.bts.requests.some((q) => q.path === RECEIPT && q.body === receipt.signedXml));
  }));
