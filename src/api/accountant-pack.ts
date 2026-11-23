/**
 * The accountant's pack: what an accountant asks for at the end of a month
 * (or a quarter, or a year), in one ZIP.
 *
 *   GET /v1/reports/accountant-pack?from&to
 *
 *   README.txt              what is in it, and what to check (the GST return's warnings)
 *   gst-return.pdf, .csv    the GST return worksheet for the period
 *   profit-and-loss.csv     income and costs by month, costs by category
 *   sales-register.csv      every tax document of the period, any status
 *   payments-received.csv   payments recorded against invoices in the period (voided ones marked)
 *   contract-tax-withheld.csv  invoices of the period whose customer withheld contract tax (for the business tax credit)
 *   expenses.csv            the period's purchases and costs
 *   receipts/               the receipts attached to those expenses
 *   receivables-ageing.csv  who owes what, as of today
 *   stock-on-hand.csv       tracked stock and its value at average cost, as of today
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderGstReturn } from '../render/gst-return.ts';
import { ZipWriter } from '../render/zip.ts';
import { gstReturn, gstReturnCsv, profitAndLoss } from './accounting.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { EXPENSE_COLUMNS, expenseJson, expensesCsvText, type ExpenseRow } from './expenses.ts';
import { stockOnHandCsv } from './inventory.ts';
import { requirePermission } from './permissions.ts';
import { ageingCsv } from './receivables.ts';
import { documentRegisterCsv, toCsv } from './reports.ts';
import { date } from './schemas.ts';

/** Receipts in one pack, at most (each up to 5 MB). */
export const MAX_PACK_RECEIPTS = 300;

const METHOD_NAMES: Record<string, string> = { cash: 'Cash', cheque: 'Cheque', bank_transfer: 'Bank transfer', card: 'Card', online: 'Online', refund: 'Refund', other: 'Other' };

export function profitCsv(p: Awaited<ReturnType<typeof profitAndLoss>>): string {
  const rows: Array<Array<{ v: unknown; text?: boolean }>> = p.months.map((m) => [{ v: m.month }, { v: m.income, text: false }, { v: m.expenses, text: false }, { v: m.profit, text: false }]);
  rows.push([{ v: 'Total' }, { v: p.totals.income, text: false }, { v: p.totals.expenses, text: false }, { v: p.totals.profit, text: false }]);
  rows.push([], [{ v: 'Costs by category' }, { v: '' }, { v: 'Amount (BZD)' }, { v: '' }]);
  for (const c of p.categories) rows.push([{ v: c.category }, { v: '' }, { v: c.amount, text: false }, { v: '' }]);
  return toCsv(['Month', 'Income before GST (BZD)', 'Costs (BZD)', 'Profit (BZD)'], rows);
}

async function paymentsCsv(db: Queryable, tenantId: string, from: string, to: string): Promise<string> {
  const rows = (await db.query<{ paid_on: string; series_number: number; serial: string; etd_type: string; customer: string | null; tin: string | null; method: string; reference: string | null; amount_cents: unknown; note: string | null; voided_at: Date | null; void_reason: string | null }>(
    `select p.paid_on::text as paid_on, d.series_number, d.serial::text as serial, d.etd_type, d.customer_snapshot->>'name' as customer, d.customer_snapshot->>'tin' as tin,
       p.method, p.reference, p.amount_cents, p.note, p.voided_at, p.void_reason
     from invoice_payments p join documents d on d.id = p.document_id
     where p.tenant_id = $1 and p.paid_on between $2::date and $3::date order by p.paid_on, p.created_at limit 50000`,
    [tenantId, from, to],
  )).rows;
  return toCsv(
    ['Paid on', 'Invoice', 'Customer', 'Customer TIN', 'Method', 'Reference', 'Amount (BZD)', 'Note', 'Voided on', 'Why voided'],
    rows.map((r) => [
      { v: r.paid_on }, { v: `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}` }, { v: r.customer ?? '' }, { v: r.tin ?? '' },
      { v: METHOD_NAMES[r.method] ?? r.method }, { v: r.reference ?? '' }, { v: formatCents(toBigInt(r.amount_cents)), text: false }, { v: r.note ?? '' },
      { v: r.voided_at ? new Date(r.voided_at).toISOString().slice(0, 10) : '' }, { v: r.void_reason ?? '' },
    ]),
  );
}

async function contractTaxCsv(db: Queryable, tenantId: string, from: string, to: string): Promise<string> {
  const rows = (await db.query<{ issue_date: string; series_number: number; serial: string; customer: string | null; tin: string | null; base_cents: unknown; percent: string; amount_cents: unknown; status: string }>(
    `select d.issue_date::text as issue_date, d.series_number, d.serial::text as serial, d.customer_snapshot->>'name' as customer, d.customer_snapshot->>'tin' as tin,
       w.base_cents, w.percent::text as percent, w.amount_cents, d.status
     from document_withholdings w join documents d on d.id = w.document_id
     where w.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.status in ('authorized', 'authorized_with_alert', 'contingency_pending', 'pending')
     order by d.issue_date, d.serial`,
    [tenantId, from, to],
  )).rows;
  const total = rows.reduce((a, r) => a + toBigInt(r.amount_cents), 0n);
  return toCsv(
    ['Invoice date', 'Invoice', 'Customer', 'Customer TIN', 'Before GST (BZD)', 'Rate (%)', 'Withheld (BZD)'],
    [
      ...rows.map((r) => [
        { v: r.issue_date }, { v: `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}` }, { v: r.customer ?? '' }, { v: r.tin ?? '' },
        { v: formatCents(toBigInt(r.base_cents)), text: false }, { v: String(Number(r.percent)), text: false }, { v: formatCents(toBigInt(r.amount_cents)), text: false },
      ]),
      [{ v: 'Total' }, { v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: formatCents(total), text: false }],
    ],
  );
}

function slugPart(s: string): string {
  return s.normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'supplier';
}

function readme(biz: { name: string; tin: string; environment: string }, from: string, to: string, warnings: string[], receipts: { included: number; total: number }): string {
  return [
    `${biz.name} (TIN ${biz.tin}): for the accountant, ${from} to ${to}.`,
    biz.environment === 'production' ? '' : 'TEST ENVIRONMENT: the sales figures come from test documents, which have no tax value.',
    `Created ${new Date().toISOString()}. Amounts are in Belize dollars (BZD).`,
    '',
    'gst-return.pdf, .csv   The GST return worksheet: sales and purchases by GST treatment, and the GST to pay or the credit.',
    'profit-and-loss.csv    Income (before GST) and costs by month, and costs by category.',
    'sales-register.csv     Every tax document of the period, any status, with its BTS authorization.',
    'payments-received.csv  Payments recorded against invoices in the period. Voided payments are listed and marked.',
    'contract-tax-withheld.csv  Invoices of the period whose customer withheld contract tax and paid it to BTS: a credit against business tax.',
    'expenses.csv           Purchases and costs of the period, with the supplier, GST treatment and whether the GST is claimable.',
    `receipts/              The receipts attached to those expenses (${receipts.included} of ${receipts.total}).`,
    'receivables-ageing.csv Who owes what, as of today (not as of the end of the period).',
    'stock-on-hand.csv      Tracked stock and its value at average cost, as of today.',
    '',
    receipts.total > receipts.included ? `Only the first ${receipts.included} receipts are included; download the rest from Expenses, or choose a shorter period.` : '',
    ...(warnings.length ? ['To check:', ...warnings.map((w) => `- ${w}`), ''] : []),
    'The signed e-invoices themselves are in the document archive (Reports > Download archive).',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\r\n');
}

export function registerAccountantPackRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  app.get<{ Querystring: { from: string; to: string } }>(
    '/reports/accountant-pack',
    { schema: { querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: date, to: date } } } },
    async (request, reply) => {
      requirePermission(request, 'reports.view');
      const { from, to } = request.query;
      if (from > to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
      if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new ApiError(400, 'invalid_request', 'Choose a period of at most a year');
      const tenantId = request.tenantId;
      const biz = (await db.query<{ tin: string; name: string; environment: string }>('select tin, coalesce(trade_name, legal_name) as name, environment from tenants where id = $1', [tenantId])).rows[0]!;
      await audit(db, { tenantId, userId: request.userId || null, action: 'accountant_pack.exported', target: `${from} to ${to}`, ip: request.ip });

      const zip = new ZipWriter();
      const produce = async () => {
        const gst = await gstReturn(db, tenantId, from, to);
        const expenses = (await db.query<ExpenseRow>(
          `select ${EXPENSE_COLUMNS} from expenses e left join users u on u.id = e.created_by
           where e.tenant_id = $1 and e.expense_date between $2::date and $3::date order by e.expense_date, e.created_at limit 20000`,
          [tenantId, from, to],
        )).rows;
        const withReceipt = expenses.filter((e) => e.receipt_content_type);
        await zip.add('README.txt', readme(biz, from, to, gst.warnings, { included: Math.min(withReceipt.length, MAX_PACK_RECEIPTS), total: withReceipt.length }));
        await zip.add('gst-return.pdf', await renderGstReturn(gst));
        await zip.add('gst-return.csv', gstReturnCsv(gst));
        await zip.add('profit-and-loss.csv', profitCsv(await profitAndLoss(db, tenantId, from, to)));
        await zip.add('sales-register.csv', await documentRegisterCsv(db, tenantId, { from, to }));
        await zip.add('payments-received.csv', await paymentsCsv(db, tenantId, from, to));
        await zip.add('contract-tax-withheld.csv', await contractTaxCsv(db, tenantId, from, to));
        await zip.add('expenses.csv', expensesCsvText(expenses.map(expenseJson)));
        for (const e of withReceipt.slice(0, MAX_PACK_RECEIPTS)) {
          const r = (await db.query<{ receipt_data: Uint8Array | null; receipt_key: string | null }>('select receipt_data, receipt_key from expenses where id = $1', [e.id])).rows[0];
          let data: Buffer | null = r?.receipt_data ? Buffer.from(r.receipt_data) : null;
          if (!data && r?.receipt_key && ctx.objects) data = (await ctx.objects.get(r.receipt_key))?.data ?? null;
          if (!data) continue;
          const ext = e.receipt_content_type === 'application/pdf' ? 'pdf' : e.receipt_content_type!.split('/')[1];
          await zip.add(`receipts/${e.expense_date}_${slugPart(e.supplier_name)}_${e.id.slice(0, 8)}.${ext}`, data, new Date(`${e.expense_date}T12:00:00Z`));
        }
        await zip.add('receivables-ageing.csv', await ageingCsv(db, tenantId));
        await zip.add('stock-on-hand.csv', await stockOnHandCsv(db, tenantId));
        await zip.finish();
      };
      void produce().catch((err: Error) => {
        request.log.error({ err }, 'accountant pack failed part-way');
        zip.abort(err);
      });
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="accountant-${biz.environment === 'production' ? '' : 'TEST-'}${from}-to-${to}.zip"`)
        .header('Cache-Control', 'no-store')
        .send(zip.stream);
    },
  );
}
