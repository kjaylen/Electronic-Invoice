/**
 * A supplier at a glance (GET /v1/suppliers/:id/summary): what the business has spent with them,
 * the bills still to pay, open purchase orders, recent deliveries, and the items it buys from them
 * with what each cost last time.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { poNumber } from './purchasing.ts';
import { uuid } from './schemas.ts';

const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const costText = (v: string) => {
  const n = Number(v);
  return Number.isInteger(Math.round(n * 1e6) / 1e4) ? n.toFixed(2) : String(n);
};

export function registerSupplierSummaryRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'expenses.manage') && !can(request.principal, 'catalog.manage')) requirePermission(request, 'reports.view');
  };

  app.get<{ Params: { id: string } }>('/suppliers/:id/summary', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    canRead(request);
    const tenantId = request.tenantId;
    const s = (await db.query<{ id: string; name: string; tin: string | null; email: string | null; telephone: string | null; address: string | null; notes: string | null; archived_at: Date | null }>(
      'select id, name, tin, email, telephone, address, notes, archived_at from suppliers where id = $1 and tenant_id = $2', [request.params.id, tenantId],
    )).rows[0];
    if (!s) throw notFound('Supplier');
    const today = belizeToday();
    const year = `${today.slice(0, 4)}-01-01`;

    const spend = (await db.query<{ lifetime: unknown; this_year: unknown; bills: number; last: string | null }>(
      `select coalesce(sum(total_cents), 0) as lifetime, coalesce(sum(total_cents) filter (where expense_date >= $3::date), 0) as this_year,
         count(*)::int as bills, max(expense_date)::text as last
       from expenses where tenant_id = $1 and supplier_id = $2`, [tenantId, s.id, year],
    )).rows[0]!;
    const unpaid = (await db.query<{ id: string; reference: string | null; expense_date: string; due_date: string | null; total_cents: unknown; description: string | null }>(
      `select id, reference, expense_date::text as expense_date, due_date::text as due_date, total_cents, description
       from expenses where tenant_id = $1 and supplier_id = $2 and paid_on is null order by coalesce(due_date, expense_date) limit 50`, [tenantId, s.id],
    )).rows;
    const days = (from: string) => Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000);
    const owedTotal = unpaid.reduce((a, b) => a + toBigInt(b.total_cents), 0n);
    const overdue = unpaid.filter((b) => b.due_date && b.due_date < today).reduce((a, b) => a + toBigInt(b.total_cents), 0n);

    const orders = (await db.query<{ id: string; number: number; status: string; expected_on: string | null; total_cost_cents: unknown }>(
      `select id, number, status, expected_on::text as expected_on, total_cost_cents from purchase_orders
       where tenant_id = $1 and supplier_id = $2 and status in ('draft', 'sent', 'partial') order by created_at desc limit 20`, [tenantId, s.id],
    )).rows;
    const deliveries = (await db.query<{ id: string; received_on: string; reference: string | null; total_cost_cents: unknown; purchase_order_id: string | null; expense_id: string | null }>(
      `select id, received_on::text as received_on, reference, total_cost_cents, purchase_order_id, expense_id from stock_receipts
       where tenant_id = $1 and supplier_id = $2 order by received_on desc, created_at desc limit 10`, [tenantId, s.id],
    )).rows;
    // Items whose latest delivery came from this supplier, with what they cost then.
    const items = (await db.query<{ item_id: string; name: string; unit_cost: string | null; received_on: string; stock: string | null; low_stock: string | null; total: string }>(
      `with mine as (
         select m.item_id, m.unit_cost, m.change, r.received_on, m.created_at from stock_movements m join stock_receipts r on r.id = m.receipt_id
         where m.tenant_id = $1 and r.supplier_id = $2
       ), latest as (
         select distinct on (item_id) item_id, unit_cost, received_on from mine order by item_id, created_at desc
       )
       select l.item_id, i.name, l.unit_cost::text as unit_cost, l.received_on::text as received_on, i.stock_quantity::text as stock, i.low_stock::text as low_stock,
         (select sum(change) from mine where mine.item_id = l.item_id)::text as total
       from latest l join items i on i.id = l.item_id where i.archived_at is null order by i.name limit 100`, [tenantId, s.id],
    )).rows;

    return {
      supplier: { id: s.id, name: s.name, tin: s.tin, email: s.email, telephone: s.telephone, address: s.address, notes: s.notes, archived: Boolean(s.archived_at) },
      spend: { lifetime: formatCents(toBigInt(spend.lifetime)), thisYear: formatCents(toBigInt(spend.this_year)), bills: spend.bills, lastPurchase: spend.last },
      owed: {
        total: formatCents(owedTotal), overdue: formatCents(overdue),
        bills: unpaid.map((b) => ({ id: b.id, reference: b.reference, date: b.expense_date, dueDate: b.due_date, total: formatCents(toBigInt(b.total_cents)), description: b.description, daysOverdue: b.due_date && b.due_date < today ? days(b.due_date) : 0 })),
      },
      orders: orders.map((o) => ({ id: o.id, number: poNumber(o.number), status: o.status, expectedOn: o.expected_on, late: Boolean(o.expected_on && o.expected_on < today && o.status !== 'draft'), total: formatCents(toBigInt(o.total_cost_cents)) })),
      deliveries: deliveries.map((d) => ({ id: d.id, receivedOn: d.received_on, reference: d.reference, totalCost: formatCents(toBigInt(d.total_cost_cents)), purchaseOrderId: d.purchase_order_id, expenseId: d.expense_id })),
      items: items.map((i) => ({
        itemId: i.item_id, name: i.name, lastCost: i.unit_cost === null ? null : costText(i.unit_cost), lastReceived: i.received_on,
        stock: i.stock === null ? null : String(Number(i.stock)), low: i.stock !== null && Number(i.stock) <= Number(i.low_stock ?? 0), received: String(Number(i.total ?? 0)),
      })),
    };
  });
}
