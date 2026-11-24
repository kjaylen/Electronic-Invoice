/**
 * The daily summary: each morning, owners and admins of businesses that turned it on get
 * yesterday at a glance: sales and GST (against the same day last week), how customers paid,
 * the best sellers, discounts given, cash drawer differences, what customers owe, what is
 * running low, bills to pay and late purchase orders, and anything BTS rejected. Days with nothing sold and nothing paid send nothing.
 *
 * Sent once a day per business (its key is claimed in notifications_sent first), from 7 am
 * Belize time, for the day before. Safe to run from several processes at once.
 */

import { toBigInt, type Queryable } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { type Mailer, simpleHtml } from '../mail/mailer.ts';
import { openReceivables } from '../receivables/receivables.ts';
import { recipients } from './notifications.ts';

export interface DailyOptions {
  mailer: Mailer;
  /** Links in the email go here. */
  publicUrl?: string;
  /** For tests: the time now. */
  now?: Date;
  /** Belize hour from which yesterday's summary goes out. Default 7. */
  sendFromHour?: number;
}

const COUNTED = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
const ENV = `(select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
const MEANS = ['cash', 'card', 'bank transfer', 'cheque', 'other'] as const;
type Means = (typeof MEANS)[number];
const meansOf = (code: string | null): Means => (code === '10' ? 'cash' : ['48', '54', '55'].includes(code ?? '') ? 'card' : ['30', '31', '42'].includes(code ?? '') ? 'bank transfer' : code === '20' ? 'cheque' : 'other');
const methodOf = (m: string): Means => (m === 'cash' ? 'cash' : m === 'card' ? 'card' : m === 'bank_transfer' ? 'bank transfer' : m === 'cheque' ? 'cheque' : 'other');

const belizeNow = (d: Date) => new Date(d.getTime() - 6 * 3600_000);
const dayOf = (d: Date, offsetDays = 0) => new Date(belizeNow(d).getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const money = (cents: bigint) => `BZ$${formatCents(cents)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const longDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export interface DailySummary {
  day: string;
  sales: { net: bigint; gst: bigint; receipts: number; invoices: number; creditNotes: number; creditNoteTotal: bigint; lastWeek: bigint };
  taken: Record<Means, bigint>;
  bestSellers: Array<{ name: string; quantity: number; net: bigint }>;
  discounts: { count: number; total: bigint };
  drawers: Array<{ register: string; number: number; difference: bigint }>;
  owed: { total: bigint; overdue: bigint; overdueInvoices: number };
  lowStock: Array<{ name: string; stock: number }>;
  /** Supplier bills unpaid: overdue, and due today or tomorrow. */
  bills: { overdue: number; overdueTotal: bigint; dueSoon: number; dueSoonTotal: bigint };
  /** Purchase orders sent but not all received by the day they were wanted. */
  lateOrders: string[];
  rejected: number;
}

/** What happened on one day (Belize date), in the business's current BTS environment. */
export async function dailySummary(db: Queryable, tenantId: string, day: string): Promise<DailySummary | null> {
  const lastWeekDay = new Date(new Date(`${day}T12:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const sums = async (d: string) => (await db.query<{ etd_type: string; n: number; total: unknown; gst: unknown }>(
    `select etd_type, count(*)::int as n, coalesce(sum(tax_inclusive_cents), 0) as total, coalesce(sum(gst_cents), 0) as gst
     from documents where tenant_id = $1 and issue_date = $2::date and status = any($3::text[]) and reception_env = ${ENV} group by etd_type`,
    [tenantId, d, COUNTED],
  )).rows;
  const signed = (rows: Awaited<ReturnType<typeof sums>>, field: 'total' | 'gst') => rows.reduce((a, r) => a + (r.etd_type === '04' ? -1n : 1n) * toBigInt(r[field]), 0n);
  const today = await sums(day);
  const count = (type: string) => today.find((r) => r.etd_type === type)?.n ?? 0;

  // How customers paid: receipts (each part of a split payment under its means) and payments on invoices.
  const receipts = (await db.query<{ means: string | null; total: unknown }>(
    `select coalesce(t.part ->> 'means', d.payment_means) as means, coalesce(sum(coalesce((t.part ->> 'cents')::bigint, d.payable_cents)), 0) as total
     from documents d left join lateral jsonb_array_elements(coalesce(d.tenders, '[]'::jsonb)) as t(part) on true
     where d.tenant_id = $1 and d.issue_date = $2::date and d.etd_type = '02' and d.status = any($3::text[]) and d.reception_env = ${ENV} group by 1`,
    [tenantId, day, COUNTED],
  )).rows;
  const payments = (await db.query<{ method: string; total: unknown }>(
    'select method, coalesce(sum(amount_cents), 0) as total from invoice_payments where tenant_id = $1 and paid_on = $2::date and voided_at is null group by method',
    [tenantId, day],
  )).rows;
  if (!today.length && !payments.length) return null;
  const taken = Object.fromEntries(MEANS.map((m) => [m, 0n])) as Record<Means, bigint>;
  for (const r of receipts) taken[meansOf(r.means)] += toBigInt(r.total);
  for (const p of payments) taken[methodOf(p.method)] += toBigInt(p.total);

  const sold = (await db.query<{ name: string; quantity: string; net: unknown }>(
    `select l.description as name, sum(l.quantity)::text as quantity, sum(l.net_cents) as net
     from document_lines l join documents d on d.id = l.document_id and d.tenant_id = l.tenant_id
     where d.tenant_id = $1 and d.issue_date = $2::date and d.etd_type in ('01', '02') and d.status = any($3::text[]) and d.reception_env = ${ENV}
     group by l.description order by sum(l.net_cents) desc limit 5`,
    [tenantId, day, COUNTED],
  )).rows;
  const discounts = (await db.query<{ n: number; total: unknown }>(
    `select count(distinct d.id)::int as n, coalesce(sum(greatest(round(l.quantity * l.unit_price * 100)::bigint - l.net_cents, 0)), 0) as total
     from document_lines l join documents d on d.id = l.document_id and d.tenant_id = l.tenant_id
     where d.tenant_id = $1 and d.issue_date = $2::date and d.etd_type in ('01', '02') and d.status = any($3::text[]) and d.reception_env = ${ENV}
       and round(l.quantity * l.unit_price * 100)::bigint > l.net_cents`,
    [tenantId, day, COUNTED],
  )).rows[0]!;
  const drawers = (await db.query<{ register: string; number: number; difference: unknown }>(
    `select r.name as register, s.number, s.counted_cash_cents - s.expected_cash_cents as difference
     from register_shifts s join registers r on r.id = s.register_id
     where s.tenant_id = $1 and (s.closed_at - interval '6 hours')::date = $2::date and s.counted_cash_cents is not null and s.expected_cash_cents is not null
       and s.counted_cash_cents <> s.expected_cash_cents order by s.closed_at`,
    [tenantId, day],
  )).rows;
  const open = (await openReceivables(db, tenantId)).filter((r) => r.balanceCents > 0n);
  const overdue = open.filter((r) => r.daysOverdue > 0);
  const lowStock = (await db.query<{ name: string; stock: string }>(
    `select name, stock_quantity::text as stock from items
     where tenant_id = $1 and archived_at is null and stock_quantity is not null and low_stock is not null and stock_quantity <= low_stock
     order by stock_quantity, name limit 8`,
    [tenantId],
  )).rows;
  // Bills to pay: the morning after `day` is today.
  const morning = new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const bills = (await db.query<{ overdue: number; overdue_total: unknown; soon: number; soon_total: unknown }>(
    `select count(*) filter (where due_date < $2::date)::int as overdue, coalesce(sum(total_cents) filter (where due_date < $2::date), 0) as overdue_total,
       count(*) filter (where due_date between $2::date and $2::date + 1)::int as soon, coalesce(sum(total_cents) filter (where due_date between $2::date and $2::date + 1), 0) as soon_total
     from expenses where tenant_id = $1 and paid_on is null and due_date is not null`,
    [tenantId, morning],
  )).rows[0]!;
  const lateOrders = (await db.query<{ number: number; supplier_name: string }>(
    `select number, supplier_name from purchase_orders where tenant_id = $1 and status in ('sent', 'partial') and expected_on < $2::date order by expected_on, number limit 5`,
    [tenantId, morning],
  )).rows;
  // Rejected and not issued again since.
  const rejected = (await db.query<{ n: number }>(
    `select count(*)::int as n from documents d where d.tenant_id = $1 and d.issue_date = $2::date and d.status = 'rejected'
       and not exists (select 1 from documents s where s.tenant_id = d.tenant_id and s.supersedes_document_id = d.id)`,
    [tenantId, day],
  )).rows[0]!.n;

  return {
    day,
    sales: {
      net: signed(today, 'total'), gst: signed(today, 'gst'), receipts: count('02'), invoices: count('01'), creditNotes: count('04'),
      creditNoteTotal: toBigInt(today.find((r) => r.etd_type === '04')?.total ?? 0), lastWeek: signed(await sums(lastWeekDay), 'total'),
    },
    taken,
    bestSellers: sold.map((s) => ({ name: s.name, quantity: Number(s.quantity), net: toBigInt(s.net) })),
    discounts: { count: discounts.n, total: toBigInt(discounts.total) },
    drawers: drawers.map((d) => ({ register: d.register, number: d.number, difference: toBigInt(d.difference) })),
    owed: { total: open.reduce((a, r) => a + r.balanceCents, 0n), overdue: overdue.reduce((a, r) => a + r.balanceCents, 0n), overdueInvoices: overdue.length },
    lowStock: lowStock.map((i) => ({ name: i.name, stock: Number(i.stock) })),
    bills: { overdue: bills.overdue, overdueTotal: toBigInt(bills.overdue_total), dueSoon: bills.soon, dueSoonTotal: toBigInt(bills.soon_total) },
    lateOrders: lateOrders.map((o) => `PO-${o.number} (${o.supplier_name})`),
    rejected,
  };
}

/** The summary as the email's paragraphs. */
export function summaryParagraphs(s: DailySummary): string[] {
  const p: string[] = [];
  const docs = [s.sales.receipts && plural(s.sales.receipts, 'receipt', 'receipts'), s.sales.invoices && plural(s.sales.invoices, 'invoice', 'invoices')].filter(Boolean).join(' and ');
  let compare = '';
  if (s.sales.lastWeek > 0n) {
    const change = Number(((s.sales.net - s.sales.lastWeek) * 1000n) / s.sales.lastWeek) / 10;
    const weekday = new Date(`${s.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    compare = change === 0 ? `, the same as last ${weekday}` : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on last ${weekday}`;
  }
  p.push(`Sales: ${money(s.sales.net)}${docs ? ` from ${docs}` : ''}${compare}. GST: ${money(s.sales.gst)}.`);
  if (s.sales.creditNotes) p.push(`Credit notes: ${plural(s.sales.creditNotes, 'note', 'notes')} for ${money(s.sales.creditNoteTotal)} (already taken off).`);
  const taken = MEANS.filter((m) => s.taken[m] !== 0n).map((m) => `${m} ${money(s.taken[m])}`);
  if (taken.length) p.push(`Taken: ${taken.join(', ')}.`);
  if (s.bestSellers.length) p.push(`Best sellers: ${s.bestSellers.map((b) => `${b.name} (${b.quantity % 1 === 0 ? b.quantity : b.quantity.toFixed(2)}, ${money(b.net)})`).join(', ')}.`);
  if (s.discounts.count) p.push(`Discounts given: ${money(s.discounts.total)} on ${plural(s.discounts.count, 'sale', 'sales')}.`);
  for (const d of s.drawers) p.push(`Cash drawer: ${d.register}, shift ${d.number}, was ${money(d.difference < 0n ? -d.difference : d.difference)} ${d.difference < 0n ? 'short' : 'over'}.`);
  if (s.owed.total > 0n) p.push(`Customers owe ${money(s.owed.total)}${s.owed.overdueInvoices ? `, of which ${money(s.owed.overdue)} is overdue (${plural(s.owed.overdueInvoices, 'invoice', 'invoices')})` : ''}.`);
  if (s.lowStock.length) p.push(`Running low: ${s.lowStock.map((i) => `${i.name} (${i.stock} left)`).join(', ')}.`);
  const bills = [s.bills.dueSoon && `${plural(s.bills.dueSoon, 'bill', 'bills')} for ${money(s.bills.dueSoonTotal)} due by tomorrow`, s.bills.overdue && `${plural(s.bills.overdue, 'bill', 'bills')} for ${money(s.bills.overdueTotal)} overdue`].filter(Boolean);
  if (bills.length) p.push(`Bills to pay: ${bills.join('; ')}.`);
  if (s.lateOrders.length) p.push(`Late deliveries: ${s.lateOrders.join(', ')}.`);
  if (s.rejected) p.push(`Needs attention: BTS rejected ${plural(s.rejected, 'document', 'documents')}.`);
  return p;
}

export async function runDailySummaries(db: Queryable, options: DailyOptions): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const result = { sent: 0, failed: 0 };
  if (belizeNow(now).getUTCHours() < (options.sendFromHour ?? 7)) return result;
  const day = dayOf(now, -1);
  const tenants = (await db.query<{ id: string; slug: string; name: string; email: string }>(
    'select id, slug, coalesce(trade_name, legal_name) as name, email from tenants where daily_summary and closed_at is null',
  )).rows;
  for (const t of tenants) {
    const key = `daily-summary:${t.id}:${day}`;
    const claimed = await db.query('insert into notifications_sent (key, tenant_id) values ($1, $2) on conflict do nothing returning key', [key, t.id]);
    if (!claimed.rows.length) continue;
    try {
      const summary = await dailySummary(db, t.id, day);
      if (!summary) continue; // a quiet day: nothing to send (and nothing to send later)
      const url = options.publicUrl ? `${options.publicUrl.replace(/\/$/, '')}/${t.slug}/reports` : undefined;
      const paragraphs = summaryParagraphs(summary);
      const footer = `You get this summary because you are an owner or admin of ${t.name}. Turn it off in Settings, Business.`;
      const subject = `${t.name}: ${money(summary.sales.net)} in sales ${longDay(day)}`;
      const html = simpleHtml({ heading: longDay(day), paragraphs, footer: [footer], ...(url && { button: { label: 'Open the reports', url } }) });
      const text = [longDay(day), ...paragraphs, ...(url ? [url] : []), '', footer].join('\n\n');
      for (const to of await recipients(db, { id: t.id, slug: t.slug, name: t.name, email: t.email })) {
        await options.mailer.send({ type: 'daily-summary', tenantId: t.id, to, subject, text, html, replyTo: t.email });
      }
      result.sent++;
    } catch {
      await db.query('delete from notifications_sent where key = $1', [key]).catch(() => {});
      result.failed++;
    }
  }
  return result;
}
