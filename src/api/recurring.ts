/**
 * Recurring invoices: the same tax invoice issued on a schedule (a monthly
 * retainer, rent, a service plan), emailed to the customer with a pay link,
 * and followed up like any other invoice (balances, reminders).
 *
 *   GET  /v1/recurring               list
 *   POST /v1/recurring               { name, document, frequency, intervalCount, startDate, endDate?, count?, dueDays, autoSend }
 *   GET  /v1/recurring/:id           with the invoices it issued
 *   PUT  /v1/recurring/:id           change it (nextDate instead of startDate)
 *   POST /v1/recurring/:id/pause | resume | end
 *   POST /v1/recurring/:id/run       issue the next one now
 *
 * Housekeeping issues what is due (runRecurring). Each scheduled date is
 * claimed in recurring_runs first, so two processes never issue it twice; a
 * failure (BTS rejected it, the plan's limit, no certificate) is retried an
 * hour later and shown on the schedule.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { type IssueBody, issueFromBody } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { addDays, prepareTemplate, templateDocumentSchema } from './quotes.ts';
import { emailInvoice } from './receivables.ts';
import { date as dateSchema, uuid } from './schemas.ts';

export type Frequency = 'weekly' | 'monthly' | 'yearly';
const VALID_DOCUMENT = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
const PRINTABLE = ['authorized', 'authorized_with_alert', 'contingency_pending'];
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
type Extras = { ekyash?: { sandboxUrl?: string; liveUrl?: string } };

/** The date after `from` on a schedule. Months keep to the anchor day (the 31st becomes the month's last day). */
export function nextOccurrence(from: string, frequency: Frequency, interval: number, anchorDay: number): string {
  if (frequency === 'weekly') return addDays(from, 7 * interval);
  const [y, m] = from.split('-').map(Number) as [number, number];
  const months = frequency === 'monthly' ? interval : 12 * interval;
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}

interface RecurringRow {
  id: string;
  tenant_id: string;
  name: string;
  body: IssueBody;
  customer_id: string | null;
  customer_snapshot: { name: string | null; tin: string | null; email: string | null } | null;
  total_cents: unknown;
  frequency: Frequency;
  interval_count: number;
  anchor_day: number;
  next_date: string;
  end_date: string | null;
  remaining: number | null;
  due_days: number;
  auto_send: boolean;
  status: 'active' | 'paused' | 'finished';
  last_document_id: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = 'r.*, r.next_date::text as next_date, r.end_date::text as end_date';

export function recurringJson(r: RecurringRow) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    customer: { id: r.customer_id, name: r.customer_snapshot?.name ?? null, tin: r.customer_snapshot?.tin ?? null, email: r.customer_snapshot?.email ?? null },
    total: formatCents(toBigInt(r.total_cents)),
    frequency: r.frequency,
    intervalCount: r.interval_count,
    nextDate: r.status === 'finished' ? null : r.next_date,
    endDate: r.end_date,
    remaining: r.remaining,
    dueDays: r.due_days,
    autoSend: r.auto_send,
    lastDocumentId: r.last_document_id,
    lastError: r.last_error,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

async function loadRecurring(db: Queryable, tenantId: string, id: string): Promise<RecurringRow> {
  const r = (await db.query<RecurringRow>(`select ${COLUMNS} from recurring_invoices r where r.id = $1 and r.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!r) throw notFound('Recurring invoice');
  return r;
}

/** The schedule after one more invoice: the next date, what is left, finished or not. */
function advance(r: RecurringRow, from: string): { next: string; remaining: number | null; finished: boolean } {
  const next = nextOccurrence(from, r.frequency, r.interval_count, r.anchor_day);
  const remaining = r.remaining === null ? null : Math.max(0, r.remaining - 1);
  return { next, remaining, finished: remaining === 0 || Boolean(r.end_date && next > r.end_date) };
}

/**
 * Issue one scheduled invoice (claimed first, so it happens once per date).
 * Returns what happened, or null when another process has it.
 */
async function runOne(deps: PipelineDeps, ctx: ServerContext, r: RecurringRow, runDate: string, extras: Extras): Promise<{ status: 'issued' | 'failed'; documentId: string | null; error: string | null } | null> {
  const { db } = deps;
  const claimed = await db.query(
    `insert into recurring_runs (recurring_id, run_date, status) values ($1, $2, 'claimed')
     on conflict (recurring_id, run_date) do update set status = 'claimed', error = null, created_at = now()
       where recurring_runs.status = 'failed' and recurring_runs.created_at < now() - interval '1 hour'
     returning run_date`,
    [r.id, runDate],
  );
  if (!claimed.rows.length) return null;
  const today = belizeToday();
  const body: IssueBody = {
    ...r.body,
    type: '01',
    // A due date needs a payment means: bank transfer unless the template says otherwise.
    payment: { meansCode: '30', ...r.body.payment, dueDate: addDays(today, r.due_days), terms: r.body.payment?.terms ?? (r.due_days ? `Net ${r.due_days}` : 'Due on receipt') },
  };
  let documentId: string | null = null;
  try {
    const result = await issueFromBody(deps, r.tenant_id, body, null);
    documentId = result.documentId;
    if (!VALID_DOCUMENT.includes(result.status)) {
      const why = result.conditions.map((c) => c.description).filter(Boolean).join('; ');
      throw new Error(`BTS rejected the invoice${why ? `: ${why}` : ''}`);
    }
    const next = advance(r, runDate);
    await db.query("update recurring_runs set status = 'issued', document_id = $3 where recurring_id = $1 and run_date = $2", [r.id, runDate, documentId]);
    await db.query(
      `update recurring_invoices set last_document_id = $2, last_error = null, next_date = $3, remaining = $4, status = case when $5 then 'finished' else status end, updated_at = now() where id = $1`,
      [r.id, documentId, next.next, next.remaining, next.finished],
    );
    if (r.auto_send && PRINTABLE.includes(result.status)) await sendIssued(deps, ctx, r, runDate, documentId, extras);
    return { status: 'issued', documentId, error: null };
  } catch (e) {
    const error = (e instanceof ApiError || e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query("update recurring_runs set status = 'failed', document_id = $3, error = $4 where recurring_id = $1 and run_date = $2", [r.id, runDate, documentId, error]);
    await db.query('update recurring_invoices set last_error = $2, updated_at = now() where id = $1', [r.id, error]);
    return { status: 'failed', documentId, error };
  }
}

/** Email an issued invoice to the customer, once. */
async function sendIssued(deps: PipelineDeps, ctx: ServerContext, r: RecurringRow, runDate: string, documentId: string, extras: Extras) {
  const to = r.customer_snapshot?.email;
  if (!to || !ctx.mailConfigured) return;
  const claimed = await deps.db.query('update recurring_runs set emailed_at = now() where recurring_id = $1 and run_date = $2 and emailed_at is null returning run_date', [r.id, runDate]);
  if (!claimed.rows.length) return;
  try {
    await emailInvoice(deps, ctx, r.tenant_id, documentId, to, extras);
  } catch {
    await deps.db.query('update recurring_runs set emailed_at = null where recurring_id = $1 and run_date = $2', [r.id, runDate]);
  }
}

/** Housekeeping: issue every scheduled invoice that is due, and email the ones BTS has since authorized. */
export async function runRecurring(deps: PipelineDeps, ctx: ServerContext, extras: Extras = {}): Promise<{ issued: number; failed: number }> {
  const { db } = deps;
  const result = { issued: 0, failed: 0 };
  const due = (await db.query<RecurringRow>(
    `select ${COLUMNS} from recurring_invoices r where r.status = 'active' and r.next_date <= $1 order by r.next_date limit 100`, [belizeToday()],
  )).rows;
  for (const r of due) {
    const outcome = await runOne(deps, ctx, r, r.next_date, extras);
    if (outcome) result[outcome.status]++;
  }
  // Issued while BTS was slow to answer: email them once they can be printed.
  const waiting = (await db.query<RecurringRow & { run_date: string; document_id: string }>(
    `select ${COLUMNS}, x.run_date::text as run_date, x.document_id from recurring_runs x join recurring_invoices r on r.id = x.recurring_id
     join documents d on d.id = x.document_id
     where x.status = 'issued' and x.emailed_at is null and r.auto_send and d.status = any($1::text[]) and x.created_at > now() - interval '3 days' limit 50`,
    [PRINTABLE],
  )).rows;
  for (const w of waiting) await sendIssued(deps, ctx, w, w.run_date, w.document_id, extras);
  return result;
}

export function registerRecurringRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, extras: Extras = {}) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const schedule = {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    document: templateDocumentSchema,
    frequency: { type: 'string', enum: ['weekly', 'monthly', 'yearly'] },
    intervalCount: { type: 'integer', minimum: 1, maximum: 12 },
    endDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    count: { type: ['integer', 'null'], minimum: 1, maximum: 999 },
    dueDays: { type: 'integer', minimum: 0, maximum: 365 },
    autoSend: { type: 'boolean' },
  } as const;
  type ScheduleBody = { name: string; document: IssueBody; frequency: Frequency; intervalCount?: number; endDate?: string | null; count?: number | null; dueDays?: number; autoSend?: boolean };

  app.get('/recurring', async (request) => {
    requirePermission(request, 'documents.issue');
    const rows = (await db.query<RecurringRow>(`select ${COLUMNS} from recurring_invoices r where r.tenant_id = $1 order by (r.status = 'finished'), r.next_date, r.created_at desc limit 500`, [request.tenantId])).rows;
    return { data: rows.map(recurringJson) };
  });

  app.post<{ Body: ScheduleBody & { startDate: string } }>(
    '/recurring',
    { schema: { body: { type: 'object', required: ['name', 'document', 'frequency', 'startDate'], additionalProperties: false, properties: { ...schedule, startDate: dateSchema } } } },
    async (request, reply) => {
      requirePermission(request, 'documents.issue');
      const b = request.body;
      if (b.startDate < belizeToday()) throw new ApiError(422, 'invalid_schedule', 'Start today or later');
      if (b.endDate && b.endDate < b.startDate) throw new ApiError(422, 'invalid_schedule', 'The end date is before the start');
      const { body, totals, customer } = await prepareTemplate(deps, request.tenantId, b.document, ['01']);
      const id = randomUUID();
      await db.query(
        `insert into recurring_invoices (id, tenant_id, name, body, customer_id, customer_snapshot, total_cents, frequency, interval_count, anchor_day, next_date, end_date, remaining, due_days, auto_send, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [id, request.tenantId, b.name.trim(), JSON.stringify(body), body.customerId ?? null, JSON.stringify(customer), String(totals.total), b.frequency, b.intervalCount ?? 1,
          Number(b.startDate.slice(8, 10)), b.startDate, b.endDate ?? null, b.count ?? null, b.dueDays ?? 30, b.autoSend ?? true, request.userId || null],
      );
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'recurring.created', target: b.name.trim(), ip: request.ip });
      return reply.code(201).send(recurringJson(await loadRecurring(db, request.tenantId, id)));
    },
  );

  app.get<{ Params: { id: string } }>('/recurring/:id', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const r = await loadRecurring(db, request.tenantId, request.params.id);
    const runs = (await db.query<{ run_date: string; status: string; error: string | null; document_id: string | null; emailed_at: Date | string | null; series_number: number | null; serial: string | null; doc_status: string | null }>(
      `select x.run_date::text as run_date, x.status, x.error, x.document_id, x.emailed_at, d.series_number, d.serial::text as serial, d.status as doc_status
       from recurring_runs x left join documents d on d.id = x.document_id where x.recurring_id = $1 order by x.run_date desc limit 36`,
      [r.id],
    )).rows;
    // The next few dates, so the schedule can be checked at a glance.
    const upcoming: string[] = [];
    if (r.status !== 'finished') {
      let d = r.next_date;
      let left = r.remaining;
      for (let i = 0; i < 4 && (left === null || left > 0) && (!r.end_date || d <= r.end_date); i++) {
        upcoming.push(d);
        d = nextOccurrence(d, r.frequency, r.interval_count, r.anchor_day);
        if (left !== null) left--;
      }
    }
    return {
      ...recurringJson(r),
      document: r.body,
      upcoming,
      runs: runs.map((x) => ({
        date: x.run_date, status: x.status, error: x.error, documentId: x.document_id, emailed: Boolean(x.emailed_at), documentStatus: x.doc_status,
        number: x.series_number !== null && x.serial !== null ? `${String(x.series_number).padStart(3, '0')}-${x.serial.padStart(9, '0')}` : null,
      })),
    };
  });

  app.put<{ Params: { id: string }; Body: ScheduleBody & { nextDate: string } }>(
    '/recurring/:id',
    { schema: { params: idParams, body: { type: 'object', required: ['name', 'document', 'frequency', 'nextDate'], additionalProperties: false, properties: { ...schedule, nextDate: dateSchema } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const before = await loadRecurring(db, request.tenantId, request.params.id);
      if (before.status === 'finished') throw new ApiError(409, 'finished', 'This schedule has ended; create a new one');
      const b = request.body;
      if (b.nextDate < belizeToday()) throw new ApiError(422, 'invalid_schedule', 'The next invoice must be today or later');
      if (b.endDate && b.endDate < b.nextDate) throw new ApiError(422, 'invalid_schedule', 'The end date is before the next invoice');
      const { body, totals, customer } = await prepareTemplate(deps, request.tenantId, b.document, ['01']);
      await db.query(
        `update recurring_invoices set name = $3, body = $4, customer_id = $5, customer_snapshot = $6, total_cents = $7, frequency = $8, interval_count = $9,
           anchor_day = case when next_date::text = $10 then anchor_day else $11 end, next_date = $10, end_date = $12, remaining = $13, due_days = $14, auto_send = $15, last_error = null, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [before.id, request.tenantId, b.name.trim(), JSON.stringify(body), body.customerId ?? null, JSON.stringify(customer), String(totals.total), b.frequency, b.intervalCount ?? 1,
          b.nextDate, Number(b.nextDate.slice(8, 10)), b.endDate ?? null, b.count ?? null, b.dueDays ?? 30, b.autoSend ?? true],
      );
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'recurring.changed', target: b.name.trim(), ip: request.ip });
      return recurringJson(await loadRecurring(db, request.tenantId, before.id));
    },
  );

  app.post<{ Params: { id: string; action: 'pause' | 'resume' | 'end' } }>(
    '/recurring/:id/:action',
    { schema: { params: { type: 'object', required: ['id', 'action'], properties: { id: uuid, action: { type: 'string', enum: ['pause', 'resume', 'end'] } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const r = await loadRecurring(db, request.tenantId, request.params.id);
      const action = request.params.action;
      if (r.status === 'finished') throw new ApiError(409, 'finished', 'This schedule has already ended');
      if (action === 'pause') await db.query("update recurring_invoices set status = 'paused', updated_at = now() where id = $1", [r.id]);
      if (action === 'end') await db.query("update recurring_invoices set status = 'finished', updated_at = now() where id = $1", [r.id]);
      if (action === 'resume') {
        // Dates missed while paused are skipped: the next one is today or later.
        let next = r.next_date;
        const today = belizeToday();
        while (next < today) next = nextOccurrence(next, r.frequency, r.interval_count, r.anchor_day);
        const finished = Boolean(r.end_date && next > r.end_date);
        await db.query(`update recurring_invoices set status = $2, next_date = $3, updated_at = now() where id = $1`, [r.id, finished ? 'finished' : 'active', next]);
      }
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `recurring.${action === 'end' ? 'ended' : action === 'pause' ? 'paused' : 'resumed'}`, target: r.name, ip: request.ip });
      return recurringJson(await loadRecurring(db, request.tenantId, r.id));
    },
  );

  // Issue the next one now (it moves the schedule on, as if its date had come).
  app.post<{ Params: { id: string } }>('/recurring/:id/run', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const r = await loadRecurring(db, request.tenantId, request.params.id);
    if (r.status !== 'active') throw new ApiError(409, 'not_active', 'Resume this schedule first');
    const outcome = await runOne(deps, ctx, r, r.next_date, extras);
    if (!outcome) throw new ApiError(409, 'in_progress', 'This invoice is already being issued, or failed less than an hour ago');
    if (outcome.status === 'failed') throw new ApiError(422, 'not_issued', outcome.error ?? 'The invoice was not issued');
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'recurring.run_now', target: r.name, ip: request.ip });
    return { ...recurringJson(await loadRecurring(db, request.tenantId, r.id)), documentId: outcome.documentId };
  });
}
