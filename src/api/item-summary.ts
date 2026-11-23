/**
 * An item at a glance (GET /v1/items/:id/summary): how it sells (30, 90 and 365 days, and month by
 * month), its margin, its stock and how long it lasts at the current pace, who supplies it and at
 * what cost, and the bundles it is part of.
 */

import type { FastifyInstance } from 'fastify';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { loadItems } from './catalog.ts';
import { notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const COUNTED = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];

export function registerItemSummaryRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  app.get<{ Params: { id: string } }>('/items/:id/summary', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    if (!can(request.principal, 'catalog.manage')) requirePermission(request, 'reports.view');
    const tenantId = request.tenantId;
    const item = (await loadItems(deps, tenantId, [request.params.id])).get(request.params.id);
    if (!item) throw notFound('Item');
    // Lines sold from this item (credit notes take back), in this business's current BTS environment.
    const sold = `from document_lines l join documents d on d.id = l.document_id
      where l.item_id = $1 and d.tenant_id = $2 and d.status = any($3::text[]) and d.etd_type in ('01', '02', '04')
        and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $2)`;
    const sign = `case when d.etd_type = '04' then -1 else 1 end`;
    const windows = (await db.query<{ q30: string; n30: unknown; q90: string; n90: unknown; q365: string; n365: unknown; cost365: unknown; costed365: unknown; last_sold: string | null }>(
      `select
         coalesce(sum(${sign} * l.quantity) filter (where d.issue_date > current_date - 30), 0)::text as q30,
         coalesce(sum(${sign} * l.net_cents) filter (where d.issue_date > current_date - 30), 0) as n30,
         coalesce(sum(${sign} * l.quantity) filter (where d.issue_date > current_date - 90), 0)::text as q90,
         coalesce(sum(${sign} * l.net_cents) filter (where d.issue_date > current_date - 90), 0) as n90,
         coalesce(sum(${sign} * l.quantity) filter (where d.issue_date > current_date - 365), 0)::text as q365,
         coalesce(sum(${sign} * l.net_cents) filter (where d.issue_date > current_date - 365), 0) as n365,
         coalesce(sum(${sign} * round(l.quantity * l.unit_cost * 100)) filter (where d.issue_date > current_date - 365 and l.unit_cost is not null), 0) as cost365,
         coalesce(sum(${sign} * l.net_cents) filter (where d.issue_date > current_date - 365 and l.unit_cost is not null), 0) as costed365,
         max(d.issue_date)::text as last_sold
       ${sold}`, [item.id, tenantId, COUNTED],
    )).rows[0]!;
    const months = (await db.query<{ month: string; quantity: string; net: unknown }>(
      `select to_char(d.issue_date, 'YYYY-MM') as month, sum(${sign} * l.quantity)::text as quantity, sum(${sign} * l.net_cents) as net
       ${sold} and d.issue_date > (date_trunc('month', current_date) - interval '11 months')::date group by 1 order by 1`, [item.id, tenantId, COUNTED],
    )).rows;
    const stock = (await db.query<{ stock: string | null; low_stock: string | null; average_cost: string | null }>(
      'select stock_quantity::text as stock, low_stock::text as low_stock, average_cost::text as average_cost from items where id = $1', [item.id],
    )).rows[0]!;
    const suppliers = (await db.query<{ supplier_id: string | null; name: string; last_cost: string | null; last_on: string; received: string }>(
      `select r.supplier_id, coalesce(min(r.supplier_name), 'Unknown') as name,
         (array_agg(m.unit_cost::text order by m.created_at desc))[1] as last_cost, max(r.received_on)::text as last_on, sum(m.change)::text as received
       from stock_movements m join stock_receipts r on r.id = m.receipt_id
       where m.item_id = $1 and m.tenant_id = $2 group by r.supplier_id, lower(r.supplier_name) order by max(r.received_on) desc limit 10`, [item.id, tenantId],
    )).rows;
    const bundles = (await db.query<{ id: string; name: string; quantity: string }>(
      'select i.id, i.name, c.quantity::text as quantity from item_components c join items i on i.id = c.item_id where c.component_id = $1 and i.archived_at is null order by i.name', [item.id],
    )).rows;

    const q90 = Number(windows.q90);
    const stockNow = stock.stock === null ? null : Number(stock.stock);
    const perDay = q90 / 90;
    const costed = Number(toBigInt(windows.costed365));
    const cost = Number(toBigInt(windows.cost365));
    return {
      item,
      sales: {
        last30: { quantity: String(Number(windows.q30)), net: formatCents(toBigInt(windows.n30)) },
        last90: { quantity: String(q90), net: formatCents(toBigInt(windows.n90)) },
        last365: { quantity: String(Number(windows.q365)), net: formatCents(toBigInt(windows.n365)) },
        lastSold: windows.last_sold,
        months: months.map((m) => ({ month: m.month, quantity: String(Number(m.quantity)), net: formatCents(toBigInt(m.net)) })),
      },
      // Over the last year, on lines with a known cost.
      margin: costed > 0 ? { sales: formatCents(BigInt(costed)), cost: formatCents(BigInt(cost)), percent: Math.round(((costed - cost) / costed) * 1000) / 10 } : null,
      stock: {
        tracked: stockNow !== null, quantity: stockNow, lowStock: stock.low_stock === null ? null : Number(stock.low_stock),
        averageCost: stock.average_cost === null ? null : Number(stock.average_cost).toFixed(2),
        // How many days the stock lasts at the pace of the last 90 days.
        daysOfCover: stockNow !== null && perDay > 0 ? Math.floor(Math.max(0, stockNow) / perDay) : null,
      },
      suppliers: suppliers.map((s) => ({ id: s.supplier_id, name: s.name, lastCost: s.last_cost === null ? null : Number(s.last_cost).toFixed(2), lastReceived: s.last_on, received: String(Number(s.received)) })),
      bundles: bundles.map((b) => ({ id: b.id, name: b.name, quantity: String(Number(b.quantity)) })),
    };
  });
}
