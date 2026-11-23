/**
 * The platform console's front page: how the whole service is doing, for the
 * people who run it. Growth, documents issued, the online stores, revenue,
 * system health, and the businesses that need a person.
 *
 *   GET /v1/platform/overview
 *
 * Read-only and across every business (staff only, behind the console's
 * sign-in). Counts of documents are BTS production unless they say test.
 */

import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import { type PlanCode, PLANS } from '../billing/plans.ts';
import { opsStatus } from '../ops/monitoring.ts';

const COUNTED = ['authorized', 'authorized_with_alert', 'contingency_pending'];

export type AttentionKind = 'certificate_expired' | 'certificate_expiring' | 'documents_stuck' | 'outage' | 'webhooks_failing' | 'invoice_overdue' | 'trial_ending';

export interface Attention {
  kind: AttentionKind;
  tenant: { id: string; name: string; slug: string };
  /** Problems first, then reminders. */
  severity: 'problem' | 'reminder';
  /** How many (documents, deliveries, invoices), when it counts something. */
  n?: number;
  /** When (ISO): expiry, since, due, trial end. */
  at?: string;
  /** Days left, for a certificate. */
  days?: number;
  /** An amount (BZ$), for overdue invoices. */
  amount?: string;
}

/** Monday of the week of `d` (UTC), as YYYY-MM-DD. */
function weekOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

export async function platformOverview(db: Queryable, now = new Date()) {
  const health = await opsStatus(db);

  const b = (await db.query<{ total: number; production: number; new7: number; new30: number; active30: number; stores: number }>(
    `select count(*)::int as total,
       count(*) filter (where environment = 'production')::int as production,
       count(*) filter (where created_at >= $1::timestamptz - interval '7 days')::int as new7,
       count(*) filter (where created_at >= $1::timestamptz - interval '30 days')::int as new30,
       count(*) filter (where exists (select 1 from documents d where d.tenant_id = t.id and d.created_at >= $1::timestamptz - interval '30 days'))::int as active30,
       count(*) filter (where coalesce(store_settings->>'enabled', 'false') = 'true')::int as stores
     from tenants t`,
    [now],
  )).rows[0]!;

  // New businesses each week, the last 12 weeks (this one included).
  const firstWeek = new Date(`${weekOf(now)}T00:00:00Z`);
  firstWeek.setUTCDate(firstWeek.getUTCDate() - 7 * 11);
  const signupRows = (await db.query<{ week: string; n: number }>(
    `select to_char(date_trunc('week', created_at at time zone 'UTC'), 'YYYY-MM-DD') as week, count(*)::int as n
     from tenants where created_at >= $1 group by 1`,
    [firstWeek],
  )).rows;
  const signups = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(firstWeek);
    d.setUTCDate(d.getUTCDate() + 7 * i);
    const week = d.toISOString().slice(0, 10);
    return { week, count: signupRows.find((r) => r.week === week)?.n ?? 0 };
  });

  const docs = (await db.query<{ today: number; last30: number; value30: unknown; test30: number; rejected30: number; prev30: number }>(
    `select
       count(*) filter (where reception_env = '01' and status = any($2::text[]) and created_at >= date_trunc('day', $1::timestamptz))::int as today,
       count(*) filter (where reception_env = '01' and status = any($2::text[]) and created_at >= $1::timestamptz - interval '30 days')::int as last30,
       coalesce(sum(case when etd_type = '04' then -tax_inclusive_cents else tax_inclusive_cents end) filter (where reception_env = '01' and status = any($2::text[]) and created_at >= $1::timestamptz - interval '30 days'), 0) as value30,
       count(*) filter (where reception_env = '02' and created_at >= $1::timestamptz - interval '30 days')::int as test30,
       count(*) filter (where status = 'rejected' and created_at >= $1::timestamptz - interval '30 days')::int as rejected30,
       count(*) filter (where reception_env = '01' and status = any($2::text[]) and created_at >= $1::timestamptz - interval '60 days' and created_at < $1::timestamptz - interval '30 days')::int as prev30
     from documents where created_at >= $1::timestamptz - interval '60 days'`,
    [now, COUNTED],
  )).rows[0]!;

  const store = (await db.query<{ orders30: number; paid30: unknown }>(
    `select count(*)::int as orders30, coalesce(sum(total_cents) filter (where payment_status = 'paid'), 0) as paid30
     from orders where created_at >= $1::timestamptz - interval '30 days' and status <> 'cancelled'`,
    [now],
  )).rows[0]!;

  const subs = (await db.query<{ plan: PlanCode; status: string; n: number }>('select plan, status, count(*)::int as n from subscriptions group by plan, status')).rows;
  const count = (status: string) => subs.filter((x) => x.status === status).reduce((a, x) => a + x.n, 0);
  const mrr = subs.filter((x) => x.status !== 'trialing' && x.status !== 'suspended').reduce((a, x) => a + parseCents(PLANS[x.plan].price) * BigInt(x.n), 0n);
  const invoices = (await db.query<{ open: unknown; overdue: unknown }>(
    `select coalesce(sum(total_cents), 0) as open, coalesce(sum(total_cents) filter (where due_at < $1), 0) as overdue from billing_invoices where status = 'open'`,
    [now],
  )).rows[0]!;

  // The busiest businesses this month (production documents).
  const top = (await db.query<{ id: string; name: string; slug: string; n: number; value: unknown }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, count(*)::int as n,
       coalesce(sum(case when d.etd_type = '04' then -d.tax_inclusive_cents else d.tax_inclusive_cents end), 0) as value
     from documents d join tenants t on t.id = d.tenant_id
     where d.reception_env = '01' and d.status = any($2::text[]) and d.created_at >= $1::timestamptz - interval '30 days'
     group by t.id order by count(*) desc limit 5`,
    [now, COUNTED],
  )).rows;

  const newest = (await db.query<{ id: string; name: string; slug: string; environment: 'test' | 'production'; created_at: Date }>(
    `select id, coalesce(trade_name, legal_name) as name, slug, environment, created_at from tenants order by created_at desc limit 5`,
  )).rows;

  // Who needs a person, most urgent first.
  const attention: Attention[] = [];
  const tenantOf = (r: { id: string; name: string; slug: string }) => ({ id: r.id, name: r.name, slug: r.slug });
  for (const r of (await db.query<{ id: string; name: string; slug: string; valid_to: Date }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, c.valid_to from certificates c join tenants t on t.id = c.tenant_id
     where c.status = 'active' and c.valid_to < $1::timestamptz + interval '30 days' order by c.valid_to limit 50`,
    [now],
  )).rows) {
    const days = Math.ceil((new Date(r.valid_to).getTime() - now.getTime()) / 86_400_000);
    attention.push(days < 0
      ? { kind: 'certificate_expired', tenant: tenantOf(r), at: new Date(r.valid_to).toISOString(), severity: 'problem' }
      : { kind: 'certificate_expiring', tenant: tenantOf(r), at: new Date(r.valid_to).toISOString(), days, severity: days <= 7 ? 'problem' : 'reminder' });
  }
  for (const r of (await db.query<{ id: string; name: string; slug: string; n: number; oldest: Date }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, count(*)::int as n, min(d.created_at) as oldest
     from documents d join tenants t on t.id = d.tenant_id
     where d.status = 'pending' and d.created_at < $1::timestamptz - interval '15 minutes' group by t.id order by min(d.created_at) limit 50`,
    [now],
  )).rows) {
    attention.push({ kind: 'documents_stuck', tenant: tenantOf(r), n: r.n, at: new Date(r.oldest).toISOString(), severity: 'problem' });
  }
  for (const r of (await db.query<{ id: string; name: string; slug: string; started_at: Date; queued: number }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, p.started_at,
       (select count(*)::int from documents d where d.tenant_id = t.id and d.status = 'contingency_pending') as queued
     from contingency_periods p join tenants t on t.id = p.tenant_id where p.ended_at is null order by p.started_at limit 50`,
  )).rows) {
    attention.push({ kind: 'outage', tenant: tenantOf(r), n: r.queued, at: new Date(r.started_at).toISOString(), severity: 'problem' });
  }
  for (const r of (await db.query<{ id: string; name: string; slug: string; n: number }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, count(*)::int as n
     from webhook_deliveries w join tenants t on t.id = w.tenant_id
     where w.status = 'failed' and w.created_at >= $1::timestamptz - interval '7 days' group by t.id order by count(*) desc limit 20`,
    [now],
  )).rows) {
    attention.push({ kind: 'webhooks_failing', tenant: tenantOf(r), n: r.n, severity: 'reminder' });
  }
  for (const r of (await db.query<{ id: string; name: string; slug: string; n: number; total: unknown; due_at: Date }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, count(*)::int as n, sum(i.total_cents) as total, min(i.due_at) as due_at
     from billing_invoices i join tenants t on t.id = i.tenant_id where i.status = 'open' and i.due_at < $1 group by t.id order by min(i.due_at) limit 50`,
    [now],
  )).rows) {
    attention.push({ kind: 'invoice_overdue', tenant: tenantOf(r), n: r.n, amount: formatCents(toBigInt(r.total)), at: new Date(r.due_at).toISOString(), severity: 'reminder' });
  }
  for (const r of (await db.query<{ id: string; name: string; slug: string; trial_ends_at: Date }>(
    `select t.id, coalesce(t.trade_name, t.legal_name) as name, t.slug, s.trial_ends_at from subscriptions s join tenants t on t.id = s.tenant_id
     where s.status = 'trialing' and s.trial_ends_at between $1::timestamptz and $1::timestamptz + interval '7 days' order by s.trial_ends_at limit 50`,
    [now],
  )).rows) {
    attention.push({ kind: 'trial_ending', tenant: tenantOf(r), at: new Date(r.trial_ends_at).toISOString(), severity: 'reminder' });
  }
  attention.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'problem' ? -1 : 1));

  const pct = (a: number, z: number) => (z === 0 ? null : Math.round(((a - z) / z) * 100));
  return {
    asOf: now.toISOString(),
    health: {
      status: health.status,
      worker: health.worker,
      queue: health.queue,
      certificates: health.certificates,
      problems: health.problems,
    },
    businesses: { ...b, signups },
    documents: { today: docs.today, last30: docs.last30, value30: formatCents(toBigInt(docs.value30)), test30: docs.test30, rejected30: docs.rejected30, change: pct(docs.last30, docs.prev30) },
    store: { open: b.stores, orders30: store.orders30, paid30: formatCents(toBigInt(store.paid30)) },
    billing: {
      mrr: formatCents(mrr), active: count('active'), trialing: count('trialing'), pastDue: count('past_due'), suspended: count('suspended'),
      openAmount: formatCents(toBigInt(invoices.open)), overdueAmount: formatCents(toBigInt(invoices.overdue)),
    },
    top: top.map((r) => ({ tenant: tenantOf(r), documents: r.n, value: formatCents(toBigInt(r.value)) })),
    newest: newest.map((r) => ({ tenant: tenantOf(r), environment: r.environment, createdAt: new Date(r.created_at).toISOString() })),
    attention: attention.slice(0, 50),
  };
}
