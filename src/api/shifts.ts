/**
 * Cash registers and shifts.
 *
 *   GET|POST       /v1/registers              the business's drawers / add one
 *   PUT|DELETE     /v1/registers/:id          rename / archive
 *   GET            /v1/shifts/current         my open shift, with its running totals (or null)
 *   POST           /v1/shifts                 open one { registerId?, openingFloat }
 *   POST           /v1/shifts/:id/cash        cash paid in or out { kind, amount, reason }
 *   POST           /v1/shifts/:id/close       count the drawer { countedCash, counted?, note? }
 *   GET            /v1/shifts                 history (everyone's with reports.view, else mine)
 *   GET            /v1/shifts/:id             the shift's report
 *   GET            /v1/shifts/:id/report.pdf  the end-of-day (Z) report, ?format=receipt for the receipt printer
 *
 * What a shift holds: the documents issued and the invoice payments recorded
 * by the person who opened it while it was open (attached when made), and
 * its cash movements. Money in: receipts by their payment means, and invoice
 * payments by method. Money out: credit notes against receipts (refunds)
 * by their means, and cash paid out.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderZReport } from '../render/zreport.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { money, uuid } from './schemas.ts';

export type Means = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';
const MEANS: Means[] = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];
const fromCode = (code: string | null): Means => (code === '10' ? 'cash' : code === '48' || code === '54' || code === '55' ? 'card' : code === '30' || code === '31' || code === '42' ? 'bank_transfer' : code === '20' ? 'cheque' : 'other');
const fromMethod = (m: string): Means => (m === 'cash' || m === 'card' || m === 'bank_transfer' || m === 'cheque' ? m : 'other');
/** Belize notes and coins, for counting the drawer. */
export const DENOMINATIONS = ['100', '50', '20', '10', '5', '2', '1', '0.50', '0.25', '0.10', '0.05', '0.01'] as const;
const COUNTED = "('authorized', 'authorized_with_alert', 'contingency_pending', 'pending')";

interface ShiftRow {
  id: string;
  tenant_id: string;
  register_id: string;
  register_name: string;
  number: number;
  opened_by: string;
  opened_by_name: string;
  opened_at: Date | string;
  opening_float_cents: unknown;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: Date | string | null;
  expected_cash_cents: unknown;
  counted_cash_cents: unknown;
  counted_detail: Record<string, number> | null;
  close_note: string | null;
}

const SHIFT_COLUMNS = `s.*, r.name as register_name, uo.name as opened_by_name, uc.name as closed_by_name`;
const SHIFT_FROM = 'register_shifts s join registers r on r.id = s.register_id join users uo on uo.id = s.opened_by left join users uc on uc.id = s.closed_by';

async function loadShift(db: Queryable, tenantId: string, id: string): Promise<ShiftRow> {
  const s = (await db.query<ShiftRow>(`select ${SHIFT_COLUMNS} from ${SHIFT_FROM} where s.id = $1 and s.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!s) throw notFound('Shift');
  return s;
}

const c = (v: unknown) => formatCents(toBigInt(v ?? 0));
const zero = () => Object.fromEntries(MEANS.map((m) => [m, 0n])) as Record<Means, bigint>;
const asMoney = (r: Record<Means, bigint>) => Object.fromEntries(MEANS.map((m) => [m, formatCents(r[m])])) as Record<Means, string>;

/** Everything the end-of-day report says about a shift. */
export async function shiftReport(db: Queryable, tenantId: string, s: ShiftRow) {
  const byType = (await db.query<{ etd_type: string; n: number; total: unknown; gst: unknown }>(
    `select etd_type, count(*)::int as n, coalesce(sum(payable_cents), 0) as total, coalesce(sum(gst_cents), 0) as gst
     from documents where tenant_id = $1 and shift_id = $2 and status in ${COUNTED} group by etd_type order by etd_type`,
    [tenantId, s.id],
  )).rows;
  const receipts = (await db.query<{ payment_means: string | null; total: unknown }>(
    `select payment_means, coalesce(sum(payable_cents), 0) as total from documents where tenant_id = $1 and shift_id = $2 and etd_type = '02' and status in ${COUNTED} group by payment_means`,
    [tenantId, s.id],
  )).rows;
  const refunds = (await db.query<{ payment_means: string | null; total: unknown; n: number }>(
    `select c.payment_means, coalesce(sum(c.payable_cents), 0) as total, count(*)::int as n from documents c
     where c.tenant_id = $1 and c.shift_id = $2 and c.etd_type = '04' and c.status in ${COUNTED}
       and exists (select 1 from documents o where o.tenant_id = c.tenant_id and o.etdui = c.referenced_etdui and o.etd_type = '02')
     group by c.payment_means`,
    [tenantId, s.id],
  )).rows;
  const payments = (await db.query<{ method: string; total: unknown; n: number }>(
    'select method, coalesce(sum(amount_cents), 0) as total, count(*)::int as n from invoice_payments where tenant_id = $1 and shift_id = $2 and voided_at is null group by method',
    [tenantId, s.id],
  )).rows;
  const voided = (await db.query<{ n: number; total: unknown }>(
    "select count(*)::int as n, coalesce(sum(payable_cents), 0) as total from documents where tenant_id = $1 and shift_id = $2 and status = 'cancelled'",
    [tenantId, s.id],
  )).rows[0]!;
  const moves = (await db.query<{ id: string; kind: 'pay_in' | 'pay_out'; amount_cents: unknown; reason: string; created_at: Date | string; by: string | null }>(
    'select m.id, m.kind, m.amount_cents, m.reason, m.created_at, u.name as by from cash_movements m left join users u on u.id = m.created_by where m.tenant_id = $1 and m.shift_id = $2 order by m.created_at',
    [tenantId, s.id],
  )).rows;

  const sales = zero();
  for (const r of receipts) sales[fromCode(r.payment_means)] += toBigInt(r.total);
  const invoicePayments = zero();
  for (const p of payments) invoicePayments[fromMethod(p.method)] += toBigInt(p.total);
  const refunded = zero();
  for (const r of refunds) refunded[fromCode(r.payment_means)] += toBigInt(r.total);
  const payIn = moves.filter((m) => m.kind === 'pay_in').reduce((a, m) => a + toBigInt(m.amount_cents), 0n);
  const payOut = moves.filter((m) => m.kind === 'pay_out').reduce((a, m) => a + toBigInt(m.amount_cents), 0n);
  const float = toBigInt(s.opening_float_cents);
  const takings = zero();
  for (const m of MEANS) takings[m] = sales[m] + invoicePayments[m] - refunded[m];
  const expectedCash = float + takings.cash + payIn - payOut;
  const counted = s.counted_cash_cents === null ? null : toBigInt(s.counted_cash_cents);
  const typeName: Record<string, string> = { '01': 'Tax invoices', '02': 'Tax receipts', '03': 'Debit notes', '04': 'Credit notes' };
  return {
    documents: byType.map((d) => ({ type: d.etd_type, name: typeName[d.etd_type] ?? d.etd_type, count: d.n, total: c(d.total), gst: c(d.gst) })),
    gst: formatCents(byType.reduce((a, d) => a + (d.etd_type === '04' ? -1n : 1n) * toBigInt(d.gst), 0n)),
    sales: asMoney(sales),
    invoicePayments: asMoney(invoicePayments),
    refunds: asMoney(refunded),
    refundCount: refunds.reduce((a, r) => a + r.n, 0),
    takings: asMoney(takings),
    totalTakings: formatCents(MEANS.reduce((a, m) => a + takings[m], 0n)),
    voided: { count: voided.n, total: c(voided.total) },
    cash: {
      float: formatCents(float),
      in: formatCents(takings.cash),
      payIn: formatCents(payIn),
      payOut: formatCents(payOut),
      expected: formatCents(expectedCash),
      counted: counted === null ? null : formatCents(counted),
      difference: counted === null ? null : formatCents(counted - expectedCash),
    },
    movements: moves.map((m) => ({ id: m.id, kind: m.kind, amount: c(m.amount_cents), reason: m.reason, at: new Date(m.created_at).toISOString(), by: m.by })),
  };
}

export function shiftJson(s: ShiftRow) {
  return {
    id: s.id,
    number: s.number,
    register: { id: s.register_id, name: s.register_name },
    openedBy: { id: s.opened_by, name: s.opened_by_name },
    openedAt: new Date(s.opened_at).toISOString(),
    openingFloat: c(s.opening_float_cents),
    status: s.closed_at ? 'closed' as const : 'open' as const,
    closedBy: s.closed_by_name,
    closedAt: s.closed_at ? new Date(s.closed_at).toISOString() : null,
    expectedCash: s.expected_cash_cents === null ? null : c(s.expected_cash_cents),
    countedCash: s.counted_cash_cents === null ? null : c(s.counted_cash_cents),
    difference: s.counted_cash_cents === null || s.expected_cash_cents === null ? null : formatCents(toBigInt(s.counted_cash_cents) - toBigInt(s.expected_cash_cents)),
    countedDetail: s.counted_detail,
    note: s.close_note,
  };
}

export function registerShiftRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const seesAll = (request: FastifyRequest) => can(request.principal, 'reports.view');
  const mayHandle = (request: FastifyRequest, s: ShiftRow) => s.opened_by === request.userId || can(request.principal, 'documents.adjust');
  const person = (request: FastifyRequest) => {
    if (!request.userId) throw new ApiError(403, 'forbidden', 'Shifts are for people at the counter, not API keys');
    return request.userId;
  };

  // ---------- registers ----------
  app.get('/registers', async (request) => {
    const rows = (await db.query<{ id: string; name: string; open_by: string | null; open_since: Date | string | null }>(
      `select r.id, r.name, u.name as open_by, s.opened_at as open_since from registers r
       left join register_shifts s on s.register_id = r.id and s.closed_at is null left join users u on u.id = s.opened_by
       where r.tenant_id = $1 and r.archived_at is null order by lower(r.name)`,
      [request.tenantId],
    )).rows;
    return { data: rows.map((r) => ({ id: r.id, name: r.name, openBy: r.open_by, openSince: r.open_since ? new Date(r.open_since).toISOString() : null })) };
  });

  const nameBody = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 60 } } } as const;
  app.post<{ Body: { name: string } }>('/registers', { schema: { body: nameBody } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const id = randomUUID();
    try {
      await db.query('insert into registers (id, tenant_id, name) values ($1, $2, $3)', [id, request.tenantId, request.body.name.trim()]);
    } catch (e) {
      if (/unique|duplicate/i.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', 'There is already a register with that name');
      throw e;
    }
    return reply.code(201).send({ id, name: request.body.name.trim() });
  });
  app.put<{ Params: { id: string }; Body: { name: string } }>('/registers/:id', { schema: { params: idParams, body: nameBody } }, async (request) => {
    requirePermission(request, 'business.manage');
    const r = await db.query('update registers set name = $3 where id = $1 and tenant_id = $2 and archived_at is null returning id', [request.params.id, request.tenantId, request.body.name.trim()]);
    if (!r.rows.length) throw notFound('Register');
    return { id: request.params.id, name: request.body.name.trim() };
  });
  app.delete<{ Params: { id: string } }>('/registers/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const open = await db.query('select 1 from register_shifts where register_id = $1 and closed_at is null', [request.params.id]);
    if (open.rows.length) throw new ApiError(409, 'shift_open', 'Close the shift on this register first');
    const r = await db.query('update registers set archived_at = now() where id = $1 and tenant_id = $2 and archived_at is null returning id', [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Register');
    return reply.code(204).send();
  });

  // ---------- shifts ----------
  app.get('/shifts/current', async (request) => {
    if (!request.userId) return { shift: null, report: null };
    const s = (await db.query<ShiftRow>(`select ${SHIFT_COLUMNS} from ${SHIFT_FROM} where s.tenant_id = $1 and s.opened_by = $2 and s.closed_at is null`, [request.tenantId, request.userId])).rows[0];
    return s ? { shift: shiftJson(s), report: await shiftReport(db, request.tenantId, s) } : { shift: null, report: null };
  });

  app.post<{ Body: { registerId?: string; openingFloat: string } }>(
    '/shifts',
    { schema: { body: { type: 'object', required: ['openingFloat'], additionalProperties: false, properties: { registerId: uuid, openingFloat: money } } } },
    async (request, reply) => {
      requirePermission(request, 'documents.issue');
      const userId = person(request);
      const float = parseCents(request.body.openingFloat);
      if (float < 0n) throw new ApiError(422, 'invalid_shift', 'The float cannot be negative');
      let registerId = request.body.registerId;
      if (!registerId) {
        // The first shift of a business creates its register.
        const first = (await db.query<{ id: string }>('select id from registers where tenant_id = $1 and archived_at is null order by created_at limit 2', [request.tenantId])).rows;
        if (first.length > 1) throw new ApiError(422, 'invalid_shift', 'Choose the register');
        registerId = first[0]?.id;
        if (!registerId) {
          registerId = randomUUID();
          await db.query("insert into registers (id, tenant_id, name) values ($1, $2, 'Main register')", [registerId, request.tenantId]);
        }
      }
      const reg = (await db.query('select 1 from registers where id = $1 and tenant_id = $2 and archived_at is null', [registerId, request.tenantId])).rows[0];
      if (!reg) throw new ApiError(422, 'invalid_shift', 'That register is not in your list');
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          const n = (await tx.query<{ n: number }>('update tenants set next_shift_number = next_shift_number + 1 where id = $1 returning next_shift_number - 1 as n', [request.tenantId])).rows[0]!.n;
          await tx.query('insert into register_shifts (id, tenant_id, register_id, number, opened_by, opening_float_cents) values ($1, $2, $3, $4, $5, $6)',
            [id, request.tenantId, registerId, n, userId, String(float)]);
        });
      } catch (e) {
        const m = String((e as Error).message);
        if (/register_shifts_open_user/.test(m)) throw new ApiError(409, 'shift_open', 'You already have a shift open; close it first');
        if (/register_shifts_open_register/.test(m)) throw new ApiError(409, 'register_busy', 'Someone already has a shift open on this register');
        throw e;
      }
      const s = await loadShift(db, request.tenantId, id);
      await audit(db, { tenantId: request.tenantId, userId, action: 'shift.opened', target: `#${s.number} ${s.register_name}`, details: { float: formatCents(float) }, ip: request.ip });
      return reply.code(201).send({ shift: shiftJson(s), report: await shiftReport(db, request.tenantId, s) });
    },
  );

  app.post<{ Params: { id: string }; Body: { kind: 'pay_in' | 'pay_out'; amount: string; reason: string } }>(
    '/shifts/:id/cash',
    { schema: { params: idParams, body: { type: 'object', required: ['kind', 'amount', 'reason'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['pay_in', 'pay_out'] }, amount: money, reason: { type: 'string', minLength: 2, maxLength: 200 } } } } },
    async (request, reply) => {
      requirePermission(request, 'documents.issue');
      const userId = person(request);
      const s = await loadShift(db, request.tenantId, request.params.id);
      if (!mayHandle(request, s)) throw new ApiError(403, 'forbidden', 'This is someone else’s shift');
      if (s.closed_at) throw new ApiError(409, 'shift_closed', 'This shift is closed');
      const amount = parseCents(request.body.amount);
      if (amount <= 0n) throw new ApiError(422, 'invalid_amount', 'The amount must be more than zero');
      await db.query('insert into cash_movements (id, tenant_id, shift_id, kind, amount_cents, reason, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
        [randomUUID(), request.tenantId, s.id, request.body.kind, String(amount), request.body.reason.trim(), userId]);
      await audit(db, { tenantId: request.tenantId, userId, action: request.body.kind === 'pay_in' ? 'shift.cash_in' : 'shift.cash_out', target: `#${s.number}`, details: { amount: formatCents(amount), reason: request.body.reason.trim() }, ip: request.ip });
      return reply.code(201).send({ shift: shiftJson(s), report: await shiftReport(db, request.tenantId, s) });
    },
  );

  app.post<{ Params: { id: string }; Body: { countedCash: string; counted?: Record<string, number>; note?: string } }>(
    '/shifts/:id/close',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['countedCash'], additionalProperties: false,
          properties: {
            countedCash: money, note: { type: 'string', maxLength: 500 },
            counted: { type: 'object', additionalProperties: false, properties: Object.fromEntries(DENOMINATIONS.map((d) => [d, { type: 'integer', minimum: 0, maximum: 100000 }])) },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const userId = person(request);
      const s = await loadShift(db, request.tenantId, request.params.id);
      if (!mayHandle(request, s)) throw new ApiError(403, 'forbidden', 'Only the person who opened it, or a manager, closes a shift');
      if (s.closed_at) throw new ApiError(409, 'shift_closed', 'This shift is already closed');
      const counted = parseCents(request.body.countedCash);
      if (counted < 0n) throw new ApiError(422, 'invalid_amount', 'The count cannot be negative');
      // The notes and coins, when given, must add up to the count.
      if (request.body.counted) {
        const sum = Object.entries(request.body.counted).reduce((a, [d, n]) => a + parseCents(d) * BigInt(n), 0n);
        if (sum !== counted) throw new ApiError(422, 'invalid_count', `The notes and coins add up to BZ$${formatCents(sum)}, not BZ$${formatCents(counted)}`);
      }
      const report = await shiftReport(db, request.tenantId, s);
      const expected = parseCents(report.cash.expected);
      const closed = await db.query(
        'update register_shifts set closed_by = $3, closed_at = now(), expected_cash_cents = $4, counted_cash_cents = $5, counted_detail = $6, close_note = $7 where id = $1 and tenant_id = $2 and closed_at is null returning id',
        [s.id, request.tenantId, userId, String(expected), String(counted), request.body.counted ? JSON.stringify(request.body.counted) : null, request.body.note?.trim() || null],
      );
      if (!closed.rows.length) throw new ApiError(409, 'shift_closed', 'This shift is already closed');
      const after = await loadShift(db, request.tenantId, s.id);
      await audit(db, { tenantId: request.tenantId, userId, action: 'shift.closed', target: `#${s.number} ${s.register_name}`, details: { expected: formatCents(expected), counted: formatCents(counted), difference: formatCents(counted - expected) }, ip: request.ip });
      return { shift: shiftJson(after), report: await shiftReport(db, request.tenantId, after) };
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/shifts',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const all = seesAll(request);
      const rows = (await db.query<ShiftRow>(
        `select ${SHIFT_COLUMNS} from ${SHIFT_FROM} where s.tenant_id = $1 and ($2::uuid is null or s.opened_by = $2)
           and ($3::date is null or (s.opened_at - interval '6 hours')::date >= $3::date) and ($4::date is null or (s.opened_at - interval '6 hours')::date <= $4::date)
         order by s.opened_at desc limit 200`,
        [request.tenantId, all ? null : request.userId || null, request.query.from ?? null, request.query.to ?? null],
      )).rows;
      return { data: rows.map(shiftJson) };
    },
  );

  const visible = async (request: FastifyRequest<{ Params: { id: string } }>) => {
    requirePermission(request, 'documents.issue');
    const s = await loadShift(db, request.tenantId, request.params.id);
    if (!seesAll(request) && s.opened_by !== request.userId) throw notFound('Shift');
    return s;
  };

  app.get<{ Params: { id: string } }>('/shifts/:id', { schema: { params: idParams } }, async (request) => {
    const s = await visible(request);
    return { shift: shiftJson(s), report: await shiftReport(db, request.tenantId, s) };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: 'receipt' | 'sheet' } }>(
    '/shifts/:id/report.pdf',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { format: { type: 'string', enum: ['receipt', 'sheet'] } } } } },
    async (request, reply) => {
      const s = await visible(request);
      const biz = (await db.query<{ name: string; tin: string }>('select coalesce(trade_name, legal_name) as name, tin from tenants where id = $1', [request.tenantId])).rows[0]!;
      const pdf = await renderZReport({ business: biz, shift: shiftJson(s), report: await shiftReport(db, request.tenantId, s), format: request.query.format ?? 'receipt' });
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="shift-${s.number}.pdf"`).send(pdf);
    },
  );
}
