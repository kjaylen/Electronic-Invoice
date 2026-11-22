/**
 * The GST return worksheet and profit and loss, from the e-invoices (money
 * in) and the recorded expenses (money out).
 *
 *   GET /v1/reports/gst-return?from&to[&format=csv]   sales and purchases by GST treatment, what to pay
 *   GET /v1/reports/gst-return.pdf?from&to
 *   GET /v1/reports/profit?from&to                    income, costs by category, by month
 *
 * Sales count documents with legal value in the business's current BTS
 * environment (credit notes subtract, debit notes add), by issue date.
 * Purchases count expenses by their date. GST paid is claimable only with a
 * tax invoice from a GST-registered supplier (its TIN); other GST is a cost.
 */

import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderGstReturn } from '../render/gst-return.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { COUNTED_STATUSES, csvCell } from './reports.ts';
import { date as dateSchema } from './schemas.ts';

const c = (v: unknown) => formatCents(toBigInt(v ?? 0));
const periodSchema = { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema, format: { type: 'string', enum: ['json', 'csv'] } } } as const;
type Period = { from: string; to: string; format?: 'json' | 'csv' };

function checkPeriod(q: Period) {
  if (q.from > q.to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
  if (Date.parse(q.to) - Date.parse(q.from) > 3 * 366 * 86_400_000) throw new ApiError(400, 'invalid_request', 'Choose a period of at most three years');
}

const SALES_WHERE = `d.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.status = any($4::text[])
  and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
const signed = (col: string) => `coalesce(sum(case when d.etd_type = '04' then -${col} else ${col} end), 0)`;
const CLAIMABLE = "e.gst_treatment = 'standard' and e.claim_gst and e.supplier_tin is not null";

export async function gstReturn(db: Queryable, tenantId: string, from: string, to: string) {
  const sales = (await db.query<{ gst_category: 'S' | 'Z' | 'E'; net: unknown; gst: unknown }>(
    `select l.gst_category, ${signed('l.net_cents')} as net, ${signed('l.gst_cents')} as gst
     from document_lines l join documents d on d.id = l.document_id where ${SALES_WHERE} group by l.gst_category`,
    [tenantId, from, to, COUNTED_STATUSES],
  )).rows;
  const docCount = (await db.query<{ n: number }>(`select count(*)::int as n from documents d where ${SALES_WHERE}`, [tenantId, from, to, COUNTED_STATUSES])).rows[0]!.n;
  const waiting = (await db.query<{ n: number }>(`select count(*)::int as n from documents d where ${SALES_WHERE}`, [tenantId, from, to, ['pending']])).rows[0]!.n;
  const p = (await db.query<Record<string, unknown>>(
    `select count(*)::int as n,
       coalesce(sum(net_cents) filter (where ${CLAIMABLE}), 0) as claim_net, coalesce(sum(gst_cents) filter (where ${CLAIMABLE}), 0) as claim_gst,
       coalesce(sum(net_cents) filter (where e.gst_treatment = 'standard' and not (${CLAIMABLE})), 0) as other_net,
       coalesce(sum(gst_cents) filter (where e.gst_treatment = 'standard' and not (${CLAIMABLE})), 0) as other_gst,
       coalesce(sum(net_cents) filter (where e.gst_treatment = 'zero'), 0) as zero_net,
       coalesce(sum(net_cents) filter (where e.gst_treatment = 'exempt'), 0) as exempt_net,
       coalesce(sum(net_cents) filter (where e.gst_treatment = 'none'), 0) as none_net,
       count(*) filter (where e.gst_treatment = 'standard' and e.claim_gst and e.supplier_tin is null)::int as missing_tin,
       count(*) filter (where e.gst_treatment = 'standard' and e.receipt_content_type is null and ${CLAIMABLE})::int as missing_receipt
     from expenses e where e.tenant_id = $1 and e.expense_date between $2::date and $3::date`,
    [tenantId, from, to],
  )).rows[0]!;
  const env = (await db.query<{ environment: 'test' | 'production'; name: string; tin: string }>('select environment, coalesce(trade_name, legal_name) as name, tin from tenants where id = $1', [tenantId])).rows[0]!;
  const by = (cat: 'S' | 'Z' | 'E') => sales.find((s) => s.gst_category === cat);
  const output = toBigInt(by('S')?.gst ?? 0);
  const input = toBigInt(p.claim_gst);
  const warnings: string[] = [];
  if (env.environment === 'test') warnings.push('This business is in the BTS test environment: these figures are from test documents.');
  if (waiting) warnings.push(`${waiting} document(s) of the period are still waiting for BTS and are not counted yet.`);
  if (Number(p.missing_tin)) warnings.push(`${p.missing_tin} purchase(s) with GST have no supplier TIN, so their GST is not claimed. Add the TIN from the supplier's tax invoice.`);
  if (Number(p.missing_receipt)) warnings.push(`${p.missing_receipt} purchase(s) whose GST is claimed have no receipt attached. Keep the tax invoices: BTS can ask for them.`);
  return {
    business: { name: env.name, tin: env.tin },
    environment: env.environment,
    period: { from, to },
    sales: {
      standard: { net: c(by('S')?.net), gst: c(by('S')?.gst) },
      zero: { net: c(by('Z')?.net) },
      exempt: { net: c(by('E')?.net) },
      documents: docCount,
    },
    purchases: {
      claimable: { net: c(p.claim_net), gst: c(p.claim_gst) },
      notClaimable: { net: c(p.other_net), gst: c(p.other_gst) },
      zero: { net: c(p.zero_net) },
      exempt: { net: c(p.exempt_net) },
      noGst: { net: c(p.none_net) },
      expenses: Number(p.n),
    },
    outputGst: formatCents(output),
    inputGst: formatCents(input),
    net: formatCents(output - input),
    warnings,
  };
}

export async function profitAndLoss(db: Queryable, tenantId: string, from: string, to: string) {
  const income = (await db.query<{ month: string; net: unknown }>(
    `select to_char(d.issue_date, 'YYYY-MM') as month, ${signed('d.line_extension_cents')} as net from documents d where ${SALES_WHERE} group by 1 order by 1`,
    [tenantId, from, to, COUNTED_STATUSES],
  )).rows;
  // What an expense costs the business: its net, plus any GST it cannot claim back.
  const cost = `e.net_cents + case when ${CLAIMABLE} then 0 else e.gst_cents end`;
  const costs = (await db.query<{ month: string; category: string; amount: unknown }>(
    `select to_char(e.expense_date, 'YYYY-MM') as month, e.category, sum(${cost}) as amount from expenses e
     where e.tenant_id = $1 and e.expense_date between $2::date and $3::date group by 1, 2 order by 1, 2`,
    [tenantId, from, to],
  )).rows;
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const byMonth = months.map((m) => {
    const inc = toBigInt(income.find((i) => i.month === m)?.net ?? 0);
    const exp = costs.filter((x) => x.month === m).reduce((a, x) => a + toBigInt(x.amount), 0n);
    return { month: m, income: formatCents(inc), expenses: formatCents(exp), profit: formatCents(inc - exp) };
  });
  const categories = new Map<string, bigint>();
  for (const x of costs) categories.set(x.category, (categories.get(x.category) ?? 0n) + toBigInt(x.amount));
  const totalIncome = income.reduce((a, i) => a + toBigInt(i.net), 0n);
  const totalCosts = [...categories.values()].reduce((a, v) => a + v, 0n);
  return {
    period: { from, to },
    months: byMonth,
    categories: [...categories.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).map(([category, amount]) => ({ category, amount: formatCents(amount) })),
    totals: { income: formatCents(totalIncome), expenses: formatCents(totalCosts), profit: formatCents(totalIncome - totalCosts) },
  };
}

export function registerAccountingRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  app.get<{ Querystring: Period }>('/reports/gst-return', { schema: { querystring: periodSchema } }, async (request, reply) => {
    requirePermission(request, 'reports.view');
    checkPeriod(request.query);
    const r = await gstReturn(db, request.tenantId, request.query.from, request.query.to);
    if (request.query.format !== 'csv') return r;
    const rows: Array<[string, string, string]> = [
      ['Standard-rated sales (12.5%)', r.sales.standard.net, r.sales.standard.gst],
      ['Zero-rated sales', r.sales.zero.net, '0.00'],
      ['Exempt sales', r.sales.exempt.net, ''],
      ['GST charged on sales (output tax)', '', r.outputGst],
      ['Standard-rated purchases with a tax invoice (claimable)', r.purchases.claimable.net, r.purchases.claimable.gst],
      ['Standard-rated purchases, GST not claimable', r.purchases.notClaimable.net, r.purchases.notClaimable.gst],
      ['Zero-rated purchases', r.purchases.zero.net, '0.00'],
      ['Exempt purchases', r.purchases.exempt.net, ''],
      ['Purchases from suppliers not charging GST', r.purchases.noGst.net, ''],
      ['GST paid on purchases you can claim (input tax)', '', r.inputGst],
      [r.net.startsWith('-') ? 'GST credit for the period' : 'GST to pay for the period', '', r.net.replace('-', '')],
    ];
    const csv = ['Line,Net (BZD),GST (BZD)', ...rows.map(([a, b, d]) => [csvCell(a), csvCell(b, false), csvCell(d, false)].join(','))].join('\r\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="gst-${request.query.from}-to-${request.query.to}.csv"`).send(`﻿${csv}\r\n`);
  });

  app.get<{ Querystring: Period }>('/reports/gst-return.pdf', { schema: { querystring: periodSchema } }, async (request, reply) => {
    requirePermission(request, 'reports.view');
    checkPeriod(request.query);
    const r = await gstReturn(db, request.tenantId, request.query.from, request.query.to);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="gst-${request.query.from}-to-${request.query.to}.pdf"`).send(await renderGstReturn(r));
  });

  app.get<{ Querystring: Period }>('/reports/profit', { schema: { querystring: periodSchema } }, async (request) => {
    requirePermission(request, 'reports.view');
    checkPeriod(request.query);
    return profitAndLoss(db, request.tenantId, request.query.from, request.query.to);
  });
}
