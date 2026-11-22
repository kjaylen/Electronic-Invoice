/**
 * Each business's subscription to the platform: its plan, its trial, what it
 * may use, and the invoices the platform sends it.
 *
 * Lifecycle: a new business starts a 30-day trial (Business plan). When the
 * trial ends, a paid plan is invoiced for the first month (due in 14 days);
 * every month after, the next month is invoiced. An unpaid invoice past its
 * due date makes the subscription "past_due" (a reminder is sent); 14 days
 * later it is "suspended": no new production documents can be issued.
 * Everything already issued stays readable, printable and exportable, always.
 *
 * The platform's invoices are real BTS e-invoices, issued by the platform's own
 * business (PLATFORM_BILLING_TENANT) to the subscriber. Without one configured,
 * invoices are still recorded and paid, just without an e-invoice.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { calculateDocument } from '../engine/calc.ts';
import { formatCents } from '../engine/decimal.ts';
import { BELIZE_DISTRICTS, type DistrictCode } from '../engine/ubl.ts';
import { issueDocument, type IssueRequest, type PipelineDeps } from '../pipeline/issue.ts';
import { type Feature, FEATURE_NAMES, hasFeature, PAYMENT_TERMS_DAYS, type PlanCode, planWith, PLANS, SUSPEND_AFTER_OVERDUE_DAYS, TRIAL_DAYS } from './plans.ts';

export class BillingError extends Error {
  override name = 'BillingError';
  readonly code: 'plan_limit' | 'plan_feature' | 'billing_suspended' | 'invalid_plan';
  constructor(code: BillingError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended';

export interface Subscription {
  tenantId: string;
  plan: PlanCode;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextPlan: PlanCode | null;
}

interface SubRow {
  tenant_id: string;
  plan: PlanCode;
  status: SubscriptionStatus;
  trial_ends_at: Date | string | null;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
  next_plan: PlanCode | null;
}

const date = (v: Date | string | null) => (v ? new Date(v) : null);
const toSub = (r: SubRow): Subscription => ({
  tenantId: r.tenant_id,
  plan: r.plan,
  status: r.status,
  trialEndsAt: date(r.trial_ends_at),
  currentPeriodStart: date(r.current_period_start),
  currentPeriodEnd: date(r.current_period_end),
  nextPlan: r.next_plan,
});

export function addMonth(d: Date): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCMonth(out.getUTCMonth() + 1);
  // 31 January + 1 month is the end of February, not 3 March.
  if (out.getUTCDate() < day) out.setUTCDate(0);
  return out;
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** The business's subscription; a business without one starts its trial now. */
export async function getSubscription(db: Queryable, tenantId: string): Promise<Subscription> {
  const row = (await db.query<SubRow>('select * from subscriptions where tenant_id = $1', [tenantId])).rows[0];
  if (row) return toSub(row);
  await db.query(
    `insert into subscriptions (tenant_id, plan, status, trial_ends_at) values ($1, 'business', 'trialing', now() + make_interval(days => $2))
     on conflict (tenant_id) do nothing`,
    [tenantId, TRIAL_DAYS],
  );
  return toSub((await db.query<SubRow>('select * from subscriptions where tenant_id = $1', [tenantId])).rows[0]!);
}

// ---------- usage and limits ----------

export interface Usage {
  /** Production documents this calendar month (Belize time). */
  documents: number;
  users: number;
}

export async function usage(db: Queryable, tenantId: string): Promise<Usage> {
  const r = (await db.query<{ documents: number; users: number }>(
    `select
       (select count(*)::int from documents where tenant_id = $1 and reception_env = '01'
          and status not in ('rejected', 'superseded')
          and issue_date >= date_trunc('month', now() - interval '6 hours')::date) as documents,
       (select count(*)::int from users where tenant_id = $1 and status = 'active') as users`,
    [tenantId],
  )).rows[0]!;
  return r;
}

const isProduction = async (db: Queryable, tenantId: string) =>
  (await db.query<{ environment: string }>('select environment from tenants where id = $1', [tenantId])).rows[0]?.environment === 'production';

/** Refuse a new production document when issuing is suspended or the month's limit is reached. Test documents are always allowed. */
export async function assertCanIssue(db: Queryable, tenantId: string): Promise<void> {
  if (!(await isProduction(db, tenantId))) return;
  const sub = await getSubscription(db, tenantId);
  if (sub.status === 'suspended') {
    throw new BillingError('billing_suspended', 'Issuing is paused because an invoice for your plan is overdue. Pay it (Settings → Plan) and issuing resumes at once. Your documents stay available.');
  }
  const limit = PLANS[sub.plan].documentsPerMonth;
  if (limit !== null && (await usage(db, tenantId)).documents >= limit) {
    throw new BillingError('plan_limit', `Your ${PLANS[sub.plan].name} plan includes ${limit} documents a month, and they are used up. Upgrade in Settings → Plan to keep issuing this month.`);
  }
}

export async function assertFeature(db: Queryable, tenantId: string, feature: Feature): Promise<void> {
  const sub = await getSubscription(db, tenantId);
  if (!hasFeature(sub.plan, feature)) {
    throw new BillingError('plan_feature', `Your ${PLANS[sub.plan].name} plan does not include ${FEATURE_NAMES[feature]}. It comes with the ${planWith(feature).name} plan (Settings → Plan).`);
  }
}

export async function assertCanAddUser(db: Queryable, tenantId: string): Promise<void> {
  const sub = await getSubscription(db, tenantId);
  const limit = PLANS[sub.plan].users;
  if (limit !== null && (await usage(db, tenantId)).users >= limit) {
    throw new BillingError('plan_limit', `Your ${PLANS[sub.plan].name} plan includes ${limit} accounts. Deactivate one, or upgrade in Settings → Plan.`);
  }
}

// ---------- invoices ----------

export interface BillingInvoiceRow {
  id: string;
  tenant_id: string;
  plan: PlanCode;
  period_start: Date | string;
  period_end: Date | string;
  net_cents: unknown;
  gst_cents: unknown;
  total_cents: unknown;
  status: 'open' | 'paid' | 'void';
  due_at: Date | string;
  document_id: string | null;
  paid_at: Date | string | null;
  paid_reference: string | null;
  created_at: Date | string;
}

export function invoiceJson(r: BillingInvoiceRow, now = new Date()) {
  return {
    id: r.id,
    plan: r.plan,
    planName: PLANS[r.plan]?.name ?? r.plan,
    periodStart: new Date(r.period_start).toISOString(),
    periodEnd: new Date(r.period_end).toISOString(),
    net: formatCents(toBigInt(r.net_cents)),
    gst: formatCents(toBigInt(r.gst_cents)),
    total: formatCents(toBigInt(r.total_cents)),
    status: r.status,
    overdue: r.status === 'open' && new Date(r.due_at) < now,
    dueAt: new Date(r.due_at).toISOString(),
    documentId: r.document_id,
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    paidReference: r.paid_reference,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export interface BillingContext {
  deps: PipelineDeps;
  /** The platform's own business, which issues the e-invoices. */
  billingTenantId?: string;
  /** Called with each new invoice (to email it). */
  onInvoice?: (invoice: BillingInvoiceRow, documentId: string | null) => Promise<void>;
}

const monthLabel = (d: Date) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'America/Belize' });

/** The platform's invoice for one period. Idempotent: one invoice per business per period start. */
export async function createInvoice(ctx: BillingContext, tenantId: string, plan: PlanCode, periodStart: Date, periodEnd: Date): Promise<BillingInvoiceRow | null> {
  const { db } = ctx.deps;
  const line = lineFor(plan, periodStart);
  const t = calculateDocument({ lines: [line] }, ctx.deps.tax);
  const id = randomUUID();
  const due = addDays(new Date(Math.max(periodStart.getTime(), Date.now())), PAYMENT_TERMS_DAYS);
  const inserted = (await db.query<BillingInvoiceRow>(
    `insert into billing_invoices (id, tenant_id, plan, period_start, period_end, net_cents, gst_cents, total_cents, status, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
     on conflict (tenant_id, period_start) do nothing returning *`,
    [id, tenantId, plan, periodStart.toISOString(), periodEnd.toISOString(), String(t.lineExtensionAmount), String(t.gstAmount), String(t.taxInclusiveAmount), due.toISOString()],
  )).rows[0];
  if (!inserted) return null;

  const documentId = await issueForInvoice(ctx, inserted, line, due).catch(() => null);
  const row = { ...inserted, document_id: documentId };
  await ctx.onInvoice?.(row, documentId).catch(() => {});
  return row;
}

const lineFor = (plan: PlanCode, periodStart: Date) => ({ description: `eInvoicing ${PLANS[plan].name} plan, ${monthLabel(periodStart)}`, quantity: '1', unitCode: 'MON', unitPrice: PLANS[plan].price, gstCategory: 'S' as const });

/** The platform business's e-invoice for a billing invoice; null when there is no billing business. */
async function issueForInvoice(ctx: BillingContext, invoice: BillingInvoiceRow, line: ReturnType<typeof lineFor>, due: Date): Promise<string | null> {
  if (!ctx.billingTenantId || ctx.billingTenantId === invoice.tenant_id) return null;
  const { db } = ctx.deps;
  const c = (await db.query<{ legal_name: string; tin: string; street: string; city: string; district_code: DistrictCode; email: string; telephone: string }>(
    'select legal_name, tin, street, city, district_code, email, telephone from tenants where id = $1', [invoice.tenant_id],
  )).rows[0]!;
  const request: IssueRequest = {
    etdType: '01',
    customer: {
      name: c.legal_name,
      tin: c.tin,
      address: { street: c.street, city: c.city, districtCode: c.district_code, districtName: BELIZE_DISTRICTS[c.district_code] },
      contact: { email: c.email, telephone: c.telephone },
    },
    lines: [line],
    payment: { meansCode: '30', dueDate: due.toISOString().slice(0, 10), terms: `Due in ${PAYMENT_TERMS_DAYS} days` },
    note: `Subscription ${monthLabel(new Date(invoice.period_start))}. Invoice ${invoice.id.slice(0, 8)}.`,
  };
  const result = await issueDocument(ctx.deps, ctx.billingTenantId, request);
  await db.query('update billing_invoices set document_id = $2 where id = $1', [invoice.id, result.documentId]);
  return result.documentId;
}

/** Issue an invoice's e-invoice when it has none (or BTS rejected it), e.g. after setting up the billing business. */
export async function issueInvoiceDocument(ctx: BillingContext, invoiceId: string): Promise<BillingInvoiceRow> {
  const { db } = ctx.deps;
  const inv = (await db.query<BillingInvoiceRow & { doc_status: string | null }>(
    'select i.*, d.status as doc_status from billing_invoices i left join documents d on d.id = i.document_id where i.id = $1', [invoiceId],
  )).rows[0];
  if (!inv) throw new BillingError('invalid_plan', 'Invoice not found');
  if (inv.document_id && inv.doc_status && !['rejected', 'superseded'].includes(inv.doc_status)) return inv;
  await issueForInvoice(ctx, inv, lineFor(inv.plan, new Date(inv.period_start)), new Date(inv.due_at));
  return (await db.query<BillingInvoiceRow>('select * from billing_invoices where id = $1', [invoiceId])).rows[0]!;
}

/** Recompute a subscription's status from its open invoices. */
export async function refreshStatus(db: Queryable, tenantId: string, now = new Date()): Promise<SubscriptionStatus> {
  const sub = await getSubscription(db, tenantId);
  if (sub.status === 'trialing') return sub.status;
  const open = (await db.query<{ due_at: Date | string }>("select due_at from billing_invoices where tenant_id = $1 and status = 'open' order by due_at", [tenantId])).rows;
  const oldest = open[0] ? new Date(open[0].due_at) : null;
  const status: SubscriptionStatus = !oldest || oldest >= now ? 'active' : addDays(oldest, SUSPEND_AFTER_OVERDUE_DAYS) < now ? 'suspended' : 'past_due';
  if (status !== sub.status) await db.query('update subscriptions set status = $2, updated_at = now() where tenant_id = $1', [tenantId, status]);
  return status;
}

export async function markInvoicePaid(db: Queryable, invoiceId: string, reference: string): Promise<BillingInvoiceRow | null> {
  const row = (await db.query<BillingInvoiceRow>(
    "update billing_invoices set status = 'paid', paid_at = now(), paid_reference = $2 where id = $1 and status = 'open' returning *", [invoiceId, reference],
  )).rows[0];
  if (row) await refreshStatus(db, row.tenant_id);
  return row ?? null;
}

// ---------- changing plan ----------

/**
 * Upgrades take effect at once (from the free plan, a paid period starts now
 * and is invoiced). Downgrades wait for the end of the period; during the
 * trial any change is immediate.
 */
export async function changePlan(ctx: BillingContext, tenantId: string, plan: PlanCode): Promise<Subscription> {
  const { db } = ctx.deps;
  const sub = await getSubscription(db, tenantId);
  const order = (p: PlanCode) => ['starter', 'business', 'pro'].indexOf(p);
  if (plan === sub.plan) {
    await db.query('update subscriptions set next_plan = null, updated_at = now() where tenant_id = $1', [tenantId]);
  } else if (sub.status === 'trialing') {
    await db.query('update subscriptions set plan = $2, next_plan = null, updated_at = now() where tenant_id = $1', [tenantId, plan]);
  } else if (order(plan) > order(sub.plan)) {
    if (PLANS[sub.plan].price === '0') {
      const start = new Date();
      const end = addMonth(start);
      await db.query(
        'update subscriptions set plan = $2, next_plan = null, current_period_start = $3, current_period_end = $4, updated_at = now() where tenant_id = $1',
        [tenantId, plan, start.toISOString(), end.toISOString()],
      );
      await createInvoice(ctx, tenantId, plan, start, end);
      await refreshStatus(db, tenantId);
    } else {
      await db.query('update subscriptions set plan = $2, next_plan = null, updated_at = now() where tenant_id = $1', [tenantId, plan]);
    }
  } else {
    await db.query('update subscriptions set next_plan = $2, updated_at = now() where tenant_id = $1', [tenantId, plan]);
  }
  return getSubscription(db, tenantId);
}

// ---------- the daily run ----------

export interface BillingRunResult {
  trialsEnded: number;
  renewed: number;
  invoices: number;
  statusChanges: number;
}

/** Move every subscription forward to `now`: end trials, renew periods, apply waiting changes, update statuses. */
export async function runBilling(ctx: BillingContext, now = new Date()): Promise<BillingRunResult> {
  const { db } = ctx.deps;
  const result: BillingRunResult = { trialsEnded: 0, renewed: 0, invoices: 0, statusChanges: 0 };

  const trials = (await db.query<SubRow>("select * from subscriptions where status = 'trialing' and trial_ends_at <= $1", [now.toISOString()])).rows.map(toSub);
  for (const sub of trials) {
    const start = sub.trialEndsAt!;
    const end = addMonth(start);
    const plan = sub.nextPlan ?? sub.plan;
    const moved = await db.query(
      "update subscriptions set status = 'active', plan = $2, next_plan = null, current_period_start = $3, current_period_end = $4, updated_at = now() where tenant_id = $1 and status = 'trialing' returning tenant_id",
      [sub.tenantId, plan, start.toISOString(), end.toISOString()],
    );
    if (!moved.rows.length) continue;
    result.trialsEnded++;
    if (PLANS[plan].price !== '0' && (await createInvoice(ctx, sub.tenantId, plan, start, end))) result.invoices++;
  }

  // Renew every period that has ended (several, if the run was off for a while).
  for (let guard = 0; guard < 24; guard++) {
    const due = (await db.query<SubRow>(
      "select * from subscriptions where status <> 'trialing' and current_period_end is not null and current_period_end <= $1", [now.toISOString()],
    )).rows.map(toSub);
    if (!due.length) break;
    for (const sub of due) {
      const start = sub.currentPeriodEnd!;
      const end = addMonth(start);
      const plan = sub.nextPlan ?? sub.plan;
      const moved = await db.query(
        'update subscriptions set plan = $2, next_plan = null, current_period_start = $3, current_period_end = $4, updated_at = now() where tenant_id = $1 and current_period_end = $5 returning tenant_id',
        [sub.tenantId, plan, start.toISOString(), end.toISOString(), start.toISOString()],
      );
      if (!moved.rows.length) continue;
      result.renewed++;
      if (PLANS[plan].price !== '0' && (await createInvoice(ctx, sub.tenantId, plan, start, end))) result.invoices++;
    }
  }

  const subs = (await db.query<{ tenant_id: string; status: SubscriptionStatus }>("select tenant_id, status from subscriptions where status <> 'trialing'")).rows;
  for (const s of subs) {
    if ((await refreshStatus(db, s.tenant_id, now)) !== s.status) result.statusChanges++;
  }
  return result;
}

// ---------- what the business sees ----------

export async function billingSummary(db: Queryable, tenantId: string) {
  const sub = await getSubscription(db, tenantId);
  const use = await usage(db, tenantId);
  const plan = PLANS[sub.plan];
  const invoices = (await db.query<BillingInvoiceRow>('select * from billing_invoices where tenant_id = $1 order by period_start desc limit 24', [tenantId])).rows;
  const now = new Date();
  const daysLeft = sub.trialEndsAt ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null;
  return {
    plan: sub.plan,
    planName: plan.name,
    status: sub.status,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: sub.status === 'trialing' ? daysLeft : null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    nextPlan: sub.nextPlan,
    features: plan.features,
    usage: { documents: use.documents, documentsLimit: plan.documentsPerMonth, users: use.users, usersLimit: plan.users },
    invoices: invoices.map((i) => invoiceJson(i, now)),
    amountDue: formatCents(invoices.filter((i) => i.status === 'open').reduce((sum, i) => sum + toBigInt(i.total_cents), 0n)),
  };
}
