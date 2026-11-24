/**
 * Business tax, and what is due when.
 *
 * Business tax is paid each month on what the business took in (before GST),
 * at a rate that depends on the kind of receipt: 1.75% for a trade or
 * business, 6% for a profession, 3% for rents. A business says which kinds
 * it has and which item categories belong to each; everything else falls
 * under its first kind. Contract tax its customers withheld comes off.
 *
 *   GET /v1/reports/business-tax?from&to[&format=csv]   the worksheet
 *   GET /v1/reports/business-tax.pdf?from&to
 *   GET /v1/reports/due-dates[?days=45]                 what is coming up: the returns, and the owner's own dates
 *   GET /v1/tax-settings
 *   PUT /v1/tax-settings                                { kinds?, gstReturn?, businessTax?, email?, dates? }
 *
 * Like the GST worksheet, this is a working paper for filing with the Belize
 * Tax Service, not the return itself. Receipts are counted by the issue date
 * of the tax documents (credit notes subtract).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderBusinessTax } from '../render/business-tax.ts';
import { gstReturn } from './accounting.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { COUNTED_STATUSES, csvCell } from './reports.ts';
import { date as dateSchema } from './schemas.ts';

export interface TaxKind { name: string; rate: string; categories: string[] }
export interface OwnDate { id: string; name: string; repeats: 'monthly' | 'yearly' | 'once'; date: string }
export interface TaxSettings {
  /** The kinds of receipts and their rates; the first takes everything no other kind names. */
  kinds: TaxKind[];
  /** The business files a GST return each month (it is registered for GST). */
  gstReturn: boolean;
  /** The business files a business tax return each month. */
  businessTax: boolean;
  /** A reminder by email, once a month, of what is due. */
  email: boolean;
  /** Dates of its own: the trade licence, Social Security, insurance. */
  dates: OwnDate[];
}

export const MAX_KINDS = 6;
export const MAX_OWN_DATES = 20;
/** The day of the month the GST and business tax returns are due, for the month before. */
export const RETURN_DAY = 15;
export const RATE = /^(\d{1,2})(\.\d{1,2})?$/;
/** The rates the Belize Tax Service publishes for the commonest kinds (checked November 2026). */
export const KIND_PRESETS: Array<{ name: string; rate: string }> = [
  { name: 'Trade or business', rate: '1.75' },
  { name: 'Profession or vocation', rate: '6' },
  { name: 'Rents', rate: '3' },
];
const DEFAULT_KIND: TaxKind = { ...KIND_PRESETS[0]!, categories: [] };

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** Settings as stored (or anything a client sent), made whole and tidy. */
export function taxSettings(raw: unknown): TaxSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kinds: TaxKind[] = [];
  const taken = new Set<string>();
  for (const k of Array.isArray(r.kinds) ? r.kinds : []) {
    const name = clean((k as TaxKind)?.name, 60);
    const rate = typeof (k as TaxKind)?.rate === 'string' ? (k as TaxKind).rate.trim() : '';
    if (!name || !RATE.test(rate) || kinds.length >= MAX_KINDS || kinds.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const categories: string[] = [];
    // The first kind takes whatever is left, so it names no categories; a category belongs to one kind.
    for (const c of kinds.length && Array.isArray((k as TaxKind).categories) ? (k as TaxKind).categories : []) {
      const category = clean(c, 80);
      if (!category || taken.has(category.toLowerCase())) continue;
      taken.add(category.toLowerCase());
      categories.push(category);
    }
    kinds.push({ name, rate: String(Number(rate)), categories });
  }
  const dates: OwnDate[] = [];
  for (const d of Array.isArray(r.dates) ? r.dates : []) {
    const x = d as Partial<OwnDate>;
    const name = clean(x?.name, 80);
    if (!name || !isDate(x.date) || dates.length >= MAX_OWN_DATES) continue;
    dates.push({ id: typeof x.id === 'string' && /^[0-9a-f-]{36}$/.test(x.id) ? x.id : randomUUID(), name, repeats: x.repeats === 'monthly' || x.repeats === 'yearly' ? x.repeats : 'once', date: x.date });
  }
  return {
    kinds: kinds.length ? kinds : [DEFAULT_KIND],
    gstReturn: r.gstReturn !== false,
    businessTax: r.businessTax !== false,
    email: r.email !== false,
    dates,
  };
}

export async function loadTaxSettings(db: Queryable, tenantId: string): Promise<TaxSettings> {
  return taxSettings((await db.query<{ tax_settings: unknown }>('select tax_settings from tenants where id = $1', [tenantId])).rows[0]?.tax_settings);
}

// ---------- the worksheet ----------

const SALES_WHERE = `d.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.status = any($4::text[])
  and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
const signed = (col: string) => `coalesce(sum(case when d.etd_type = '04' then -${col} else ${col} end), 0)`;

/** A percentage of an amount in cents, to the cent (half away from zero). */
export function percentOfCents(cents: bigint, rate: string): bigint {
  const [whole, frac = ''] = rate.split('.');
  const hundredths = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  const n = cents * hundredths;
  return n >= 0n ? (n + 5000n) / 10000n : -((-n + 5000n) / 10000n);
}

/** The day a month's return is due: the 15th of the month after `to`. */
export function returnDueOn(to: string): string {
  const d = new Date(`${to.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.toISOString().slice(0, 7)}-${String(RETURN_DAY).padStart(2, '0')}`;
}

export async function businessTax(db: Queryable, tenantId: string, from: string, to: string) {
  const settings = await loadTaxSettings(db, tenantId);
  const args = [tenantId, from, to, COUNTED_STATUSES];
  const byCategory = (await db.query<{ category: string | null; net: unknown }>(
    `select lower(i.category) as category, ${signed('l.net_cents')} as net
     from document_lines l join documents d on d.id = l.document_id left join items i on i.id = l.item_id where ${SALES_WHERE} group by 1`, args,
  )).rows;
  const docs = (await db.query<{ n: number }>(`select count(*)::int as n from documents d where ${SALES_WHERE}`, args)).rows[0]!.n;
  const waiting = (await db.query<{ n: number }>(`select count(*)::int as n from documents d where ${SALES_WHERE}`, [tenantId, from, to, ['pending']])).rows[0]!.n;
  const withheld = (await db.query<{ n: number; amount: unknown }>(
    `select count(*)::int as n, coalesce(sum(w.amount_cents), 0) as amount from document_withholdings w join documents d on d.id = w.document_id where ${SALES_WHERE}`, args,
  )).rows[0]!;
  const env = (await db.query<{ environment: 'test' | 'production'; name: string; tin: string }>('select environment, coalesce(trade_name, legal_name) as name, tin from tenants where id = $1', [tenantId])).rows[0]!;

  const receipts = settings.kinds.map(() => 0n);
  for (const row of byCategory) {
    const k = row.category === null ? -1 : settings.kinds.findIndex((kind) => kind.categories.some((c) => c.toLowerCase() === row.category));
    receipts[k < 0 ? 0 : k] = receipts[k < 0 ? 0 : k]! + toBigInt(row.net);
  }
  const kinds = settings.kinds.map((k, i) => ({ name: k.name, rate: k.rate, categories: k.categories, receipts: receipts[i]!, tax: percentOfCents(receipts[i]!, k.rate) }));
  const total = kinds.reduce((a, k) => a + k.receipts, 0n);
  const tax = kinds.reduce((a, k) => a + k.tax, 0n);
  const credit = toBigInt(withheld.amount);
  const warnings: string[] = [];
  if (env.environment === 'test') warnings.push('This business is in the BTS test environment: these figures are from test documents.');
  if (waiting) warnings.push(`${waiting} document(s) of the period are still waiting for BTS and are not counted yet.`);
  if (from.slice(0, 7) !== to.slice(0, 7)) warnings.push('Business tax is filed month by month: this period covers more than one month.');
  return {
    business: { name: env.name, tin: env.tin },
    environment: env.environment,
    period: { from, to },
    documents: docs,
    kinds: kinds.map((k) => ({ name: k.name, rate: k.rate, categories: k.categories, receipts: formatCents(k.receipts), tax: formatCents(k.tax) })),
    receipts: formatCents(total),
    tax: formatCents(tax),
    withheld: { invoices: withheld.n, amount: formatCents(credit) },
    /** What is left to pay; negative when customers withheld more than the tax (a credit to carry forward). */
    toPay: formatCents(tax - credit),
    dueOn: returnDueOn(to),
    warnings,
  };
}
export type BusinessTax = Awaited<ReturnType<typeof businessTax>>;

/** The worksheet as CSV (with a BOM, for spreadsheets). */
export function businessTaxCsv(r: BusinessTax): string {
  const rows: Array<[string, string, string, string]> = [
    ...r.kinds.map((k): [string, string, string, string] => [k.name, k.receipts, k.rate, k.tax]),
    ['Total receipts and business tax', r.receipts, '', r.tax],
    [`Less contract tax withheld by customers (${r.withheld.invoices} invoice${r.withheld.invoices === 1 ? '' : 's'})`, '', '', r.withheld.amount],
    [r.toPay.startsWith('-') ? 'Credit to carry forward' : `Business tax to pay by ${r.dueOn}`, '', '', r.toPay.replace('-', '')],
  ];
  const csv = ['Kind of receipt,Receipts before GST (BZD),Rate (%),Business tax (BZD)', ...rows.map(([a, b, c, d]) => [csvCell(a), csvCell(b, false), csvCell(c, false), csvCell(d, false)].join(','))].join('\r\n');
  return `﻿${csv}\r\n`;
}

// ---------- what is due and when ----------

export interface DueDate {
  key: string;
  kind: 'gst' | 'business-tax' | 'own';
  name: string;
  dueOn: string;
  daysLeft: number;
  /** For a return: the month it covers, and about how much it comes to from the records so far. */
  period?: { from: string; to: string };
  amount?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T12:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
const monthName = (s: string) => utc(s).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** A day of a month, never past its end (the 31st in February is the 28th or 29th). */
function dayIn(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  return iso(new Date(Date.UTC(year, month, Math.min(day, last), 12)));
}

/** The next time an owner's date falls, on or after `today`; null when it was a single date now past. */
export function nextOccurrence(d: Pick<OwnDate, 'repeats' | 'date'>, today: string): string | null {
  if (d.repeats === 'once' || d.date >= today) return d.date >= today ? d.date : null;
  const first = utc(d.date);
  const now = utc(today);
  if (d.repeats === 'monthly') {
    const here = dayIn(now.getUTCFullYear(), now.getUTCMonth(), first.getUTCDate());
    return here >= today ? here : dayIn(now.getUTCFullYear(), now.getUTCMonth() + 1, first.getUTCDate());
  }
  const here = dayIn(now.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  return here >= today ? here : dayIn(now.getUTCFullYear() + 1, first.getUTCMonth(), first.getUTCDate());
}

/** The return due next: the 15th on or after `today`, for the calendar month before it. */
export function nextReturn(today: string): { dueOn: string; from: string; to: string } {
  const now = utc(today);
  let due = dayIn(now.getUTCFullYear(), now.getUTCMonth(), RETURN_DAY);
  if (due < today) due = dayIn(now.getUTCFullYear(), now.getUTCMonth() + 1, RETURN_DAY);
  const d = utc(due);
  const from = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 12)));
  const to = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 12)));
  return { dueOn: due, from, to };
}

/** What is coming up in the next `days` days, soonest first. */
export async function dueDates(db: Queryable, tenantId: string, today: string, days = 45): Promise<DueDate[]> {
  const settings = await loadTaxSettings(db, tenantId);
  const out: DueDate[] = [];
  const ret = nextReturn(today);
  if (daysBetween(today, ret.dueOn) <= days) {
    const period = { from: ret.from, to: ret.to };
    if (settings.gstReturn) {
      const g = await gstReturn(db, tenantId, ret.from, ret.to);
      out.push({ key: `gst:${ret.dueOn}`, kind: 'gst', name: `GST return for ${monthName(ret.from)}`, dueOn: ret.dueOn, daysLeft: daysBetween(today, ret.dueOn), period, amount: g.net });
    }
    if (settings.businessTax) {
      const b = await businessTax(db, tenantId, ret.from, ret.to);
      out.push({ key: `business-tax:${ret.dueOn}`, kind: 'business-tax', name: `Business tax for ${monthName(ret.from)}`, dueOn: ret.dueOn, daysLeft: daysBetween(today, ret.dueOn), period, amount: b.toPay });
    }
  }
  for (const d of settings.dates) {
    const next = nextOccurrence(d, today);
    if (next && daysBetween(today, next) <= days) out.push({ key: `own:${d.id}:${next}`, kind: 'own', name: d.name, dueOn: next, daysLeft: daysBetween(today, next) });
  }
  return out.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}

export const belizeToday = (now = new Date()) => new Date(now.getTime() - 6 * 3600_000).toISOString().slice(0, 10);

// ---------- routes ----------

const periodSchema = { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema, format: { type: 'string', enum: ['json', 'csv'] } } } as const;
type Period = { from: string; to: string; format?: 'json' | 'csv' };
function checkPeriod(q: Period) {
  if (q.from > q.to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
  if (Date.parse(q.to) - Date.parse(q.from) > 3 * 366 * 86_400_000) throw new ApiError(400, 'invalid_request', 'Choose a period of at most three years');
}

export function registerBusinessTaxRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get<{ Querystring: Period }>('/reports/business-tax', { schema: { querystring: periodSchema } }, async (request, reply) => {
    requirePermission(request, 'reports.view');
    checkPeriod(request.query);
    const r = await businessTax(db, request.tenantId, request.query.from, request.query.to);
    if (request.query.format !== 'csv') return r;
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="business-tax-${request.query.from}-to-${request.query.to}.csv"`).send(businessTaxCsv(r));
  });

  app.get<{ Querystring: Period }>('/reports/business-tax.pdf', { schema: { querystring: periodSchema } }, async (request, reply) => {
    requirePermission(request, 'reports.view');
    checkPeriod(request.query);
    const r = await businessTax(db, request.tenantId, request.query.from, request.query.to);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="business-tax-${request.query.from}-to-${request.query.to}.pdf"`).send(await renderBusinessTax(r));
  });

  app.get<{ Querystring: { days?: string } }>(
    '/reports/due-dates',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { days: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } } } } },
    async (request) => {
      requirePermission(request, 'reports.view');
      return { today: belizeToday(), data: await dueDates(db, request.tenantId, belizeToday(), Math.min(Number(request.query.days ?? 45), 400)) };
    },
  );

  app.get('/tax-settings', async (request) => {
    requirePermission(request, 'reports.view');
    return { ...(await loadTaxSettings(db, request.tenantId)), presets: KIND_PRESETS };
  });

  const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
  app.put<{ Body: Partial<TaxSettings> }>(
    '/tax-settings',
    {
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            kinds: {
              type: 'array', minItems: 1, maxItems: MAX_KINDS,
              items: { type: 'object', required: ['name', 'rate'], additionalProperties: false, properties: { name: text(60), rate: { type: 'string', pattern: RATE.source }, categories: { type: 'array', maxItems: 100, items: text(80) } } },
            },
            gstReturn: { type: 'boolean' }, businessTax: { type: 'boolean' }, email: { type: 'boolean' },
            dates: {
              type: 'array', maxItems: MAX_OWN_DATES,
              items: { type: 'object', required: ['name', 'date'], additionalProperties: false, properties: { id: { type: 'string', maxLength: 36 }, name: text(80), repeats: { type: 'string', enum: ['monthly', 'yearly', 'once'] }, date: dateSchema } },
            },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      if (b.kinds) {
        if (b.kinds.some((k) => !k.name.trim())) throw new ApiError(422, 'invalid_kind', 'Give each kind of receipt a name');
        if (new Set(b.kinds.map((k) => k.name.trim().toLowerCase())).size !== b.kinds.length) throw new ApiError(422, 'invalid_kind', 'Each kind of receipt once');
        if (b.kinds.some((k) => Number(k.rate) > 50)) throw new ApiError(422, 'invalid_kind', 'A rate is a percentage of receipts: up to 50');
      }
      const next = taxSettings({ ...(await loadTaxSettings(db, request.tenantId)), ...b });
      await db.query('update tenants set tax_settings = $2 where id = $1', [request.tenantId, JSON.stringify(next)]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'business.tax_settings', details: { kinds: next.kinds.map((k) => `${k.name} ${k.rate}%`), dates: next.dates.length }, ip: request.ip });
      return { ...next, presets: KIND_PRESETS };
    },
  );
}
