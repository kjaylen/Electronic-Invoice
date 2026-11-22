/**
 * Money out: suppliers, expenses and bills to pay, each with a photo or PDF
 * of the receipt.
 *
 *   GET|POST       /v1/suppliers                 list (search) / add
 *   PUT|DELETE     /v1/suppliers/:id             change / archive
 *   GET            /v1/expenses                  list with totals (period, paid or not, category, supplier, search)
 *   GET            /v1/expenses.csv
 *   POST           /v1/expenses                  { supplierId? | supplierName, supplierTin?, reference?, date, dueDate?, category, description?,
 *                                                  gstTreatment, total, gst?, claimGst?, paid?: { on, method } }
 *   GET|PUT|DELETE /v1/expenses/:id
 *   POST           /v1/expenses/:id/pay          { paidOn, method }
 *   POST|GET|DELETE /v1/expenses/:id/receipt     JPEG, PNG, WebP or PDF up to 5 MB (Base64 in JSON)
 *   GET            /v1/expense-categories        the usual ones and those the business uses
 *
 * Amounts: the total as paid (GST included). For standard-rated purchases the
 * GST is worked out at 12.5% unless the receipt shows another figure
 * (rounding), which can be given. GST can be claimed back only with a tax
 * invoice from a GST-registered supplier (its TIN).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { imageType } from './products.ts';
import { csvCell } from './reports.ts';
import { date as dateSchema, money, uuid } from './schemas.ts';

export const DEFAULT_CATEGORIES = [
  'Stock for resale', 'Raw materials', 'Rent', 'Electricity', 'Water', 'Telephone and internet', 'Fuel and transport', 'Repairs and maintenance',
  'Office supplies', 'Equipment', 'Advertising', 'Professional fees', 'Bank charges', 'Insurance', 'Wages', 'Licences and fees', 'Meals and entertainment', 'Other',
] as const;
export type GstTreatment = 'standard' | 'zero' | 'exempt' | 'none';
const MAX_RECEIPT = 5 * 1024 * 1024;
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

/** GST inside a standard-rated total: total × 12.5 / 112.5, to the cent. */
export function gstInside(totalCents: bigint, ratePercent = '12.5'): bigint {
  const [w, f = ''] = ratePercent.split('.');
  const rate = BigInt(w!) * 1000n + BigInt((f + '000').slice(0, 3)); // thousandths of a percent
  const num = totalCents * rate;
  const den = 100_000n + rate;
  return (num * 2n + den) / (2n * den);
}

const receiptKind = (data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | null =>
  imageType(data) ?? (data.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null);

interface ExpenseRow {
  id: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_tin: string | null;
  reference: string | null;
  expense_date: string;
  due_date: string | null;
  category: string;
  description: string | null;
  gst_treatment: GstTreatment;
  net_cents: unknown;
  gst_cents: unknown;
  total_cents: unknown;
  claim_gst: boolean;
  paid_on: string | null;
  payment_method: string | null;
  receipt_content_type: string | null;
  receipt_bytes: number | null;
  created_by_name: string | null;
  created_at: Date | string;
}

const COLUMNS = `e.id, e.supplier_id, e.supplier_name, e.supplier_tin, e.reference, e.expense_date::text as expense_date, e.due_date::text as due_date, e.category, e.description,
  e.gst_treatment, e.net_cents, e.gst_cents, e.total_cents, e.claim_gst, e.paid_on::text as paid_on, e.payment_method, e.receipt_content_type, e.receipt_bytes,
  u.name as created_by_name, e.created_at`;

export function expenseJson(e: ExpenseRow) {
  const today = belizeToday();
  return {
    id: e.id,
    supplier: { id: e.supplier_id, name: e.supplier_name, tin: e.supplier_tin },
    reference: e.reference,
    date: e.expense_date,
    dueDate: e.due_date,
    category: e.category,
    description: e.description,
    gstTreatment: e.gst_treatment,
    net: formatCents(toBigInt(e.net_cents)),
    gst: formatCents(toBigInt(e.gst_cents)),
    total: formatCents(toBigInt(e.total_cents)),
    /** GST that can be claimed back on the GST return. */
    claimableGst: formatCents(e.claim_gst && e.supplier_tin && e.gst_treatment === 'standard' ? toBigInt(e.gst_cents) : 0n),
    claimGst: e.claim_gst,
    paid: e.paid_on ? { on: e.paid_on, method: e.payment_method } : null,
    overdue: !e.paid_on && Boolean(e.due_date && e.due_date < today),
    receipt: e.receipt_content_type ? { contentType: e.receipt_content_type, bytes: e.receipt_bytes } : null,
    recordedBy: e.created_by_name,
    createdAt: new Date(e.created_at).toISOString(),
  };
}

async function loadExpense(db: Queryable, tenantId: string, id: string): Promise<ExpenseRow> {
  const e = (await db.query<ExpenseRow>(`select ${COLUMNS} from expenses e left join users u on u.id = e.created_by where e.id = $1 and e.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!e) throw notFound('Expense');
  return e;
}

interface SupplierRow { id: string; name: string; tin: string | null; email: string | null; telephone: string | null; address: string | null; notes: string | null; archived_at: Date | string | null }
const supplierJson = (s: SupplierRow) => ({ id: s.id, name: s.name, tin: s.tin, email: s.email, telephone: s.telephone, address: s.address, notes: s.notes, archived: Boolean(s.archived_at) });

export interface ExpenseBody {
  supplierId?: string;
  supplierName?: string;
  supplierTin?: string;
  reference?: string;
  date: string;
  dueDate?: string | null;
  category: string;
  description?: string;
  gstTreatment: GstTreatment;
  total: string;
  gst?: string;
  claimGst?: boolean;
  paid?: { on: string; method: string } | null;
}

const PAYMENT_METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'];

/** Checks an expense and works out its amounts. */
async function prepare(db: Queryable, tenantId: string, b: ExpenseBody) {
  let supplierName = b.supplierName?.trim() ?? '';
  let supplierTin = b.supplierTin?.trim() || null;
  if (b.supplierId) {
    const s = (await db.query<SupplierRow>('select * from suppliers where id = $1 and tenant_id = $2', [b.supplierId, tenantId])).rows[0];
    if (!s) throw new ApiError(422, 'invalid_expense', 'That supplier is not in your list');
    supplierName = s.name;
    supplierTin = b.supplierTin?.trim() || s.tin;
  }
  if (!supplierName) throw new ApiError(422, 'invalid_expense', 'Who was it paid to? Give the supplier');
  const today = belizeToday();
  if (b.date > today) throw new ApiError(422, 'invalid_expense', 'An expense cannot be dated in the future');
  if (b.paid && b.paid.on < b.date) throw new ApiError(422, 'invalid_expense', 'It cannot be paid before its date');
  if (b.paid && b.paid.on > today) throw new ApiError(422, 'invalid_expense', 'A payment cannot be dated in the future');
  const total = parseCents(b.total);
  if (total <= 0n) throw new ApiError(422, 'invalid_expense', 'The amount must be more than zero');
  let gst = 0n;
  if (b.gstTreatment === 'standard') {
    gst = b.gst !== undefined ? parseCents(b.gst) : gstInside(total);
    if (gst < 0n || gst >= total) throw new ApiError(422, 'invalid_expense', 'The GST must be less than the total');
  } else if (b.gst !== undefined && parseCents(b.gst) !== 0n) {
    throw new ApiError(422, 'invalid_expense', 'Only standard-rated purchases carry GST');
  }
  return { supplierName, supplierTin, total, gst, net: total - gst };
}

const expenseSchema = {
  type: 'object',
  required: ['date', 'category', 'gstTreatment', 'total'],
  additionalProperties: false,
  properties: {
    supplierId: uuid,
    supplierName: { type: 'string', maxLength: 200 },
    supplierTin: { type: 'string', pattern: '^\\d{6}$' },
    reference: { type: 'string', maxLength: 100 },
    date: dateSchema,
    dueDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    category: { type: 'string', minLength: 1, maxLength: 60 },
    description: { type: 'string', maxLength: 500 },
    gstTreatment: { type: 'string', enum: ['standard', 'zero', 'exempt', 'none'] },
    total: money,
    gst: money,
    claimGst: { type: 'boolean' },
    paid: {
      type: ['object', 'null'], required: ['on', 'method'], additionalProperties: false,
      properties: { on: dateSchema, method: { type: 'string', enum: PAYMENT_METHODS } },
    },
  },
} as const;

export function registerExpenseRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'expenses.manage')) requirePermission(request, 'reports.view');
  };

  // ---------- suppliers ----------
  const supplierSchema = {
    type: 'object', required: ['name'], additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, tin: { type: ['string', 'null'], pattern: '^\\d{6}$' }, email: { type: ['string', 'null'], maxLength: 254 },
      telephone: { type: ['string', 'null'], maxLength: 40 }, address: { type: ['string', 'null'], maxLength: 300 }, notes: { type: ['string', 'null'], maxLength: 1000 },
    },
  } as const;
  type SupplierBody = { name: string; tin?: string | null; email?: string | null; telephone?: string | null; address?: string | null; notes?: string | null };

  app.get<{ Querystring: { q?: string; archived?: 'true' | 'false' } }>(
    '/suppliers',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 }, archived: { type: 'string', enum: ['true', 'false'] } } } } },
    async (request) => {
      canRead(request);
      const q = request.query.q?.trim();
      const rows = (await db.query<SupplierRow & { spent: unknown; unpaid: unknown }>(
        `select s.*, coalesce((select sum(total_cents) from expenses e where e.supplier_id = s.id), 0) as spent,
                coalesce((select sum(total_cents) from expenses e where e.supplier_id = s.id and e.paid_on is null), 0) as unpaid
         from suppliers s where s.tenant_id = $1 and ($2::text is null or s.name ilike $2 or s.tin = $3) and (s.archived_at is null) = $4
         order by lower(s.name) limit 500`,
        [request.tenantId, q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null, q ?? null, request.query.archived !== 'true'],
      )).rows;
      return { data: rows.map((s) => ({ ...supplierJson(s), spent: formatCents(toBigInt(s.spent)), unpaid: formatCents(toBigInt(s.unpaid)) })) };
    },
  );

  app.post<{ Body: SupplierBody }>('/suppliers', { schema: { body: supplierSchema } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    const b = request.body;
    const id = randomUUID();
    await db.query('insert into suppliers (id, tenant_id, name, tin, email, telephone, address, notes) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, request.tenantId, b.name.trim(), b.tin || null, b.email?.trim() || null, b.telephone?.trim() || null, b.address?.trim() || null, b.notes?.trim() || null]);
    const s = (await db.query<SupplierRow>('select * from suppliers where id = $1', [id])).rows[0]!;
    return reply.code(201).send(supplierJson(s));
  });

  app.put<{ Params: { id: string }; Body: SupplierBody }>('/suppliers/:id', { schema: { params: idParams, body: supplierSchema } }, async (request) => {
    requirePermission(request, 'expenses.manage');
    const b = request.body;
    const r = (await db.query<SupplierRow>(
      'update suppliers set name = $3, tin = $4, email = $5, telephone = $6, address = $7, notes = $8, updated_at = now() where id = $1 and tenant_id = $2 returning *',
      [request.params.id, request.tenantId, b.name.trim(), b.tin || null, b.email?.trim() || null, b.telephone?.trim() || null, b.address?.trim() || null, b.notes?.trim() || null],
    )).rows[0];
    if (!r) throw notFound('Supplier');
    return supplierJson(r);
  });

  app.delete<{ Params: { id: string } }>('/suppliers/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    const r = await db.query('update suppliers set archived_at = now() where id = $1 and tenant_id = $2 and archived_at is null returning id', [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Supplier');
    return reply.code(204).send();
  });

  // ---------- expenses ----------
  type ListQuery = { from?: string; to?: string; status?: 'paid' | 'unpaid' | 'all'; category?: string; supplierId?: string; q?: string };
  const listSchema = {
    type: 'object', additionalProperties: false,
    properties: { from: dateSchema, to: dateSchema, status: { type: 'string', enum: ['paid', 'unpaid', 'all'] }, category: { type: 'string', maxLength: 60 }, supplierId: uuid, q: { type: 'string', maxLength: 100 } },
  } as const;
  const listWhere = (tenantId: string, q: ListQuery) => {
    const params: unknown[] = [tenantId];
    let where = 'e.tenant_id = $1';
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where += ` and ${sql.replace('?', `$${params.length}`)}`;
    };
    if (q.from) add('e.expense_date >= ?::date', q.from);
    if (q.to) add('e.expense_date <= ?::date', q.to);
    if (q.status === 'paid') where += ' and e.paid_on is not null';
    if (q.status === 'unpaid') where += ' and e.paid_on is null';
    if (q.category) add('e.category = ?', q.category);
    if (q.supplierId) add('e.supplier_id = ?', q.supplierId);
    if (q.q?.trim()) {
      params.push(`%${q.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where += ` and (e.supplier_name ilike $${params.length} or e.reference ilike $${params.length} or e.description ilike $${params.length})`;
    }
    return { where, params };
  };

  app.get<{ Querystring: ListQuery }>('/expenses', { schema: { querystring: listSchema } }, async (request) => {
    canRead(request);
    const { where, params } = listWhere(request.tenantId, request.query);
    const rows = (await db.query<ExpenseRow>(
      `select ${COLUMNS} from expenses e left join users u on u.id = e.created_by where ${where}
       order by ${request.query.status === 'unpaid' ? 'coalesce(e.due_date, e.expense_date), e.created_at' : 'e.expense_date desc, e.created_at desc'} limit 1000`, params,
    )).rows;
    const t = (await db.query<{ n: number; net: unknown; gst: unknown; total: unknown; claimable: unknown; unpaid: unknown; overdue: unknown }>(
      `select count(*)::int as n, coalesce(sum(net_cents), 0) as net, coalesce(sum(gst_cents), 0) as gst, coalesce(sum(total_cents), 0) as total,
         coalesce(sum(gst_cents) filter (where claim_gst and supplier_tin is not null and gst_treatment = 'standard'), 0) as claimable,
         coalesce(sum(total_cents) filter (where paid_on is null), 0) as unpaid,
         coalesce(sum(total_cents) filter (where paid_on is null and due_date < $${params.length + 1}::date), 0) as overdue
       from expenses e where ${where}`, [...params, belizeToday()],
    )).rows[0]!;
    const c = (v: unknown) => formatCents(toBigInt(v));
    return { data: rows.map(expenseJson), totals: { count: t.n, net: c(t.net), gst: c(t.gst), total: c(t.total), claimableGst: c(t.claimable), unpaid: c(t.unpaid), overdue: c(t.overdue) } };
  });

  app.get<{ Querystring: ListQuery }>('/expenses.csv', { schema: { querystring: listSchema } }, async (request, reply) => {
    canRead(request);
    const { where, params } = listWhere(request.tenantId, request.query);
    const rows = (await db.query<ExpenseRow>(`select ${COLUMNS} from expenses e left join users u on u.id = e.created_by where ${where} order by e.expense_date, e.created_at limit 20000`, params)).rows.map(expenseJson);
    const header = ['Date', 'Supplier', 'Supplier TIN', 'Reference', 'Category', 'Description', 'GST treatment', 'Net', 'GST', 'Total', 'GST claimable', 'Due', 'Paid on', 'Method', 'Receipt'];
    const lines = [header.map((h) => csvCell(h)).join(',')];
    for (const e of rows) {
      lines.push([
        csvCell(e.date), csvCell(e.supplier.name), csvCell(e.supplier.tin ?? ''), csvCell(e.reference ?? ''), csvCell(e.category), csvCell(e.description ?? ''), csvCell(e.gstTreatment),
        csvCell(e.net, false), csvCell(e.gst, false), csvCell(e.total, false), csvCell(e.claimableGst, false), csvCell(e.dueDate ?? ''), csvCell(e.paid?.on ?? ''), csvCell(e.paid?.method ?? ''), csvCell(e.receipt ? 'yes' : 'no'),
      ].join(','));
    }
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="expenses-${request.query.from ?? 'all'}-to-${request.query.to ?? belizeToday()}.csv"`).send(`﻿${lines.join('\r\n')}\r\n`);
  });

  app.get('/expense-categories', async (request) => {
    canRead(request);
    const used = (await db.query<{ category: string; n: number }>('select category, count(*)::int as n from expenses where tenant_id = $1 group by category order by count(*) desc limit 100', [request.tenantId])).rows;
    const all = [...new Set([...used.map((u) => u.category), ...DEFAULT_CATEGORIES])];
    return { data: all, used: used.map((u) => u.category) };
  });

  app.post<{ Body: ExpenseBody }>('/expenses', { schema: { body: expenseSchema } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    const b = request.body;
    const p = await prepare(db, request.tenantId, b);
    const id = randomUUID();
    await db.query(
      `insert into expenses (id, tenant_id, supplier_id, supplier_name, supplier_tin, reference, expense_date, due_date, category, description, gst_treatment, net_cents, gst_cents, total_cents, claim_gst, paid_on, payment_method, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, request.tenantId, b.supplierId ?? null, p.supplierName, p.supplierTin, b.reference?.trim() || null, b.date, b.paid ? null : b.dueDate ?? null, b.category.trim(), b.description?.trim() || null,
        b.gstTreatment, String(p.net), String(p.gst), String(p.total), b.claimGst ?? true, b.paid?.on ?? null, b.paid?.method ?? null, request.userId || null],
    );
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'expense.recorded', target: p.supplierName, details: { total: formatCents(p.total) }, ip: request.ip });
    return reply.code(201).send(expenseJson(await loadExpense(db, request.tenantId, id)));
  });

  app.get<{ Params: { id: string } }>('/expenses/:id', { schema: { params: idParams } }, async (request) => {
    canRead(request);
    return expenseJson(await loadExpense(db, request.tenantId, request.params.id));
  });

  app.put<{ Params: { id: string }; Body: ExpenseBody }>('/expenses/:id', { schema: { params: idParams, body: expenseSchema } }, async (request) => {
    requirePermission(request, 'expenses.manage');
    await loadExpense(db, request.tenantId, request.params.id);
    const b = request.body;
    const p = await prepare(db, request.tenantId, b);
    await db.query(
      `update expenses set supplier_id = $3, supplier_name = $4, supplier_tin = $5, reference = $6, expense_date = $7, due_date = $8, category = $9, description = $10, gst_treatment = $11,
         net_cents = $12, gst_cents = $13, total_cents = $14, claim_gst = $15, paid_on = $16, payment_method = $17, updated_at = now()
       where id = $1 and tenant_id = $2`,
      [request.params.id, request.tenantId, b.supplierId ?? null, p.supplierName, p.supplierTin, b.reference?.trim() || null, b.date, b.paid ? null : b.dueDate ?? null, b.category.trim(), b.description?.trim() || null,
        b.gstTreatment, String(p.net), String(p.gst), String(p.total), b.claimGst ?? true, b.paid?.on ?? null, b.paid?.method ?? null],
    );
    return expenseJson(await loadExpense(db, request.tenantId, request.params.id));
  });

  app.delete<{ Params: { id: string } }>('/expenses/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'expenses.manage');
    const r = (await db.query<{ receipt_key: string | null; supplier_name: string; total_cents: unknown }>('delete from expenses where id = $1 and tenant_id = $2 returning receipt_key, supplier_name, total_cents', [request.params.id, request.tenantId])).rows[0];
    if (!r) throw notFound('Expense');
    if (r.receipt_key && ctx.objects) await ctx.objects.delete(r.receipt_key).catch((e) => request.log.warn({ err: e }, 'receipt object not deleted'));
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'expense.deleted', target: r.supplier_name, details: { total: formatCents(toBigInt(r.total_cents)) }, ip: request.ip });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { paidOn: string; method: string } }>(
    '/expenses/:id/pay',
    { schema: { params: idParams, body: { type: 'object', required: ['paidOn', 'method'], additionalProperties: false, properties: { paidOn: dateSchema, method: { type: 'string', enum: PAYMENT_METHODS } } } } },
    async (request) => {
      requirePermission(request, 'expenses.manage');
      const e = await loadExpense(db, request.tenantId, request.params.id);
      if (e.paid_on) throw new ApiError(409, 'already_paid', 'This bill is already paid');
      if (request.body.paidOn > belizeToday()) throw new ApiError(422, 'invalid_expense', 'A payment cannot be dated in the future');
      if (request.body.paidOn < e.expense_date) throw new ApiError(422, 'invalid_expense', 'It cannot be paid before its date');
      await db.query('update expenses set paid_on = $3, payment_method = $4, updated_at = now() where id = $1 and tenant_id = $2', [e.id, request.tenantId, request.body.paidOn, request.body.method]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'expense.paid', target: e.supplier_name, details: { total: formatCents(toBigInt(e.total_cents)) }, ip: request.ip });
      return expenseJson(await loadExpense(db, request.tenantId, e.id));
    },
  );

  // ---------- the receipt ----------
  app.post<{ Params: { id: string }; Body: { dataBase64: string } }>(
    '/expenses/:id/receipt',
    { bodyLimit: 8 * 1024 * 1024, schema: { params: idParams, body: { type: 'object', required: ['dataBase64'], additionalProperties: false, properties: { dataBase64: { type: 'string', minLength: 16, maxLength: 7_200_000 } } } } },
    async (request) => {
      requirePermission(request, 'expenses.manage');
      const e = await loadExpense(db, request.tenantId, request.params.id);
      const data = Buffer.from(request.body.dataBase64, 'base64');
      if (data.length > MAX_RECEIPT) throw new ApiError(413, 'receipt_too_large', 'Receipts can be up to 5 MB');
      const type = receiptKind(data);
      if (!type) throw new ApiError(422, 'invalid_receipt', 'Use a photo (JPEG, PNG, WebP) or a PDF');
      const old = (await db.query<{ receipt_key: string | null }>('select receipt_key from expenses where id = $1', [e.id])).rows[0]!.receipt_key;
      // Private: in object storage when configured, but always served through the app (never a public address).
      const key = ctx.objects ? `receipts/${request.tenantId}/${e.id}-${randomUUID().slice(0, 8)}.${type === 'application/pdf' ? 'pdf' : type.split('/')[1]}` : null;
      if (key && ctx.objects) await ctx.objects.put(key, data, type);
      await db.query('update expenses set receipt_content_type = $2, receipt_bytes = $3, receipt_data = $4, receipt_key = $5, updated_at = now() where id = $1',
        [e.id, type, data.length, key ? null : data, key]);
      if (old && ctx.objects) await ctx.objects.delete(old).catch(() => {});
      return expenseJson(await loadExpense(db, request.tenantId, e.id));
    },
  );

  app.get<{ Params: { id: string } }>('/expenses/:id/receipt', { schema: { params: idParams } }, async (request, reply) => {
    canRead(request);
    const r = (await db.query<{ receipt_content_type: string | null; receipt_data: Uint8Array | null; receipt_key: string | null }>(
      'select receipt_content_type, receipt_data, receipt_key from expenses where id = $1 and tenant_id = $2', [request.params.id, request.tenantId],
    )).rows[0];
    if (!r?.receipt_content_type) throw notFound('Receipt');
    let data: Buffer | null = r.receipt_data ? Buffer.from(r.receipt_data) : null;
    if (!data && r.receipt_key && ctx.objects) data = (await ctx.objects.get(r.receipt_key))?.data ?? null;
    if (!data) throw notFound('Receipt');
    return reply.type(r.receipt_content_type).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `inline; filename="receipt-${request.params.id.slice(0, 8)}.${r.receipt_content_type === 'application/pdf' ? 'pdf' : r.receipt_content_type.split('/')[1]}"`).send(data);
  });

  app.delete<{ Params: { id: string } }>('/expenses/:id/receipt', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'expenses.manage');
    const r = (await db.query<{ receipt_key: string | null }>(
      'update expenses e set receipt_content_type = null, receipt_bytes = null, receipt_data = null, receipt_key = null, updated_at = now() from (select receipt_key from expenses where id = $1 and tenant_id = $2) old where e.id = $1 and e.tenant_id = $2 returning old.receipt_key',
      [request.params.id, request.tenantId],
    )).rows[0];
    if (!r) throw notFound('Expense');
    if (r.receipt_key && ctx.objects) await ctx.objects.delete(r.receipt_key).catch(() => {});
    return expenseJson(await loadExpense(db, request.tenantId, request.params.id));
  });
}
