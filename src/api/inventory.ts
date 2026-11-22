/**
 * Inventory: stock levels, each item's history, counts and adjustments, and
 * stock received from suppliers (optionally recording the bill as an
 * expense in the same step).
 *
 *   GET  /v1/inventory                    items with stock, value, low and out (filter, search)
 *   GET  /v1/inventory.csv
 *   GET  /v1/inventory/:itemId            one item with its movements
 *   POST /v1/inventory/:itemId/adjust     { mode: change | set, quantity, reason, note? }
 *   PUT  /v1/inventory/:itemId/settings   { track, quantity?, lowStock? }
 *   POST /v1/inventory/count              a stock count { counts: [{ itemId, quantity }], note? }
 *   GET  /v1/inventory/receipts           stock received
 *   POST /v1/inventory/receipts           { supplierId? | supplierName?, supplierTin?, reference?, receivedOn, lines: [{ itemId, quantity, unitCost }],
 *                                           expense?: { gstTreatment, paid?: { on, method } | null, dueDate? } }
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, mul, parseDecimal, roundToCents } from '../engine/decimal.ts';
import { ADJUST_REASONS, type AdjustReason, moveStock, StockError, stockQuantity } from '../inventory/stock.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { csvCell } from './reports.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const qty = { type: 'string', pattern: '^-?\\d{1,12}(\\.\\d{1,3})?$' } as const;
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const trimQty = (v: string | null) => (v === null ? null : Number(v));

interface StockRow {
  id: string;
  name: string;
  seller_code: string | null;
  barcode: string | null;
  unit_code: string;
  unit_price: string;
  product_id: string | null;
  stock: string | null;
  low_stock: string | null;
  average_cost: string | null;
  last_movement: Date | string | null;
}

function stockJson(r: StockRow) {
  const stock = trimQty(r.stock);
  const low = trimQty(r.low_stock);
  const cost = r.average_cost === null ? null : Number(r.average_cost);
  return {
    itemId: r.id,
    name: r.name,
    sellerCode: r.seller_code,
    barcode: r.barcode,
    unitCode: r.unit_code,
    price: String(r.unit_price).replace(/(\.\d{2}\d*?)0+$/, '$1'),
    productId: r.product_id,
    tracked: stock !== null,
    stock,
    lowStock: low,
    state: stock === null ? 'untracked' : stock <= 0 ? 'out' : low !== null && stock <= low ? 'low' : 'ok',
    averageCost: cost === null ? null : cost.toFixed(2),
    value: stock !== null && stock > 0 && cost !== null ? formatCents(roundToCents(mul(parseDecimal(r.stock!), parseDecimal(r.average_cost!)))) : '0.00',
    lastMovement: r.last_movement ? new Date(r.last_movement).toISOString() : null,
  };
}

const STOCK_COLUMNS = `i.id, i.name, i.seller_code, i.barcode, i.unit_code, i.unit_price::text as unit_price, i.product_id, i.stock_quantity::text as stock,
  i.low_stock::text as low_stock, i.average_cost::text as average_cost, (select max(m.created_at) from stock_movements m where m.item_id = i.id) as last_movement`;

type Filter = 'tracked' | 'low' | 'out' | 'untracked' | 'all';
function filterSql(f: Filter): string {
  switch (f) {
    case 'tracked': return 'i.stock_quantity is not null';
    case 'low': return 'i.stock_quantity is not null and (i.stock_quantity <= 0 or (i.low_stock is not null and i.stock_quantity <= i.low_stock))';
    case 'out': return 'i.stock_quantity is not null and i.stock_quantity <= 0';
    case 'untracked': return 'i.stock_quantity is null';
    default: return 'true';
  }
}

async function loadStock(db: Queryable, tenantId: string, itemId: string): Promise<StockRow> {
  const r = (await db.query<StockRow>(`select ${STOCK_COLUMNS} from items i where i.id = $1 and i.tenant_id = $2 and i.archived_at is null`, [itemId, tenantId])).rows[0];
  if (!r) throw notFound('Item');
  return r;
}

export function registerInventoryRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const itemParams = { type: 'object', required: ['itemId'], properties: { itemId: uuid } } as const;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'catalog.manage') && !can(request.principal, 'documents.issue')) requirePermission(request, 'reports.view');
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StockError) throw new ApiError(422, 'invalid_stock', e.message);
      throw e;
    }
  };

  const listQuery = {
    type: 'object', additionalProperties: false,
    properties: { filter: { type: 'string', enum: ['tracked', 'low', 'out', 'untracked', 'all'] }, q: { type: 'string', maxLength: 100 }, limit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' } },
  } as const;
  // Query strings arrive as text (no type coercion): the limit is digits.
  type ListQuery = { filter?: Filter; q?: string; limit?: string };
  const list = async (tenantId: string, query: ListQuery, max = 2000) => {
    const params: unknown[] = [tenantId];
    let where = `i.tenant_id = $1 and i.archived_at is null and ${filterSql(query.filter ?? 'tracked')}`;
    const text = query.q?.trim();
    if (text) {
      params.push(`%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, text);
      where += ` and (i.name ilike $${params.length - 1} or i.seller_code ilike $${params.length - 1} or i.barcode = $${params.length})`;
    }
    params.push(Math.min(query.limit ? Number(query.limit) : max, max));
    return (await db.query<StockRow>(
      `select ${STOCK_COLUMNS} from items i where ${where}
       order by case when i.stock_quantity is null then 2 when i.stock_quantity <= 0 then 0 when i.low_stock is not null and i.stock_quantity <= i.low_stock then 0 else 1 end, lower(i.name)
       limit $${params.length}`,
      params,
    )).rows.map(stockJson);
  };

  app.get<{ Querystring: ListQuery }>('/inventory', { schema: { querystring: listQuery } }, async (request) => {
    canRead(request);
    const t = (await db.query<{ tracked: number; untracked: number; low: number; out: number; value: unknown }>(
      `select count(*) filter (where stock_quantity is not null)::int as tracked, count(*) filter (where stock_quantity is null)::int as untracked,
         count(*) filter (where stock_quantity is not null and stock_quantity > 0 and low_stock is not null and stock_quantity <= low_stock)::int as low,
         count(*) filter (where stock_quantity is not null and stock_quantity <= 0)::int as out,
         coalesce(round(sum(greatest(stock_quantity, 0) * coalesce(average_cost, 0)) * 100), 0) as value
       from items where tenant_id = $1 and archived_at is null`,
      [request.tenantId],
    )).rows[0]!;
    return { data: await list(request.tenantId, request.query, 500), totals: { tracked: t.tracked, untracked: t.untracked, low: t.low, out: t.out, value: formatCents(toBigInt(t.value)) } };
  });

  app.get<{ Querystring: ListQuery }>('/inventory.csv', { schema: { querystring: listQuery } }, async (request, reply) => {
    canRead(request);
    const rows = await list(request.tenantId, { ...request.query, filter: request.query.filter ?? 'tracked' });
    const lines = [['Item', 'Code', 'Barcode', 'Unit', 'In stock', 'Low at', 'Average cost', 'Value', 'Price'].map((h) => csvCell(h)).join(',')];
    for (const r of rows) {
      lines.push([csvCell(r.name), csvCell(r.sellerCode ?? ''), csvCell(r.barcode ?? ''), csvCell(r.unitCode), csvCell(r.stock ?? '', false), csvCell(r.lowStock ?? '', false),
        csvCell(r.averageCost ?? '', false), csvCell(r.value, false), csvCell(r.price, false)].join(','));
    }
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="stock-${belizeToday()}.csv"`).send(`﻿${lines.join('\r\n')}\r\n`);
  });

  // ---------- stock received ----------
  // (Registered before /inventory/:itemId so "receipts" is never read as an item id.)
  app.get('/inventory/receipts', async (request) => {
    canRead(request);
    const rows = (await db.query<{ id: string; supplier_name: string | null; reference: string | null; received_on: string; total_cost_cents: unknown; expense_id: string | null; lines: number; created_by_name: string | null }>(
      `select r.id, r.supplier_name, r.reference, r.received_on::text as received_on, r.total_cost_cents, r.expense_id, u.name as created_by_name,
         (select count(*)::int from stock_movements m where m.receipt_id = r.id) as lines
       from stock_receipts r left join users u on u.id = r.created_by where r.tenant_id = $1 order by r.received_on desc, r.created_at desc limit 200`,
      [request.tenantId],
    )).rows;
    return { data: rows.map((r) => ({ id: r.id, supplier: r.supplier_name, reference: r.reference, receivedOn: r.received_on, totalCost: formatCents(toBigInt(r.total_cost_cents)), expenseId: r.expense_id, lines: r.lines, receivedBy: r.created_by_name })) };
  });

  type ReceiptBody = {
    supplierId?: string; supplierName?: string; supplierTin?: string; reference?: string; receivedOn: string; note?: string;
    lines: Array<{ itemId: string; quantity: string; unitCost: string }>;
    expense?: { gstTreatment: 'standard' | 'zero' | 'exempt' | 'none'; paid?: { on: string; method: string } | null; dueDate?: string | null } | null;
  };
  app.post<{ Body: ReceiptBody }>(
    '/inventory/receipts',
    {
      schema: {
        body: {
          type: 'object', required: ['receivedOn', 'lines'], additionalProperties: false,
          properties: {
            supplierId: uuid, supplierName: { type: 'string', maxLength: 200 }, supplierTin: { type: 'string', pattern: '^\\d{6}$' }, reference: { type: 'string', maxLength: 100 },
            receivedOn: dateSchema, note: { type: 'string', maxLength: 500 },
            lines: {
              type: 'array', minItems: 1, maxItems: 200,
              items: { type: 'object', required: ['itemId', 'quantity', 'unitCost'], additionalProperties: false, properties: { itemId: uuid, quantity: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,3})?$' }, unitCost: { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,6})?$' } } },
            },
            expense: {
              type: ['object', 'null'], required: ['gstTreatment'], additionalProperties: false,
              properties: {
                gstTreatment: { type: 'string', enum: ['standard', 'zero', 'exempt', 'none'] },
                paid: { type: ['object', 'null'], required: ['on', 'method'], additionalProperties: false, properties: { on: dateSchema, method: { type: 'string', enum: ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'] } } },
                dueDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      if (b.expense) requirePermission(request, 'expenses.manage');
      if (b.receivedOn > belizeToday()) throw new ApiError(422, 'invalid_receipt', 'Stock cannot be received in the future');
      if (new Set(b.lines.map((l) => l.itemId)).size !== b.lines.length) throw new ApiError(422, 'invalid_receipt', 'Each item once per delivery');
      if (b.lines.some((l) => Number(l.quantity) <= 0)) throw new ApiError(422, 'invalid_receipt', 'Quantities must be more than zero');
      let supplierName = b.supplierName?.trim() || null;
      let supplierTin = b.supplierTin ?? null;
      if (b.supplierId) {
        const s = (await db.query<{ name: string; tin: string | null }>('select name, tin from suppliers where id = $1 and tenant_id = $2', [b.supplierId, request.tenantId])).rows[0];
        if (!s) throw new ApiError(422, 'invalid_receipt', 'That supplier is not in your list');
        supplierName = s.name;
        supplierTin = supplierTin ?? s.tin;
      }
      if (b.expense && !supplierName) throw new ApiError(422, 'invalid_receipt', 'Name the supplier to record the bill');
      const items = (await db.query<{ id: string }>('select id from items where tenant_id = $1 and id = any($2::uuid[]) and archived_at is null', [request.tenantId, b.lines.map((l) => l.itemId)])).rows;
      if (items.length !== b.lines.length) throw new ApiError(422, 'invalid_receipt', 'An item is not in your catalog');
      // The cost of the delivery before GST, line by line to the cent.
      const net = b.lines.reduce((a, l) => a + roundToCents(mul(parseDecimal(l.quantity), parseDecimal(l.unitCost))), 0n);
      const receiptId = randomUUID();
      const result = await db.transaction(async (tx) => {
        let expenseId: string | null = null;
        if (b.expense) {
          // Unit costs are before GST: a standard-rated delivery adds 12.5% on top.
          const gst = b.expense.gstTreatment === 'standard' ? roundToCents(mul({ units: net, scale: 2 }, { units: 125n, scale: 3 })) : 0n;
          expenseId = randomUUID();
          await tx.query(
            `insert into expenses (id, tenant_id, supplier_id, supplier_name, supplier_tin, reference, expense_date, due_date, category, description, gst_treatment, net_cents, gst_cents, total_cents, claim_gst, paid_on, payment_method, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'Stock for resale', $9, $10, $11, $12, $13, true, $14, $15, $16)`,
            [expenseId, request.tenantId, b.supplierId ?? null, supplierName, supplierTin, b.reference?.trim() || null, b.receivedOn, b.expense.paid ? null : b.expense.dueDate ?? null,
              `Stock received: ${b.lines.length} item${b.lines.length === 1 ? '' : 's'}`, b.expense.gstTreatment, String(net), String(gst), String(net + gst),
              b.expense.paid?.on ?? null, b.expense.paid?.method ?? null, request.userId || null],
          );
        }
        await tx.query(
          'insert into stock_receipts (id, tenant_id, supplier_id, supplier_name, reference, received_on, total_cost_cents, expense_id, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [receiptId, request.tenantId, b.supplierId ?? null, supplierName, b.reference?.trim() || null, b.receivedOn, String(net), expenseId, b.note?.trim() || null, request.userId || null],
        );
        for (const l of b.lines) {
          await moveStock(tx, { tenantId: request.tenantId, itemId: l.itemId, quantity: stockQuantity(l.quantity), reason: 'receive', receiptId, unitCost: l.unitCost, startTracking: true, userId: request.userId || null, ...(b.reference && { note: b.reference }) });
        }
        return { expenseId };
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'stock.received', target: supplierName ?? b.reference ?? '', details: { lines: b.lines.length, cost: formatCents(net) }, ip: request.ip });
      return reply.code(201).send({ id: receiptId, totalCost: formatCents(net), expenseId: result.expenseId });
    },
  );

  // ---------- counts and adjustments ----------
  app.post<{ Body: { counts: Array<{ itemId: string; quantity: string }>; note?: string } }>(
    '/inventory/count',
    {
      schema: {
        body: {
          type: 'object', required: ['counts'], additionalProperties: false,
          properties: { note: { type: 'string', maxLength: 500 }, counts: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', required: ['itemId', 'quantity'], additionalProperties: false, properties: { itemId: uuid, quantity: qty } } } },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      let changed = 0;
      await db.transaction(async (tx) => {
        for (const c of b.counts) {
          const before = (await tx.query<{ s: string | null }>('select stock_quantity::text as s from items where id = $1 and tenant_id = $2 and archived_at is null', [c.itemId, request.tenantId])).rows[0];
          if (!before) throw new ApiError(422, 'invalid_stock', 'An item is not in your catalog');
          if (before.s !== null && Number(before.s) === Number(c.quantity)) continue;
          await moveStock(tx, { tenantId: request.tenantId, itemId: c.itemId, quantity: c.quantity, mode: 'set', reason: 'count', startTracking: true, note: b.note ?? 'Stock count', userId: request.userId || null });
          changed++;
        }
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'stock.counted', details: { items: b.counts.length, changed }, ip: request.ip });
      return { counted: b.counts.length, changed };
    },
  );

  app.get<{ Params: { itemId: string } }>('/inventory/:itemId', { schema: { params: itemParams } }, async (request) => {
    canRead(request);
    const item = stockJson(await loadStock(db, request.tenantId, request.params.itemId));
    const moves = (await db.query<{ id: string; change: string; balance_after: string; reason: string; note: string | null; unit_cost: string | null; created_at: Date | string; user_name: string | null;
      document_id: string | null; etd_type: string | null; series_number: number | null; serial: string | null; order_id: string | null; order_number: number | null; receipt_id: string | null; receipt_ref: string | null; supplier_name: string | null }>(
      `select m.id, m.change::text as change, m.balance_after::text as balance_after, m.reason, m.note, m.unit_cost::text as unit_cost, m.created_at, u.name as user_name,
         m.document_id, d.etd_type, d.series_number, d.serial::text as serial, m.order_id, o.number as order_number, m.receipt_id, r.reference as receipt_ref, r.supplier_name
       from stock_movements m left join users u on u.id = m.created_by left join documents d on d.id = m.document_id left join orders o on o.id = m.order_id
         left join stock_receipts r on r.id = m.receipt_id
       where m.item_id = $1 and m.tenant_id = $2 order by m.created_at desc limit 200`,
      [request.params.itemId, request.tenantId],
    )).rows;
    return {
      ...item,
      movements: moves.map((m) => ({
        id: m.id, change: Number(m.change), balance: Number(m.balance_after), reason: m.reason, note: m.note, unitCost: m.unit_cost === null ? null : Number(m.unit_cost).toFixed(2),
        at: new Date(m.created_at).toISOString(), by: m.user_name,
        document: m.document_id ? { id: m.document_id, type: m.etd_type, number: `${String(m.series_number).padStart(3, '0')}-${String(m.serial).padStart(9, '0')}` } : null,
        order: m.order_id ? { id: m.order_id, number: m.order_number } : null,
        receipt: m.receipt_id ? { id: m.receipt_id, reference: m.receipt_ref, supplier: m.supplier_name } : null,
      })),
    };
  });

  app.post<{ Params: { itemId: string }; Body: { mode: 'change' | 'set'; quantity: string; reason: AdjustReason; note?: string } }>(
    '/inventory/:itemId/adjust',
    {
      schema: {
        params: itemParams,
        body: { type: 'object', required: ['mode', 'quantity', 'reason'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['change', 'set'] }, quantity: qty, reason: { type: 'string', enum: [...ADJUST_REASONS] }, note: { type: 'string', maxLength: 500 } } },
      },
    },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const item = await loadStock(db, request.tenantId, request.params.itemId);
      if (item.stock === null) throw new ApiError(409, 'not_tracked', 'Start tracking this item’s stock first');
      if (b.mode === 'change' && Number(b.quantity) === 0) throw new ApiError(422, 'invalid_stock', 'Change it by something other than zero');
      const done = await wrap(() => moveStock(db, { tenantId: request.tenantId, itemId: item.id, quantity: b.quantity, mode: b.mode, reason: b.reason, note: b.note ?? null, userId: request.userId || null }));
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'stock.adjusted', target: item.name, details: { reason: b.reason, change: done?.change ?? null }, ip: request.ip });
      return stockJson(await loadStock(db, request.tenantId, item.id));
    },
  );

  app.put<{ Params: { itemId: string }; Body: { track: boolean; quantity?: string; lowStock?: string | null } }>(
    '/inventory/:itemId/settings',
    { schema: { params: itemParams, body: { type: 'object', required: ['track'], additionalProperties: false, properties: { track: { type: 'boolean' }, quantity: qty, lowStock: { type: ['string', 'null'], pattern: '^\\d{1,12}(\\.\\d{1,3})?$' } } } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const item = await loadStock(db, request.tenantId, request.params.itemId);
      if (b.track && item.stock === null) {
        await wrap(() => moveStock(db, { tenantId: request.tenantId, itemId: item.id, quantity: b.quantity ?? '0', mode: 'set', reason: 'count', startTracking: true, note: 'Started tracking stock', userId: request.userId || null }));
      }
      if (!b.track && item.stock !== null) await db.query('update items set stock_quantity = null where id = $1', [item.id]);
      if (b.lowStock !== undefined) await db.query('update items set low_stock = $2 where id = $1', [item.id, b.lowStock]);
      return stockJson(await loadStock(db, request.tenantId, item.id));
    },
  );
}
