/**
 * The submit pipeline (spec "Architecture"): issue, cancel and recover documents for a tenant.
 *
 *   Phase 1, one transaction, series row locked (SELECT ... FOR UPDATE):
 *     take the next serial, build the ETDUI, build the XML chained to the
 *     previous document's hash, sign, store with the signed XML exactly as it
 *     will be sent, advance the series. Commit releases the lock.
 *   Phase 2, no lock held:
 *     deliver to BTS, store every attempt with BTS's raw reply, settle the status.
 *
 * Store-before-send: if the process dies during phase 2, the document is
 * already stored and resumePending() finishes the job, asking Document Query
 * first so nothing is authorized twice.
 *
 * Contingency (manual 3.3.6): when delivery stays undetermined, the sale is
 * reissued in a contingency series under subsequent authorization (operMode
 * 2, or 3 for Tax Receipts) and the original is marked superseded, all in
 * one transaction. While the tenant's contingency period is open, new
 * documents go straight to contingency. catchUpContingency() sends the queue
 * when BTS is back; reconcileSuperseded() checks each superseded original and
 * cancels it (event 050) if BTS had authorized it after all.
 *
 * Only documents in the same series wait for each other, and only for phase 1.
 */

import { randomUUID } from 'node:crypto';
import { calculateDocument, type LineInput, type TaxConfig } from '../engine/calc.ts';
import { type AttemptLog, deliver, type DeliveryOptions, type DeliveryOutcome } from '../engine/delivery.ts';
import { buildEtdui, ETD_TYPES, generateSecurityCode, OPER_MODES, type OperMode } from '../engine/etdui.ts';
import { buildCancellationEvent, CANCELLATION_SERIES, EVENT_CODES } from '../engine/event.ts';
import type { Condition } from '../engine/response.ts';
import { signDocument } from '../engine/sign.ts';
import { toBelizeDateTime } from '../engine/time.ts';
import { type BtsClient, RECEPTION_ENV } from '../engine/transport.ts';
import {
  buildUblDocument,
  type Contingency,
  type Customer,
  type DocumentReference,
  type IssuedEtdType,
  type Payment,
  type UblOptions,
} from '../engine/ubl.ts';
import { verifyDocumentSignature } from '../engine/verify.ts';
import type { Database, Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { loadTenantContext, type TenantContext } from '../db/tenants.ts';

export interface ClientProvider {
  /** The BtsClient for this tenant's current certificate. */
  get(ctx: TenantContext): BtsClient;
}

export interface ContingencyPolicy {
  /** Reissue in contingency when delivery is undetermined. Default true. */
  enabled?: boolean;
  /** Series number reserved for contingency documents. Default 900. */
  seriesNumber?: number;
}

export interface PipelineDeps {
  db: Database;
  keys: KeyProtector;
  clients: ClientProvider;
  now?: () => Date;
  delivery?: DeliveryOptions;
  ubl?: UblOptions;
  tax?: TaxConfig;
  contingency?: ContingencyPolicy;
}

export interface IssueRequest {
  etdType: IssuedEtdType;
  /** Defaults to 1 ("001"). */
  seriesNumber?: number;
  customer?: Customer;
  customerId?: string;
  lines: LineInput[];
  reference?: DocumentReference;
  payment?: Payment;
  note?: string;
  prepaidAmount?: string;
  payableRoundingAmount?: string;
}

export type DocumentStatus =
  | 'pending'
  | 'authorized'
  | 'authorized_with_alert'
  | 'rejected'
  | 'contingency_pending'
  | 'superseded'
  | 'cancelled';

export interface IssueResult {
  documentId: string;
  etdui: string;
  seriesNumber: number;
  serial: number;
  status: DocumentStatus;
  /** What delivery concluded, or "not_sent" for a contingency document queued while BTS is out. */
  delivery: DeliveryOutcome['status'] | 'not_sent';
  protocolNumber?: string;
  conditions: Condition[];
  signedXml: string;
  /** Issued under subsequent authorization (operMode 2 or 3). Its printed copy says "Pending of BTS authorization". */
  contingency: boolean;
  /** For a contingency reissue: the normal-mode document it replaced. */
  supersededDocumentId?: string;
}

export class PipelineError extends Error {
  override name = 'PipelineError';
}

const DEFAULT_CONTINGENCY_SERIES = 900;

// ---------- helpers ----------

const clock = (deps: PipelineDeps) => (deps.now ?? (() => new Date()))();

async function lockSeries(tx: Queryable, tenantId: string, etdType: string, seriesNumber: number, purpose: 'normal' | 'contingency') {
  await tx.query(
    `insert into series (id, tenant_id, etd_type, series_number, purpose) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, etd_type, series_number) do nothing`,
    [randomUUID(), tenantId, etdType, seriesNumber, purpose],
  );
  const row = (
    await tx.query<{ id: string; next_serial: unknown; last_sequence_hash: string | null; purpose: string }>(
      `select id, next_serial, last_sequence_hash, purpose from series
       where tenant_id = $1 and etd_type = $2 and series_number = $3 for update`,
      [tenantId, etdType, seriesNumber],
    )
  ).rows[0];
  if (!row) throw new PipelineError('Series could not be created');
  if (row.purpose !== purpose) {
    throw new PipelineError(`Series ${seriesNumber} is reserved for ${row.purpose} documents`);
  }
  return row;
}

async function recordAttempts(db: Queryable, tenantId: string, target: { documentId: string } | { eventId: string }, attempts: AttemptLog[]) {
  const [column, id] = 'documentId' in target ? ['document_id', target.documentId] : ['event_id', target.eventId];
  const base = (await db.query<{ n: number }>(`select coalesce(max(attempt), 0)::int as n from submissions where ${column} = $1`, [id])).rows[0]!.n;
  for (const a of attempts) {
    await db.query(
      `insert into submissions (tenant_id, ${column}, attempt, action, at, http_status, result, raw_reply)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, id, base + a.attempt, a.action, a.at.toISOString(), a.httpStatus ?? null, a.result, a.rawBody ?? null],
    );
  }
}

interface ContingencyPeriod {
  id: string;
  reason: string;
  startedAt: Date;
}

async function openContingencyPeriod(db: Queryable, tenantId: string): Promise<ContingencyPeriod | undefined> {
  const row = (
    await db.query<{ id: string; reason: string; started_at: string | Date }>(
      `select id, reason, started_at from contingency_periods where tenant_id = $1 and ended_at is null`,
      [tenantId],
    )
  ).rows[0];
  return row && { id: row.id, reason: row.reason, startedAt: new Date(row.started_at) };
}

/** Open a contingency period for the tenant, or return the one already open. */
async function enterContingency(db: Queryable, tenantId: string, reason: string, at: Date): Promise<ContingencyPeriod> {
  await db.query(
    `insert into contingency_periods (id, tenant_id, reason, started_at) values ($1, $2, $3, $4)
     on conflict (tenant_id) where ended_at is null do nothing`,
    [randomUUID(), tenantId, reason.slice(0, 500), at.toISOString()],
  );
  const period = await openContingencyPeriod(db, tenantId);
  if (!period) throw new PipelineError('Could not open a contingency period');
  return period;
}

// ---------- phase 1 ----------

interface PreparedDocument {
  documentId: string;
  etdui: string;
  seriesId: string;
  seriesNumber: number;
  serial: number;
  signedXml: string;
  sequenceHash: string;
  previousSequenceHash: string | null;
  contingency: boolean;
}

type PrepareMode =
  | { kind: 'normal' }
  | { kind: 'contingency'; period: ContingencyPeriod; supersedes?: { documentId: string } };

async function prepare(
  deps: PipelineDeps,
  ctx: TenantContext,
  req: IssueRequest,
  mode: PrepareMode,
  inTransaction?: (tx: Queryable, doc: PreparedDocument) => Promise<void>,
): Promise<PreparedDocument> {
  const contingency = mode.kind === 'contingency';
  const seriesNumber = contingency ? (deps.contingency?.seriesNumber ?? DEFAULT_CONTINGENCY_SERIES) : (req.seriesNumber ?? 1);
  if (!contingency && seriesNumber === (deps.contingency?.seriesNumber ?? DEFAULT_CONTINGENCY_SERIES)) {
    throw new PipelineError(`Series ${seriesNumber} is reserved for contingency documents`);
  }
  // Validate amounts before taking the lock, so bad input never holds up the series.
  const totals = calculateDocument(
    {
      lines: req.lines,
      ...(req.prepaidAmount !== undefined && { prepaidAmount: req.prepaidAmount }),
      ...(req.payableRoundingAmount !== undefined && { payableRoundingAmount: req.payableRoundingAmount }),
    },
    deps.tax,
  );
  const operMode: OperMode = !contingency
    ? OPER_MODES.PREVIOUS_AUTHORIZATION
    : req.etdType === ETD_TYPES.TAX_RECEIPT
      ? OPER_MODES.SUBSEQUENT_AUTHORIZATION_TAX_RECEIPT
      : OPER_MODES.SUBSEQUENT_AUTHORIZATION;
  let contingencyInfo: Contingency | undefined;
  if (mode.kind === 'contingency') {
    const start = toBelizeDateTime(mode.period.startedAt);
    contingencyInfo = { reason: mode.period.reason, initDate: start.date, initTime: start.time };
  }

  return deps.db.transaction(async (tx) => {
    const series = await lockSeries(tx, ctx.tenantId, req.etdType, seriesNumber, contingency ? 'contingency' : 'normal');
    const serial = Number(series.next_serial);
    const issuedAt = clock(deps);
    const local = toBelizeDateTime(issuedAt);
    const etdui = buildEtdui({
      etdType: req.etdType,
      tin: ctx.supplier.tin,
      serial,
      series: seriesNumber,
      issueDate: local.date,
      issueTime: local.time,
      operMode,
      receptionEnv: RECEPTION_ENV[ctx.environment],
      securityCode: generateSecurityCode(),
    });
    const ubl = buildUblDocument(
      {
        etdType: req.etdType,
        etdui,
        issueDate: local.date,
        issueTime: local.time,
        supplier: ctx.supplier,
        ...(req.customer && { customer: req.customer }),
        totals,
        previousSequenceHash: series.last_sequence_hash,
        ...(req.reference && { reference: req.reference }),
        ...(contingencyInfo && { contingency: contingencyInfo }),
        ...(req.payment && { payment: req.payment }),
        ...(req.note && { note: req.note }),
      },
      deps.ubl,
    );
    const signed = signDocument(ubl.xml, ctx.credentials, { signingTime: issuedAt });
    const check = verifyDocumentSignature(signed.xml);
    if (!check.valid) throw new PipelineError(`Signature self-check failed: ${check.errors.join('; ')}`);

    const documentId = randomUUID();
    await tx.query(
      `insert into documents (id, tenant_id, series_id, etd_type, series_number, serial, etdui, issue_date, issue_time,
         oper_mode, reception_env, customer_id, customer_snapshot, referenced_etdui, line_count, line_extension_cents,
         gst_cents, tax_cents, tax_inclusive_cents, payable_cents, sequence_hash, previous_sequence_hash, signed_xml, status,
         contingency_period_id, supersedes_document_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
      [
        documentId, ctx.tenantId, series.id, req.etdType, seriesNumber, serial, etdui, local.date, local.time,
        operMode, RECEPTION_ENV[ctx.environment], req.customerId ?? null,
        req.customer ? JSON.stringify(req.customer) : null, req.reference?.etdui ?? null, totals.lineCount,
        totals.lineExtensionAmount, totals.gstAmount, totals.taxAmount, totals.taxInclusiveAmount, totals.payableAmount,
        ubl.sequenceInfoThisEtd, series.last_sequence_hash, signed.xml, contingency ? 'contingency_pending' : 'pending',
        mode.kind === 'contingency' ? mode.period.id : null,
        mode.kind === 'contingency' ? (mode.supersedes?.documentId ?? null) : null,
      ],
    );
    for (const line of totals.lines) {
      await tx.query(
        `insert into document_lines (document_id, tenant_id, line_number, description, quantity, unit_code, unit_price,
           net_cents, gst_category, gst_cents, tax_cents, line_total_cents)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [documentId, ctx.tenantId, line.lineNumber, line.description, line.quantity, line.unitCode, line.unitPrice,
          line.netAmount, line.gstCategory, line.gstAmount, line.taxAmount, line.lineTotal],
      );
    }
    await tx.query(`update series set next_serial = $1, last_sequence_hash = $2 where id = $3`, [serial + 1, ubl.sequenceInfoThisEtd, series.id]);

    const prepared: PreparedDocument = {
      documentId,
      etdui,
      seriesId: series.id,
      seriesNumber,
      serial,
      signedXml: signed.xml,
      sequenceHash: ubl.sequenceInfoThisEtd,
      previousSequenceHash: series.last_sequence_hash,
      contingency,
    };
    if (inTransaction) await inTransaction(tx, prepared);
    return prepared;
  });
}

/** The rejected or superseded serial will never be used: if nothing chained to it yet, point the series back (manual 4.3.4). */
async function unchain(db: Queryable, doc: { seriesId: string; sequenceHash: string; previousSequenceHash: string | null }) {
  await db.query(`update series set last_sequence_hash = $1 where id = $2 and last_sequence_hash = $3`, [doc.previousSequenceHash, doc.seriesId, doc.sequenceHash]);
}

// ---------- phase 2 ----------

async function settle(deps: PipelineDeps, ctx: TenantContext, doc: PreparedDocument, resuming = false): Promise<IssueResult> {
  const unsettled: DocumentStatus = doc.contingency ? 'contingency_pending' : 'pending';
  // When resuming, an earlier attempt may already have reached BTS: ask before sending again.
  const outcome = await deliver(deps.clients.get(ctx), doc.signedXml, { ...deps.delivery, ...(resuming && { queryFirst: true }) });
  await recordAttempts(deps.db, ctx.tenantId, { documentId: doc.documentId }, outcome.attempts);

  let status: DocumentStatus = unsettled;
  let protocolNumber: string | undefined;
  let conditions: Condition[] = [];
  let detail: Record<string, unknown>;
  switch (outcome.status) {
    case 'authorized':
    case 'authorized_with_alert':
      status = outcome.status;
      protocolNumber = outcome.protocolNumber;
      conditions = outcome.conditions;
      detail = { conditions, ...(outcome.recoveredBy && { recoveredBy: outcome.recoveredBy }) };
      break;
    case 'rejected':
      status = 'rejected';
      conditions = outcome.conditions;
      detail = { conditions };
      break;
    case 'certificate_problem':
      detail = { problem: 'certificate', httpStatus: outcome.response.httpStatus };
      break;
    case 'undetermined':
      detail = { problem: 'undetermined', reason: outcome.reason };
      break;
  }

  const settled = status !== unsettled;
  await deps.db.query(
    `update documents set status = $3, protocol_number = $4, status_detail = $5, settled_at = $6
     where id = $1 and tenant_id = $2 and status = $7`,
    [doc.documentId, ctx.tenantId, status, protocolNumber ?? null, JSON.stringify(detail), settled ? new Date().toISOString() : null, unsettled],
  );
  if (status === 'rejected') await unchain(deps.db, doc);

  return {
    documentId: doc.documentId,
    etdui: doc.etdui,
    seriesNumber: doc.seriesNumber,
    serial: doc.serial,
    status,
    delivery: outcome.status,
    ...(protocolNumber && { protocolNumber }),
    conditions,
    signedXml: doc.signedXml,
    contingency: doc.contingency,
  };
}

// ---------- issuing ----------

function contingencyReason(outcomeReason: string): string {
  return `BTS reception unreachable: ${outcomeReason}`.slice(0, 500);
}

/** Issue one document: number, build, sign, store, send, settle; reissue in contingency if BTS cannot be reached. */
export async function issueDocument(deps: PipelineDeps, tenantId: string, req: IssueRequest): Promise<IssueResult> {
  const ctx = await loadTenantContext(deps.db, deps.keys, tenantId);
  const contingencyEnabled = deps.contingency?.enabled ?? true;

  // During an open contingency period, new documents go straight to contingency.
  const open = contingencyEnabled ? await openContingencyPeriod(deps.db, tenantId) : undefined;
  if (open) {
    const doc = await prepare(deps, ctx, req, { kind: 'contingency', period: open });
    return queuedResult(doc);
  }

  const original = await prepare(deps, ctx, req, { kind: 'normal' });
  const result = await settle(deps, ctx, original);
  if (result.delivery !== 'undetermined' || !contingencyEnabled) return result;

  // Manual 3.3.6.4: no reply, so reissue the same sale with a new series and serial under
  // subsequent authorization, and never send the original again.
  const lastReason = (await deps.db.query<{ status_detail: { reason?: string } }>('select status_detail from documents where id = $1', [original.documentId]))
    .rows[0]?.status_detail?.reason ?? 'no reply';
  const period = await enterContingency(deps.db, tenantId, contingencyReason(lastReason), clock(deps));
  const reissued = await prepare(deps, ctx, req, { kind: 'contingency', period, supersedes: { documentId: original.documentId } }, async (tx, doc) => {
    const updated = await tx.query<{ id: string }>(
      `update documents set status = 'superseded', status_detail = $3
       where id = $1 and tenant_id = $2 and status = 'pending' returning id`,
      [original.documentId, tenantId, JSON.stringify({ problem: 'undetermined', reason: lastReason, supersededBy: doc.documentId, supersededByEtdui: doc.etdui })],
    );
    if (updated.rows.length !== 1) throw new PipelineError('The original document was settled meanwhile; not reissuing');
    await unchain(tx, original);
  });
  return { ...queuedResult(reissued), supersededDocumentId: original.documentId };
}

function queuedResult(doc: PreparedDocument): IssueResult {
  return {
    documentId: doc.documentId,
    etdui: doc.etdui,
    seriesNumber: doc.seriesNumber,
    serial: doc.serial,
    status: 'contingency_pending',
    delivery: 'not_sent',
    conditions: [],
    signedXml: doc.signedXml,
    contingency: true,
  };
}

interface StoredDocumentRow {
  id: string;
  etdui: string;
  series_id: string;
  series_number: number;
  serial: unknown;
  signed_xml: string;
  sequence_hash: string;
  previous_sequence_hash: string | null;
  status: DocumentStatus;
  status_detail: Record<string, unknown> | null;
}

const toPrepared = (r: StoredDocumentRow): PreparedDocument => ({
  documentId: r.id,
  etdui: r.etdui,
  seriesId: r.series_id,
  seriesNumber: r.series_number,
  serial: Number(r.serial),
  signedXml: r.signed_xml,
  sequenceHash: r.sequence_hash,
  previousSequenceHash: r.previous_sequence_hash,
  contingency: r.status === 'contingency_pending',
});

const STORED_COLUMNS = 'id, etdui, series_id, series_number, serial, signed_xml, sequence_hash, previous_sequence_hash, status, status_detail';

/**
 * Finish normal-mode documents left pending (a crash during phase 2, a
 * certificate problem since fixed). Contingency documents are sent by
 * catchUpContingency instead.
 *
 * Run it from one scheduled worker per tenant; overlapping runs are safe
 * (BTS answers a duplicate with 255, which resolves through Document Query)
 * but wasteful.
 */
export async function resumePending(
  deps: PipelineDeps,
  tenantId: string,
  options: { olderThanMs?: number; limit?: number } = {},
): Promise<IssueResult[]> {
  const cutoff = new Date(clock(deps).getTime() - (options.olderThanMs ?? 120_000));
  const rows = (
    await deps.db.query<StoredDocumentRow>(
      `select ${STORED_COLUMNS} from documents where tenant_id = $1 and status = 'pending' and created_at <= $2
       order by created_at, serial limit $3`,
      [tenantId, cutoff.toISOString(), options.limit ?? 100],
    )
  ).rows;
  if (rows.length === 0) return [];
  const ctx = await loadTenantContext(deps.db, deps.keys, tenantId);
  const results: IssueResult[] = [];
  for (const r of rows) results.push(await settle(deps, ctx, toPrepared(r), true));
  return results;
}

// ---------- contingency catch-up ----------

export interface CatchUpResult {
  delivered: IssueResult[];
  /** Contingency documents still waiting to be sent. */
  remaining: number;
  /** The contingency period was closed in this run (BTS answered again). */
  periodClosed: boolean;
  reconciled: ReconcileResult[];
}

/**
 * Send documents issued in contingency, oldest first (manual 3.3.6.4). The
 * first successful delivery shows BTS is back and closes the contingency
 * period, so new documents return to normal mode. Stops at the first delivery
 * that is still undetermined. Then checks superseded originals.
 */
export async function catchUpContingency(deps: PipelineDeps, tenantId: string, options: { limit?: number } = {}): Promise<CatchUpResult> {
  const rows = (
    await deps.db.query<StoredDocumentRow>(
      `select ${STORED_COLUMNS} from documents where tenant_id = $1 and status = 'contingency_pending'
       order by created_at, serial limit $2`,
      [tenantId, options.limit ?? 500],
    )
  ).rows;
  const ctx = await loadTenantContext(deps.db, deps.keys, tenantId);
  const delivered: IssueResult[] = [];
  let periodClosed = false;
  let btsAnswered = rows.length === 0;

  for (const r of rows) {
    const result = await settle(deps, ctx, toPrepared(r), true);
    if (result.delivery === 'undetermined' || result.delivery === 'certificate_problem') break;
    delivered.push(result);
    btsAnswered = true;
    if (!periodClosed) periodClosed = await closeContingency(deps, tenantId);
  }
  if (btsAnswered && !periodClosed) periodClosed = await closeContingency(deps, tenantId);

  const remaining = (
    await deps.db.query<{ n: number }>(`select count(*)::int as n from documents where tenant_id = $1 and status = 'contingency_pending'`, [tenantId])
  ).rows[0]!.n;
  const reconciled = btsAnswered ? await reconcileSuperseded(deps, tenantId) : [];
  return { delivered, remaining, periodClosed, reconciled };
}

async function closeContingency(deps: PipelineDeps, tenantId: string): Promise<boolean> {
  const closed = await deps.db.query<{ id: string }>(
    `update contingency_periods set ended_at = $2 where tenant_id = $1 and ended_at is null returning id`,
    [tenantId, clock(deps).toISOString()],
  );
  return closed.rows.length > 0;
}

export interface ReconcileResult {
  documentId: string;
  etdui: string;
  /** not_found: BTS never received it (nothing to do); cancelled: BTS had authorized it, now cancelled; unresolved: try again later. */
  resolution: 'not_found' | 'cancelled' | 'cancel_pending' | 'unresolved';
}

/**
 * Check every superseded original with Document Query. If BTS authorized it
 * after all, the sale now has two authorized documents, so the original is
 * cancelled with event 050 (manual 3.3.6.4).
 */
export async function reconcileSuperseded(deps: PipelineDeps, tenantId: string): Promise<ReconcileResult[]> {
  const rows = (
    await deps.db.query<StoredDocumentRow>(
      `select ${STORED_COLUMNS} from documents where tenant_id = $1 and status = 'superseded'
       and coalesce(status_detail->>'resolution', '') = '' order by created_at`,
      [tenantId],
    )
  ).rows;
  if (rows.length === 0) return [];
  const ctx = await loadTenantContext(deps.db, deps.keys, tenantId);
  const client = deps.clients.get(ctx);
  const results: ReconcileResult[] = [];
  for (const r of rows) {
    let found: string;
    try {
      found = (await client.queryDocument(r.etdui)).status;
    } catch {
      results.push({ documentId: r.id, etdui: r.etdui, resolution: 'unresolved' });
      continue;
    }
    if (found === 'not_found') {
      await mergeDetail(deps.db, tenantId, r.id, { resolution: 'not_found', checkedAt: clock(deps).toISOString() });
      results.push({ documentId: r.id, etdui: r.etdui, resolution: 'not_found' });
    } else if (found === 'authorized' || found === 'authorized_with_alert') {
      const by = (r.status_detail?.supersededByEtdui as string | undefined) ?? 'a contingency document';
      const cancel = await cancelDocument(deps, tenantId, r.id, `Superseded by contingency document ${by} (BTS manual 3.3.6.4)`);
      results.push({ documentId: r.id, etdui: r.etdui, resolution: cancel.status === 'registered' ? 'cancelled' : 'cancel_pending' });
    } else if (found === 'cancelled') {
      await deps.db.query(`update documents set status = 'cancelled', settled_at = $3 where id = $1 and tenant_id = $2`, [r.id, tenantId, clock(deps).toISOString()]);
      results.push({ documentId: r.id, etdui: r.etdui, resolution: 'cancelled' });
    } else {
      results.push({ documentId: r.id, etdui: r.etdui, resolution: 'unresolved' });
    }
  }
  return results;
}

async function mergeDetail(db: Queryable, tenantId: string, documentId: string, extra: Record<string, unknown>) {
  await db.query(`update documents set status_detail = coalesce(status_detail, '{}'::jsonb) || $3::jsonb where id = $1 and tenant_id = $2`, [
    documentId,
    tenantId,
    JSON.stringify(extra),
  ]);
}

// ---------- cancellation (event 050) ----------

export interface CancelResult {
  eventId: string;
  eventEtdui: string;
  /** registered: BTS accepted the cancellation; rejected: BTS refused it; pending: BTS could not be reached, retry later. */
  status: 'registered' | 'rejected' | 'pending';
  documentStatus: DocumentStatus;
  conditions: Condition[];
  protocolNumber?: string;
}

/**
 * Cancel an authorized (or superseded) document by registering event 050 with BTS.
 * Events are previous-authorization only, so this is refused while the tenant is in contingency.
 */
export async function cancelDocument(deps: PipelineDeps, tenantId: string, documentId: string, reason: string): Promise<CancelResult> {
  if (!reason?.trim()) throw new PipelineError('A cancellation needs a reason');
  const ctx = await loadTenantContext(deps.db, deps.keys, tenantId);
  const doc = (
    await deps.db.query<{ id: string; etdui: string; status: DocumentStatus }>(`select id, etdui, status from documents where id = $1 and tenant_id = $2`, [
      documentId,
      tenantId,
    ])
  ).rows[0];
  if (!doc) throw new PipelineError('Unknown document');
  if (!['authorized', 'authorized_with_alert', 'superseded'].includes(doc.status)) {
    throw new PipelineError(`Only an authorized document can be cancelled; this one is ${doc.status}`);
  }
  if (await openContingencyPeriod(deps.db, tenantId)) {
    throw new PipelineError('Events cannot be registered while in contingency; try again when BTS is back');
  }

  // Resume an earlier cancellation attempt rather than registering a second event.
  const existing = (
    await deps.db.query<{ id: string; etdui: string; status: string; signed_xml: string }>(
      `select id, etdui, status, signed_xml from events where document_id = $1 and tenant_id = $2 and status <> 'rejected' order by created_at desc limit 1`,
      [documentId, tenantId],
    )
  ).rows[0];
  if (existing?.status === 'registered') {
    return { eventId: existing.id, eventEtdui: existing.etdui, status: 'registered', documentStatus: 'cancelled', conditions: [] };
  }
  const event =
    existing ??
    (await deps.db.transaction(async (tx) => {
      const series = await lockSeries(tx, tenantId, ETD_TYPES.EVENT, CANCELLATION_SERIES, 'normal');
      const serial = Number(series.next_serial);
      const at = clock(deps);
      const local = toBelizeDateTime(at);
      const eventEtdui = buildEtdui({
        etdType: ETD_TYPES.EVENT,
        tin: ctx.supplier.tin,
        serial,
        series: CANCELLATION_SERIES,
        issueDate: local.date,
        issueTime: local.time,
        operMode: OPER_MODES.PREVIOUS_AUTHORIZATION,
        receptionEnv: RECEPTION_ENV[ctx.environment],
        securityCode: generateSecurityCode(),
      });
      const xml = buildCancellationEvent({ eventEtdui, issueDate: local.date, issueTime: local.time, issuer: ctx.supplier, cancelledEtdui: doc.etdui, reason }).xml;
      const signed = signDocument(xml, ctx.credentials, { signingTime: at }).xml;
      const id = randomUUID();
      await tx.query(
        `insert into events (id, tenant_id, series_id, event_code, serial, etdui, document_id, referenced_etdui, reason, signed_xml, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
        [id, tenantId, series.id, EVENT_CODES.ISSUER_CANCELLATION, serial, eventEtdui, documentId, doc.etdui, reason, signed],
      );
      await tx.query(`update series set next_serial = $1 where id = $2`, [serial + 1, series.id]);
      return { id, etdui: eventEtdui, status: 'pending', signed_xml: signed };
    }));

  const outcome = await deliver(deps.clients.get(ctx), event.signed_xml, { ...deps.delivery, ...(existing && { queryFirst: true }) });
  await recordAttempts(deps.db, tenantId, { eventId: event.id }, outcome.attempts);

  let status: CancelResult['status'] = 'pending';
  let conditions: Condition[] = [];
  let protocolNumber: string | undefined;
  let documentStatus = doc.status;
  if (outcome.status === 'authorized' || outcome.status === 'authorized_with_alert') {
    status = 'registered';
    conditions = outcome.conditions;
    protocolNumber = outcome.protocolNumber;
    await deps.db.query(`update events set status = 'registered', protocol_number = $3, status_detail = $4, settled_at = $5 where id = $1 and tenant_id = $2`, [
      event.id, tenantId, protocolNumber ?? null, JSON.stringify({ conditions }), new Date().toISOString(),
    ]);
    await deps.db.query(`update documents set status = 'cancelled', settled_at = $3 where id = $1 and tenant_id = $2 and status = $4`, [
      documentId, tenantId, new Date().toISOString(), doc.status,
    ]);
    if (doc.status === 'superseded') await mergeDetail(deps.db, tenantId, documentId, { resolution: 'cancelled', cancelledBy: event.etdui });
    documentStatus = 'cancelled';
  } else if (outcome.status === 'rejected') {
    status = 'rejected';
    conditions = outcome.conditions;
    await deps.db.query(`update events set status = 'rejected', status_detail = $3, settled_at = $4 where id = $1 and tenant_id = $2`, [
      event.id, tenantId, JSON.stringify({ conditions }), new Date().toISOString(),
    ]);
  } else {
    await deps.db.query(`update events set status_detail = $3 where id = $1 and tenant_id = $2`, [
      event.id, tenantId, JSON.stringify({ problem: outcome.status, ...(outcome.status === 'undetermined' && { reason: outcome.reason }) }),
    ]);
  }
  return { eventId: event.id, eventEtdui: event.etdui, status, documentStatus, conditions, ...(protocolNumber && { protocolNumber }) };
}
