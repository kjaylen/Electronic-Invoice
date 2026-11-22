/**
 * Getting paid: what each customer owes on tax invoices and debit notes.
 *
 * An invoice's balance is its amount payable, less payments received (never
 * deleted; mistakes are voided), less credit notes issued against it. A
 * balance below zero is a credit the customer holds. Receipts are paid when
 * issued, so they are never owed.
 *
 * Only documents with legal value count (authorized, or issued in
 * contingency), in the business's current BTS environment. Documents of
 * online store orders are left out: the buyer paid at checkout (and refunds
 * are paid back there). Dates are Belize dates (UTC-6).
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { readEtdForPrint } from '../render/view.ts';
import { openShiftSql } from '../db/shifts.ts';

export class ReceivableError extends Error {
  override name = 'ReceivableError';
}

export type PaymentMethod = 'cash' | 'cheque' | 'bank_transfer' | 'card' | 'online' | 'refund' | 'other';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'];

const OPEN_STATUSES = "('authorized', 'authorized_with_alert', 'contingency_pending')";
const CREDIT_STATUSES = "('authorized', 'authorized_with_alert', 'contingency_pending', 'pending')";
const TODAY = "(now() - interval '6 hours')::date";

/** Every receivable document of a business, with what was paid and credited (a SQL source, $1 = tenant). */
const RECEIVABLES = `
  select d.id, d.etd_type, d.series_number, d.serial::text as serial, d.etdui, d.issue_date::text as issue_date,
    coalesce(d.due_date, d.issue_date)::text as due_date, d.payable_cents as total, d.customer_id, d.customer_snapshot,
    case when d.customer_id is not null then 'c:' || d.customer_id::text
         when d.customer_snapshot->>'tin' is not null then 't:' || (d.customer_snapshot->>'tin')
         when d.customer_snapshot->>'name' is not null then 'n:' || lower(d.customer_snapshot->>'name')
         else 'walk-in' end as customer_key,
    coalesce((select sum(p.amount_cents) from invoice_payments p where p.document_id = d.id and p.voided_at is null), 0) as paid,
    coalesce((select sum(c.tax_inclusive_cents) from documents c where c.tenant_id = d.tenant_id and c.referenced_etdui = d.etdui
              and c.etd_type = '04' and c.status in ${CREDIT_STATUSES}), 0) as credited,
    (${TODAY} - coalesce(d.due_date, d.issue_date)) as days_overdue
  from documents d
  where d.tenant_id = $1 and d.etd_type in ('01', '03') and d.status in ${OPEN_STATUSES}
    and not exists (select 1 from orders o where o.document_id = d.id)
    and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;

interface ReceivableRow {
  id: string;
  etd_type: string;
  series_number: number;
  serial: string;
  etdui: string;
  issue_date: string;
  due_date: string;
  total: unknown;
  customer_id: string | null;
  customer_snapshot: { name?: string; tin?: string; contact?: { email?: string; telephone?: string } } | null;
  customer_key: string;
  paid: unknown;
  credited: unknown;
  days_overdue: number;
}

export type InvoiceStatus = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'credit';

function shape(r: ReceivableRow) {
  const total = toBigInt(r.total);
  const paid = toBigInt(r.paid);
  const credited = toBigInt(r.credited);
  const balance = total - paid - credited;
  const status: InvoiceStatus = balance < 0n ? 'credit' : balance === 0n ? 'paid' : r.days_overdue > 0 ? 'overdue' : paid + credited > 0n ? 'partial' : 'unpaid';
  return {
    documentId: r.id,
    type: r.etd_type,
    number: `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    daysOverdue: balance > 0n ? Math.max(0, r.days_overdue) : 0,
    customer: { id: r.customer_id, key: r.customer_key, name: r.customer_snapshot?.name ?? 'Walk-in customer', tin: r.customer_snapshot?.tin ?? null, email: r.customer_snapshot?.contact?.email ?? null },
    total: formatCents(total),
    paid: formatCents(paid),
    credited: formatCents(credited),
    balance: formatCents(balance),
    balanceCents: balance,
    status,
  };
}
export type Receivable = ReturnType<typeof shape>;

export async function receivable(db: Queryable, tenantId: string, documentId: string): Promise<Receivable | null> {
  const r = (await db.query<ReceivableRow>(`select * from (${RECEIVABLES}) x where id = $2`, [tenantId, documentId])).rows[0];
  return r ? shape(r) : null;
}

/** Open invoices (balance not zero), oldest due first; `customerKey` narrows to one customer. */
export async function openReceivables(db: Queryable, tenantId: string, options: { customerKey?: string; includePaid?: boolean } = {}): Promise<Receivable[]> {
  const rows = (await db.query<ReceivableRow>(
    `select * from (${RECEIVABLES}) x where ($2::text is null or customer_key = $2) order by due_date, issue_date, serial`,
    [tenantId, options.customerKey ?? null],
  )).rows.map(shape);
  return options.includePaid ? rows : rows.filter((r) => r.balanceCents !== 0n);
}

/** Payment state for a list of documents (for the documents list). */
export async function statusesFor(db: Queryable, tenantId: string, documentIds: string[]): Promise<Map<string, { status: InvoiceStatus; balance: string; dueDate: string }>> {
  if (!documentIds.length) return new Map();
  const rows = (await db.query<ReceivableRow>(`select * from (${RECEIVABLES}) x where id = any($2::uuid[])`, [tenantId, documentIds])).rows.map(shape);
  return new Map(rows.map((r) => [r.documentId, { status: r.status, balance: r.balance, dueDate: r.dueDate }]));
}

// ---------- payments ----------

export interface PaymentRow {
  id: string;
  document_id: string;
  amount_cents: unknown;
  method: PaymentMethod;
  reference: string | null;
  paid_on: string;
  note: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: Date | string;
  voided_at: Date | string | null;
  void_reason: string | null;
}

export const paymentJson = (p: PaymentRow) => ({
  id: p.id,
  documentId: p.document_id,
  amount: formatCents(toBigInt(p.amount_cents)),
  method: p.method,
  reference: p.reference,
  paidOn: String(p.paid_on).slice(0, 10),
  note: p.note,
  recordedBy: p.created_by_name ?? null,
  createdAt: new Date(p.created_at).toISOString(),
  voided: Boolean(p.voided_at),
  voidReason: p.void_reason,
});

export async function paymentsFor(db: Queryable, tenantId: string, documentId: string): Promise<PaymentRow[]> {
  return (await db.query<PaymentRow>(
    `select p.*, p.paid_on::text as paid_on, u.name as created_by_name from invoice_payments p left join users u on u.id = p.created_by
     where p.tenant_id = $1 and p.document_id = $2 order by p.paid_on, p.created_at`,
    [tenantId, documentId],
  )).rows;
}

export interface NewPayment {
  amountCents: bigint;
  method: PaymentMethod;
  reference?: string | null;
  paidOn?: string;
  note?: string | null;
  /** Paid online from the invoice's link (recorded once per online payment). */
  onlinePaymentId?: string;
  /** A bank's own reference for the payment (recorded once per business). */
  externalId?: string;
}

/**
 * Record money received against an invoice (or debit note). Never more than
 * the balance. When it settles the invoice, an "invoice.paid" event goes out.
 */
export async function recordPayment(db: Queryable, tenantId: string, documentId: string, p: NewPayment, userId: string | null, options: { allowOverpay?: boolean; deviceId?: string | null } = {}): Promise<{ payment: PaymentRow; receivable: Receivable }> {
  const before = await receivable(db, tenantId, documentId);
  if (!before) throw new ReceivableError('Only an authorized tax invoice or debit note takes payments');
  if (p.method !== 'refund') {
    if (p.amountCents <= 0n) throw new ReceivableError('The amount must be more than zero');
    if (!options.allowOverpay && p.amountCents > before.balanceCents) {
      throw new ReceivableError(before.balanceCents <= 0n ? 'This invoice is already paid' : `That is more than the balance of BZ$${before.balance}`);
    }
  }
  const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const paidOn = p.paidOn ?? today;
  if (paidOn > today) throw new ReceivableError('A payment cannot be dated in the future');
  if (paidOn < before.issueDate) throw new ReceivableError('A payment cannot be dated before the invoice');
  const id = randomUUID();
  const inserted = await db.query(
    `insert into invoice_payments (id, tenant_id, document_id, amount_cents, method, reference, paid_on, note, created_by, online_payment_id, external_id, shift_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       ${openShiftSql('$2', '$9', '$12')})
     on conflict do nothing returning id`,
    [id, tenantId, documentId, String(p.amountCents), p.method, p.reference?.trim() || null, paidOn, p.note?.trim() || null, userId, p.onlinePaymentId ?? null, p.externalId ?? null, options.deviceId ?? null],
  );
  if (!inserted.rows.length) throw new ReceivableError('This payment is already recorded');
  const after = (await receivable(db, tenantId, documentId))!;
  if (before.balanceCents > 0n && after.balanceCents <= 0n) {
    await db.query("insert into event_outbox (tenant_id, type, subject_id) values ($1, 'invoice.paid', $2)", [tenantId, documentId]);
  }
  const payment = (await paymentsFor(db, tenantId, documentId)).find((x) => x.id === id)!;
  return { payment, receivable: after };
}

export async function voidPayment(db: Queryable, tenantId: string, paymentId: string, reason: string, userId: string | null): Promise<PaymentRow> {
  const row = (await db.query<PaymentRow>(
    "update invoice_payments set voided_at = now(), voided_by = $3, void_reason = $4 where id = $1 and tenant_id = $2 and voided_at is null returning *, paid_on::text as paid_on",
    [paymentId, tenantId, userId, reason.trim()],
  )).rows[0];
  if (!row) throw new ReceivableError('Only a recorded payment can be voided');
  return row;
}

// ---------- the overview, ageing, statements ----------

export async function receivablesSummary(db: Queryable, tenantId: string) {
  const open = await openReceivables(db, tenantId);
  const owed = open.filter((r) => r.balanceCents > 0n);
  const sum = (rows: Receivable[]) => formatCents(rows.reduce((a, r) => a + r.balanceCents, 0n));
  const collected = (await db.query<{ cents: unknown }>(
    `select coalesce(sum(amount_cents), 0) as cents from invoice_payments where tenant_id = $1 and voided_at is null
     and paid_on >= date_trunc('month', ${TODAY})::date`,
    [tenantId],
  )).rows[0]!;
  return {
    outstanding: sum(owed),
    overdue: sum(owed.filter((r) => r.daysOverdue > 0)),
    dueThisWeek: sum(owed.filter((r) => r.daysOverdue <= 0 && r.daysOverdue >= -7 && daysUntil(r.dueDate) <= 7)),
    collectedThisMonth: formatCents(toBigInt(collected.cents)),
    openInvoices: owed.length,
    overdueInvoices: owed.filter((r) => r.daysOverdue > 0).length,
    customersOwing: new Set(owed.map((r) => r.customer.key)).size,
  };
}

function daysUntil(isoDate: string): number {
  const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  return Math.round((Date.parse(isoDate) - Date.parse(today)) / 86_400_000);
}

export const AGE_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
export const bucketOf = (daysOverdue: number): AgeBucket => (daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+');

/** What each customer owes, by how late it is. */
export async function ageing(db: Queryable, tenantId: string) {
  const owed = (await openReceivables(db, tenantId)).filter((r) => r.balanceCents > 0n);
  const zero = () => Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0n])) as Record<AgeBucket, bigint>;
  const byCustomer = new Map<string, { key: string; id: string | null; name: string; tin: string | null; email: string | null; buckets: Record<AgeBucket, bigint>; total: bigint; invoices: number; oldestDue: string }>();
  const totals = zero();
  for (const r of owed) {
    const c = byCustomer.get(r.customer.key) ?? { key: r.customer.key, id: r.customer.id, name: r.customer.name, tin: r.customer.tin, email: r.customer.email, buckets: zero(), total: 0n, invoices: 0, oldestDue: r.dueDate };
    const b = bucketOf(r.daysOverdue);
    c.buckets[b] += r.balanceCents;
    c.total += r.balanceCents;
    c.invoices++;
    if (r.dueDate < c.oldestDue) c.oldestDue = r.dueDate;
    if (!c.email && r.customer.email) c.email = r.customer.email;
    byCustomer.set(r.customer.key, c);
    totals[b] += r.balanceCents;
  }
  const money = (b: Record<AgeBucket, bigint>) => Object.fromEntries(AGE_BUCKETS.map((k) => [k, formatCents(b[k])])) as Record<AgeBucket, string>;
  const customers = [...byCustomer.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
  return {
    customers: customers.map((c) => ({ key: c.key, id: c.id, name: c.name, tin: c.tin, email: c.email, invoices: c.invoices, oldestDue: c.oldestDue, buckets: money(c.buckets), total: formatCents(c.total) })),
    totals: { ...money(totals), total: formatCents(AGE_BUCKETS.reduce((a, k) => a + totals[k], 0n)) },
  };
}

/** A customer's statement: open invoices, recent payments, what they owe. */
export async function statement(db: Queryable, tenantId: string, customerKey: string) {
  const all = await openReceivables(db, tenantId, { customerKey, includePaid: true });
  if (!all.length) throw new ReceivableError('No invoices for this customer');
  const open = all.filter((r) => r.balanceCents !== 0n);
  const ids = all.map((r) => r.documentId);
  const payments = (await db.query<PaymentRow & { number: string }>(
    `select p.*, p.paid_on::text as paid_on, lpad(d.series_number::text, 3, '0') || '-' || lpad(d.serial::text, 9, '0') as number
     from invoice_payments p join documents d on d.id = p.document_id
     where p.tenant_id = $1 and p.document_id = any($2::uuid[]) and p.voided_at is null and p.paid_on >= ${TODAY} - 90
     order by p.paid_on desc limit 50`,
    [tenantId, ids],
  )).rows;
  const latest = all[all.length - 1]!;
  const owed = open.reduce((a, r) => a + r.balanceCents, 0n);
  return {
    customer: { ...latest.customer },
    asOf: new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10),
    open,
    payments: payments.map((p) => ({ ...paymentJson(p), number: p.number })),
    totalDue: formatCents(owed),
    overdue: formatCents(open.filter((r) => r.daysOverdue > 0).reduce((a, r) => a + r.balanceCents, 0n)),
  };
}

// ---------- upkeep ----------

/** Older invoices have no due date column yet: read it from the signed XML (a little at a time). */
export async function backfillDueDates(db: Queryable, limit = 200): Promise<number> {
  const rows = (await db.query<{ id: string; signed_xml: string; issue_date: string }>(
    "select id, signed_xml, issue_date::text as issue_date from documents where due_date is null and etd_type in ('01', '03') limit $1", [limit],
  )).rows;
  for (const r of rows) {
    let due = r.issue_date;
    try {
      due = readEtdForPrint(r.signed_xml).payment?.dueDate ?? r.issue_date;
    } catch {
      // An unreadable document keeps its issue date as its due date.
    }
    await db.query('update documents set due_date = $2 where id = $1 and due_date is null', [r.id, due]);
  }
  return rows.length;
}
