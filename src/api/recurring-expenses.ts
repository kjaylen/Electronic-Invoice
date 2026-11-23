/**
 * Repeating expenses: rent, internet, a phone plan… recorded on their own on schedule, as a bill
 * to pay (due that day, or some days later) or as already paid (a standing order).
 *
 *   GET    /v1/recurring-expenses
 *   POST   /v1/recurring-expenses        { supplierId? | supplierName, category, description?, gstTreatment, total,
 *                                          frequency: weekly | monthly | yearly, startDate, endDate?, dueDays?, paidBy? }
 *   PUT    /v1/recurring-expenses/:id    the same, plus active
 *   DELETE /v1/recurring-expenses/:id
 *
 * Housekeeping records what is due (runRecurringExpenses), each date once, catching up missed ones.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Database, Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { gstInside, type GstTreatment } from './expenses.ts';
import { can, requirePermission } from './permissions.ts';
import { addDays } from './quotes.ts';
import { type Frequency, nextOccurrence } from './recurring.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'] as const;

interface Row {
  id: string;
  tenant_id: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_tin: string | null;
  category: string;
  description: string | null;
  gst_treatment: GstTreatment;
  total_cents: unknown;
  frequency: Frequency;
  anchor_day: number;
  next_date: string;
  end_date: string | null;
  due_days: number;
  paid_by: string | null;
  active: boolean;
  last_run: string | null;
}
const COLUMNS = `id, tenant_id, supplier_id, supplier_name, supplier_tin, category, description, gst_treatment, total_cents, frequency, anchor_day,
  next_date::text as next_date, end_date::text as end_date, due_days, paid_by, active, last_run::text as last_run`;

const json = (r: Row) => ({
  id: r.id, supplier: { id: r.supplier_id, name: r.supplier_name, tin: r.supplier_tin }, category: r.category, description: r.description,
  gstTreatment: r.gst_treatment, total: formatCents(toBigInt(r.total_cents)), frequency: r.frequency, nextDate: r.next_date, endDate: r.end_date,
  dueDays: r.due_days, paidBy: r.paid_by, active: r.active, lastRun: r.last_run,
  // Finished: past its end date.
  finished: Boolean(r.end_date && r.next_date > r.end_date),
});

type Body = {
  supplierId?: string; supplierName?: string; category: string; description?: string | null; gstTreatment: GstTreatment; total: string;
  frequency: Frequency; startDate: string; endDate?: string | null; dueDays?: number; paidBy?: (typeof METHODS)[number] | null; active?: boolean;
};
const bodySchema = {
  type: 'object', required: ['category', 'gstTreatment', 'total', 'frequency', 'startDate'], additionalProperties: false,
  properties: {
    supplierId: uuid,
    supplierName: { type: 'string', minLength: 1, maxLength: 200 },
    category: { type: 'string', minLength: 1, maxLength: 60 },
    description: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
    gstTreatment: { type: 'string', enum: ['standard', 'zero', 'exempt', 'none'] },
    total: { type: 'string', pattern: '^\\d{1,10}(\\.\\d{1,2})?$' },
    frequency: { type: 'string', enum: ['weekly', 'monthly', 'yearly'] },
    startDate: dateSchema,
    endDate: { anyOf: [dateSchema, { type: 'null' }] },
    dueDays: { type: 'integer', minimum: 0, maximum: 90 },
    paidBy: { anyOf: [{ type: 'string', enum: METHODS }, { type: 'null' }] },
    active: { type: 'boolean' },
  },
} as const;

/** Records each repeating expense that has come due (catching up any missed dates). */
export async function runRecurringExpenses(db: Queryable | Database, options: { today?: string; limit?: number; tenantId?: string } = {}): Promise<{ recorded: number }> {
  const today = options.today ?? belizeToday();
  let recorded = 0;
  const due = (await db.query<Row>(
    `select ${COLUMNS} from recurring_expenses where active and next_date <= $1::date and (end_date is null or next_date <= end_date)
       and ($3::uuid is null or tenant_id = $3) order by next_date limit $2`,
    [today, options.limit ?? 500, options.tenantId ?? null],
  )).rows;
  // Each schedule's expenses and its new date together, when the connection can (housekeeping may pass a plain one).
  const inTx = (fn: (tx: Queryable) => Promise<void>) => ('transaction' in db ? db.transaction(fn) : fn(db));
  for (const r of due) {
    await inTx(async (tx) => {
      // Claimed by moving its date on; another process that got here first leaves nothing to do.
      let date = r.next_date;
      // At most a year of weeks at once (a start date long ago catches up over a few runs).
      for (let n = 0; n < 53 && date <= today && (!r.end_date || date <= r.end_date); n++) {
        const next = nextOccurrence(date, r.frequency, 1, r.anchor_day);
        const moved = await tx.query('update recurring_expenses set next_date = $3, last_run = $2 where id = $1 and next_date = $2 returning id', [r.id, date, next]);
        if (!moved.rows.length) return;
        const total = toBigInt(r.total_cents);
        const gst = r.gst_treatment === 'standard' ? gstInside(total) : 0n;
        await tx.query(
          `insert into expenses (id, tenant_id, supplier_id, supplier_name, supplier_tin, reference, expense_date, due_date, category, description, gst_treatment, net_cents, gst_cents, total_cents, claim_gst, paid_on, payment_method, recurring_expense_id)
           values ($1, $2, $3, $4, $5, null, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, $15, $16)`,
          [randomUUID(), r.tenant_id, r.supplier_id, r.supplier_name, r.supplier_tin, date, r.paid_by ? null : addDays(date, r.due_days), r.category, r.description,
            r.gst_treatment, String(total - gst), String(gst), String(total), r.paid_by ? date : null, r.paid_by, r.id],
        );
        recorded++;
        date = next;
      }
    });
  }
  return { recorded };
}

export function registerRecurringExpenseRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'expenses.manage')) requirePermission(request, 'reports.view');
  };
  const prepare = async (tenantId: string, b: Body) => {
    let name = b.supplierName?.trim() ?? '';
    let tin: string | null = null;
    if (b.supplierId) {
      const s = (await db.query<{ name: string; tin: string | null }>('select name, tin from suppliers where id = $1 and tenant_id = $2', [b.supplierId, tenantId])).rows[0];
      if (!s) throw new ApiError(422, 'invalid_expense', 'That supplier is not in your list');
      name = s.name;
      tin = s.tin;
    }
    if (!name) throw new ApiError(422, 'invalid_expense', 'Who is it paid to? Give the supplier');
    const total = parseCents(b.total);
    if (total <= 0n) throw new ApiError(422, 'invalid_expense', 'The amount must be more than zero');
    if (b.endDate && b.endDate < b.startDate) throw new ApiError(422, 'invalid_expense', 'The end date comes before the start');
    return { name, tin, total };
  };

  app.get('/recurring-expenses', async (request) => {
    canRead(request);
    const rows = (await db.query<Row>(`select ${COLUMNS} from recurring_expenses where tenant_id = $1 order by active desc, next_date`, [request.tenantId])).rows;
    // What they come to each month, roughly (weekly × 52 / 12, yearly / 12), for those still running.
    const monthly = rows.filter((r) => r.active && !(r.end_date && r.next_date > r.end_date))
      .reduce((a, r) => a + Number(toBigInt(r.total_cents)) * (r.frequency === 'weekly' ? 52 / 12 : r.frequency === 'yearly' ? 1 / 12 : 1), 0);
    return { data: rows.map(json), monthly: formatCents(BigInt(Math.round(monthly))) };
  });

  app.post<{ Body: Body }>('/recurring-expenses', { schema: { body: bodySchema } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    const b = request.body;
    const p = await prepare(request.tenantId, b);
    const id = randomUUID();
    await db.query(
      `insert into recurring_expenses (id, tenant_id, supplier_id, supplier_name, supplier_tin, category, description, gst_treatment, total_cents, frequency, anchor_day, next_date, end_date, due_days, paid_by, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, request.tenantId, b.supplierId ?? null, p.name, p.tin, b.category.trim(), b.description?.trim() || null, b.gstTreatment, String(p.total), b.frequency,
        Number(b.startDate.slice(8, 10)), b.startDate, b.endDate ?? null, b.dueDays ?? 0, b.paidBy ?? null, request.userId || null],
    );
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'recurring_expense.created', target: p.name, details: { total: formatCents(p.total), frequency: b.frequency }, ip: request.ip });
    // Anything already due (a start date today or earlier) is recorded now.
    await runRecurringExpenses(db, { tenantId: request.tenantId });
    const row = (await db.query<Row>(`select ${COLUMNS} from recurring_expenses where id = $1`, [id])).rows[0]!;
    return reply.code(201).send(json(row));
  });

  app.put<{ Params: { id: string }; Body: Body }>('/recurring-expenses/:id', { schema: { params: idParams, body: bodySchema } }, async (request) => {
    requirePermission(request, 'expenses.manage');
    const b = request.body;
    const p = await prepare(request.tenantId, b);
    const r = await db.query(
      `update recurring_expenses set supplier_id = $3, supplier_name = $4, supplier_tin = $5, category = $6, description = $7, gst_treatment = $8, total_cents = $9, frequency = $10,
         anchor_day = $11, next_date = $12, end_date = $13, due_days = $14, paid_by = $15, active = coalesce($16, active)
       where id = $1 and tenant_id = $2 returning id`,
      [request.params.id, request.tenantId, b.supplierId ?? null, p.name, p.tin, b.category.trim(), b.description?.trim() || null, b.gstTreatment, String(p.total), b.frequency,
        Number(b.startDate.slice(8, 10)), b.startDate, b.endDate ?? null, b.dueDays ?? 0, b.paidBy ?? null, b.active ?? null],
    );
    if (!r.rows.length) throw notFound('Repeating expense');
    await runRecurringExpenses(db, { tenantId: request.tenantId });
    const row = (await db.query<Row>(`select ${COLUMNS} from recurring_expenses where id = $1`, [request.params.id])).rows[0]!;
    return json(row);
  });

  app.delete<{ Params: { id: string } }>('/recurring-expenses/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    // Expenses already recorded stay; they just no longer point here.
    const r = await db.transaction(async (tx) => {
      await tx.query('update expenses set recurring_expense_id = null where recurring_expense_id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
      return tx.query<{ supplier_name: string }>('delete from recurring_expenses where id = $1 and tenant_id = $2 returning supplier_name', [request.params.id, request.tenantId]);
    });
    if (!r.rows.length) throw notFound('Repeating expense');
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'recurring_expense.deleted', target: r.rows[0]!.supplier_name, ip: request.ip });
    return reply.code(204).send();
  });
}
