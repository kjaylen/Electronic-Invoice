/**
 * Purchase orders: what a business orders from its suppliers (owners, admins and managers).
 *
 *   GET  /v1/purchase-orders                 list (status: open | draft | sent | partial | received | cancelled; q)
 *   GET  /v1/purchase-orders/suggestions     items to reorder: at or below their low-stock level, counting what is on order,
 *                                            with a quantity for about four weeks of sales and the supplier they came from last
 *   GET  /v1/purchase-orders/:id             one order with its lines and the deliveries received against it
 *   POST /v1/purchase-orders                 { supplierId? | supplierName, supplierEmail?, expectedOn?, note?, lines: [{ itemId, quantity, unitCost? }] }
 *   PUT  /v1/purchase-orders/:id             the same, while nothing has been received
 *   POST /v1/purchase-orders/:id/send        { to?, message?, email?: false }: email the PDF (or just mark it sent)
 *   POST /v1/purchase-orders/:id/cancel      cancel it; a part-received order is closed (the rest is not coming)
 *   GET  /v1/purchase-orders/:id/pdf
 *
 * Stock arrives through POST /v1/inventory/receipts with the order's purchaseOrderId: each delivery
 * adds to what each line has received, and the order becomes part-received, then received.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { overLimit } from '../db/ratelimit.ts';
import { formatCents, mul, parseDecimal, roundToCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderPurchaseOrder } from '../render/purchase-order.ts';
import { logoForPdf } from '../templates/assets.ts';
import { businessContext, renderEmail } from '../templates/render.ts';
import { requireMail, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { UNIT_NAMES } from './quotes.ts';
import { businessContact } from './receivables.ts';
import { date as dateSchema, uuid } from './schemas.ts';

export const poNumber = (n: number) => `PO-${n}`;
export const OPEN_PO = ['draft', 'sent', 'partial'] as const;
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const qtyText = (v: string | number) => String(Number(v));
/** numeric(24,6) "6.500000" -> "6.50"; more decimals kept when they matter. */
const costText = (v: string) => {
  const n = Number(v);
  return Number.isInteger(Math.round(n * 1e6) / 1e4) ? n.toFixed(2) : String(n);
};

interface PoRow {
  id: string;
  number: number;
  supplier_id: string | null;
  supplier_name: string;
  supplier_email: string | null;
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
  expected_on: string | null;
  note: string | null;
  total_cost_cents: string | bigint;
  sent_at: Date | string | null;
  created_at: Date | string;
  created_by_name: string | null;
}
interface LineRow { line_number: number; item_id: string; description: string; seller_code: string | null; unit_code: string; quantity: string; received: string; unit_cost: string }

const PO_COLUMNS = `p.id, p.number, p.supplier_id, p.supplier_name, p.supplier_email, p.status, p.expected_on::text as expected_on, p.note, p.total_cost_cents, p.sent_at, p.created_at, u.name as created_by_name`;

async function loadPo(db: Queryable, tenantId: string, id: string, forUpdate = false) {
  const po = (await db.query<PoRow>(`select ${PO_COLUMNS} from purchase_orders p left join users u on u.id = p.created_by where p.id = $1 and p.tenant_id = $2${forUpdate ? ' for update of p' : ''}`, [id, tenantId])).rows[0];
  if (!po) throw notFound('Purchase order');
  const lines = (await db.query<LineRow>(
    `select l.line_number, l.item_id, l.description, i.seller_code, i.unit_code, l.quantity::text as quantity, l.received::text as received, l.unit_cost::text as unit_cost
     from purchase_order_lines l join items i on i.id = l.item_id where l.purchase_order_id = $1 order by l.line_number`, [id],
  )).rows;
  return { po, lines };
}

function poJson(po: PoRow, lines: LineRow[]) {
  const today = belizeToday();
  return {
    id: po.id,
    number: poNumber(po.number),
    status: po.status,
    supplier: { id: po.supplier_id, name: po.supplier_name, email: po.supplier_email },
    expectedOn: po.expected_on,
    late: Boolean(po.expected_on && po.expected_on < today && (po.status === 'sent' || po.status === 'partial')),
    note: po.note,
    total: formatCents(toBigInt(po.total_cost_cents)),
    sentAt: po.sent_at ? new Date(po.sent_at).toISOString() : null,
    createdAt: new Date(po.created_at).toISOString(),
    createdBy: po.created_by_name,
    lines: lines.map((l) => {
      const remaining = Math.max(0, Number(l.quantity) - Number(l.received));
      return {
        lineNumber: l.line_number, itemId: l.item_id, description: l.description, code: l.seller_code, unitCode: l.unit_code,
        quantity: qtyText(l.quantity), received: qtyText(l.received), remaining: qtyText(Math.round(remaining * 1000) / 1000),
        unitCost: costText(l.unit_cost), total: formatCents(roundToCents(mul(parseDecimal(l.quantity), parseDecimal(l.unit_cost)))),
      };
    }),
  };
}

interface PoBody {
  supplierId?: string;
  supplierName?: string;
  supplierEmail?: string | null;
  expectedOn?: string | null;
  note?: string | null;
  lines: Array<{ itemId: string; quantity: string; unitCost?: string }>;
}
const poBody = {
  type: 'object', required: ['lines'], additionalProperties: false,
  properties: {
    supplierId: uuid,
    supplierName: { type: 'string', minLength: 1, maxLength: 200 },
    supplierEmail: { anyOf: [{ type: 'string', format: 'email', maxLength: 254 }, { type: 'null' }] },
    expectedOn: { anyOf: [dateSchema, { type: 'null' }] },
    note: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] },
    lines: {
      type: 'array', minItems: 1, maxItems: 200,
      items: {
        type: 'object', required: ['itemId', 'quantity'], additionalProperties: false,
        properties: { itemId: uuid, quantity: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,3})?$' }, unitCost: { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,6})?$' } },
      },
    },
  },
} as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

/** Checks an order's supplier and lines; fills in names and costs from the catalog. */
async function prepare(db: Queryable, tenantId: string, b: PoBody) {
  let supplierName = b.supplierName?.trim() || null;
  let supplierEmail = b.supplierEmail?.trim() || null;
  if (b.supplierId) {
    const s = (await db.query<{ name: string; email: string | null }>('select name, email from suppliers where id = $1 and tenant_id = $2 and archived_at is null', [b.supplierId, tenantId])).rows[0];
    if (!s) throw new ApiError(422, 'invalid_order', 'That supplier is not in your list');
    supplierName = s.name;
    if (b.supplierEmail === undefined) supplierEmail = s.email;
  }
  if (!supplierName) throw new ApiError(422, 'invalid_order', 'Choose the supplier');
  if (new Set(b.lines.map((l) => l.itemId)).size !== b.lines.length) throw new ApiError(422, 'invalid_order', 'Each item once per order');
  if (b.lines.some((l) => Number(l.quantity) <= 0)) throw new ApiError(422, 'invalid_order', 'Quantities must be more than zero');
  const items = new Map((await db.query<{ id: string; name: string; average_cost: string | null; last_cost: string | null }>(
    `select i.id, i.name, i.average_cost::text as average_cost,
       (select m.unit_cost::text from stock_movements m where m.item_id = i.id and m.receipt_id is not null and m.unit_cost is not null order by m.created_at desc limit 1) as last_cost
     from items i where i.tenant_id = $1 and i.id = any($2::uuid[]) and i.archived_at is null`, [tenantId, b.lines.map((l) => l.itemId)],
  )).rows.map((r) => [r.id, r]));
  const lines = b.lines.map((l, i) => {
    const item = items.get(l.itemId);
    if (!item) throw new ApiError(422, 'invalid_order', `Line ${i + 1}: that item is not in your catalog`);
    // The cost given, or what the item cost last time.
    const unitCost = l.unitCost ?? item.last_cost ?? item.average_cost ?? '0';
    return { itemId: l.itemId, description: item.name, quantity: l.quantity, unitCost, cents: roundToCents(mul(parseDecimal(l.quantity), parseDecimal(unitCost))) };
  });
  return { supplierName, supplierEmail, lines, total: lines.reduce((a, l) => a + l.cents, 0n) };
}

async function writeLines(tx: Queryable, poId: string, lines: Awaited<ReturnType<typeof prepare>>['lines']) {
  await tx.query('delete from purchase_order_lines where purchase_order_id = $1', [poId]);
  for (const [i, l] of lines.entries()) {
    await tx.query('insert into purchase_order_lines (purchase_order_id, line_number, item_id, description, quantity, unit_cost) values ($1, $2, $3, $4, $5, $6)', [poId, i + 1, l.itemId, l.description, l.quantity, l.unitCost]);
  }
}

/**
 * A delivery against an order (inside the receipt's transaction): adds what came to each line of
 * the same item, and moves the order to part-received or received.
 */
export async function receiveAgainstOrder(tx: Queryable, tenantId: string, poId: string, lines: Array<{ itemId: string; quantity: string }>) {
  const po = (await tx.query<{ status: string }>('select status from purchase_orders where id = $1 and tenant_id = $2 for update', [poId, tenantId])).rows[0];
  if (!po) throw new ApiError(422, 'invalid_receipt', 'That purchase order is not yours');
  if (!(OPEN_PO as readonly string[]).includes(po.status)) throw new ApiError(409, 'order_closed', `This purchase order is ${po.status}; nothing more is received against it`);
  for (const l of lines) {
    await tx.query('update purchase_order_lines set received = received + $3 where purchase_order_id = $1 and item_id = $2', [poId, l.itemId, l.quantity]);
  }
  const left = (await tx.query<{ n: number }>('select count(*)::int as n from purchase_order_lines where purchase_order_id = $1 and received < quantity', [poId])).rows[0]!.n;
  await tx.query('update purchase_orders set status = $2, updated_at = now() where id = $1', [poId, left === 0 ? 'received' : 'partial']);
}

async function poPdf(db: Queryable, tenantId: string, po: PoRow, lines: LineRow[]) {
  const supplier = po.supplier_id
    ? (await db.query<{ telephone: string | null; address: string | null }>('select telephone, address from suppliers where id = $1', [po.supplier_id])).rows[0]
    : undefined;
  const j = poJson(po, lines);
  const logo = await logoForPdf(db, tenantId);
  return renderPurchaseOrder({
    business: await businessContact(db, tenantId),
    ...(logo && { logo }),
    number: j.number,
    date: (po.sent_at ? new Date(po.sent_at) : new Date(po.created_at)).toISOString().slice(0, 10),
    expectedOn: po.expected_on,
    supplier: { name: po.supplier_name, email: po.supplier_email, telephone: supplier?.telephone ?? null, address: supplier?.address ?? null },
    lines: j.lines.map((l) => ({ description: l.description, code: l.code, quantity: l.quantity, unit: UNIT_NAMES[l.unitCode] ?? '', unitCost: l.unitCost, total: l.total })),
    total: j.total,
    note: po.note,
  });
}

export function registerPurchasingRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  // Managers and up order stock; anyone who may see reports may look.
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'catalog.manage')) requirePermission(request, 'reports.view');
  };

  app.get<{ Querystring: { status?: string; q?: string } }>(
    '/purchase-orders',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', ...OPEN_PO, 'received', 'cancelled'] }, q: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      canRead(request);
      const params: unknown[] = [request.tenantId];
      let where = 'p.tenant_id = $1';
      const st = request.query.status;
      if (st === 'open') where += ` and p.status in ('draft', 'sent', 'partial')`;
      else if (st) {
        params.push(st);
        where += ` and p.status = $${params.length}`;
      }
      const q = request.query.q?.trim();
      if (q) {
        params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, q.replace(/^po-?/i, ''));
        where += ` and (p.supplier_name ilike $${params.length - 1} or p.number::text = $${params.length})`;
      }
      const rows = (await db.query<PoRow & { lines: number; ordered: string; received: string }>(
        `select ${PO_COLUMNS}, (select count(*)::int from purchase_order_lines l where l.purchase_order_id = p.id) as lines,
           (select coalesce(sum(l.quantity), 0)::text from purchase_order_lines l where l.purchase_order_id = p.id) as ordered,
           (select coalesce(sum(least(l.received, l.quantity)), 0)::text from purchase_order_lines l where l.purchase_order_id = p.id) as received
         from purchase_orders p left join users u on u.id = p.created_by where ${where} order by p.created_at desc limit 300`, params,
      )).rows;
      return {
        data: rows.map((r) => {
          const { lines: _l, ...rest } = poJson(r, []);
          return { ...rest, lineCount: r.lines, progress: Number(r.ordered) > 0 ? Math.round((Number(r.received) / Number(r.ordered)) * 100) / 100 : 0 };
        }),
      };
    },
  );

  app.get<{ Querystring: { supplierId?: string } }>(
    '/purchase-orders/suggestions',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { supplierId: uuid } } } },
    async (request) => {
      canRead(request);
      const rows = (await db.query<{ id: string; name: string; seller_code: string | null; unit_code: string; stock: string; low_stock: string | null; sold: string; on_order: string; supplier_id: string | null; supplier_name: string | null; supplier_email: string | null; cost: string | null }>(
        `with sold as (
           select item_id, -sum(change) as sold from stock_movements
           where tenant_id = $1 and reason in ('sale', 'sale_reversed', 'order', 'order_cancelled', 'refund') and created_at > now() - interval '30 days'
           group by item_id
         ), on_order as (
           select l.item_id, sum(greatest(l.quantity - l.received, 0)) as qty from purchase_order_lines l join purchase_orders p on p.id = l.purchase_order_id
           where p.tenant_id = $1 and p.status in ('draft', 'sent', 'partial') group by l.item_id
         ), last_in as (
           select distinct on (m.item_id) m.item_id, r.supplier_id, r.supplier_name, m.unit_cost from stock_movements m join stock_receipts r on r.id = m.receipt_id
           where m.tenant_id = $1 and m.receipt_id is not null order by m.item_id, m.created_at desc
         )
         select i.id, i.name, i.seller_code, i.unit_code, i.stock_quantity::text as stock, i.low_stock::text as low_stock,
           coalesce(s.sold, 0)::text as sold, coalesce(o.qty, 0)::text as on_order, li.supplier_id, coalesce(sp.name, li.supplier_name) as supplier_name, sp.email as supplier_email,
           coalesce(li.unit_cost, i.average_cost)::text as cost
         from items i left join sold s on s.item_id = i.id left join on_order o on o.item_id = i.id left join last_in li on li.item_id = i.id
           left join suppliers sp on sp.id = li.supplier_id
         where i.tenant_id = $1 and i.archived_at is null and i.stock_quantity is not null
           and i.stock_quantity + coalesce(o.qty, 0) <= coalesce(i.low_stock, 0)
           ${request.query.supplierId ? 'and li.supplier_id = $2' : ''}
         order by li.supplier_name nulls last, i.name limit 500`,
        request.query.supplierId ? [request.tenantId, request.query.supplierId] : [request.tenantId],
      )).rows;
      return {
        data: rows.map((r) => {
          const stock = Number(r.stock);
          const onOrder = Number(r.on_order);
          const sold = Math.max(0, Number(r.sold));
          const low = r.low_stock === null ? 0 : Number(r.low_stock);
          // Enough for about four weeks of sales, and at least twice the low-stock level.
          const target = Math.max(low * 2, Math.ceil((sold / 30) * 28), low + 1);
          const quantity = Math.max(1, Math.ceil(target - stock - onOrder));
          return {
            itemId: r.id, name: r.name, code: r.seller_code, unitCode: r.unit_code, stock: qtyText(stock), lowStock: r.low_stock === null ? null : qtyText(low),
            soldLast30Days: qtyText(sold), onOrder: qtyText(onOrder), quantity: String(quantity), unitCost: r.cost === null ? null : costText(r.cost),
            supplier: r.supplier_name ? { id: r.supplier_id, name: r.supplier_name, email: r.supplier_email } : null,
          };
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/purchase-orders/:id', { schema: { params: idParams } }, async (request) => {
    canRead(request);
    const { po, lines } = await loadPo(db, request.tenantId, request.params.id);
    const receipts = (await db.query<{ id: string; received_on: string; reference: string | null; total_cost_cents: string | bigint; expense_id: string | null }>(
      'select id, received_on::text as received_on, reference, total_cost_cents, expense_id from stock_receipts where purchase_order_id = $1 and tenant_id = $2 order by created_at', [po.id, request.tenantId],
    )).rows;
    return { ...poJson(po, lines), receipts: receipts.map((r) => ({ id: r.id, receivedOn: r.received_on, reference: r.reference, totalCost: formatCents(toBigInt(r.total_cost_cents)), expenseId: r.expense_id })) };
  });

  app.post<{ Body: PoBody }>('/purchase-orders', { schema: { body: poBody } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const b = request.body;
    const p = await prepare(db, request.tenantId, b);
    const id = randomUUID();
    const number = await db.transaction(async (tx) => {
      const n = (await tx.query<{ number: number }>('update tenants set next_po_number = next_po_number + 1 where id = $1 returning next_po_number - 1 as number', [request.tenantId])).rows[0]!.number;
      await tx.query(
        `insert into purchase_orders (id, tenant_id, number, supplier_id, supplier_name, supplier_email, expected_on, note, total_cost_cents, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, request.tenantId, n, b.supplierId ?? null, p.supplierName, p.supplierEmail, b.expectedOn ?? null, b.note?.trim() || null, String(p.total), request.userId || null],
      );
      await writeLines(tx, id, p.lines);
      return n;
    });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'purchase_order.created', target: poNumber(number), details: { supplier: p.supplierName, lines: p.lines.length, total: formatCents(p.total) }, ip: request.ip });
    const { po, lines } = await loadPo(db, request.tenantId, id);
    return reply.code(201).send({ ...poJson(po, lines), receipts: [] });
  });

  app.put<{ Params: { id: string }; Body: PoBody }>('/purchase-orders/:id', { schema: { params: idParams, body: poBody } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    const b = request.body;
    const p = await prepare(db, request.tenantId, b);
    await db.transaction(async (tx) => {
      const { po } = await loadPo(tx, request.tenantId, request.params.id, true);
      if (po.status !== 'draft' && po.status !== 'sent') throw new ApiError(409, 'not_editable', po.status === 'partial' ? 'Part of this order has arrived; it can no longer be changed' : `A ${po.status} order cannot be changed`);
      await tx.query(
        'update purchase_orders set supplier_id = $3, supplier_name = $4, supplier_email = $5, expected_on = $6, note = $7, total_cost_cents = $8, updated_at = now() where id = $1 and tenant_id = $2',
        [po.id, request.tenantId, b.supplierId ?? null, p.supplierName, p.supplierEmail, b.expectedOn ?? null, b.note?.trim() || null, String(p.total)],
      );
      await writeLines(tx, po.id, p.lines);
    });
    const { po, lines } = await loadPo(db, request.tenantId, request.params.id);
    return { ...poJson(po, lines), receipts: [] };
  });

  app.post<{ Params: { id: string }; Body: { to?: string; message?: string; email?: boolean } | undefined }>(
    '/purchase-orders/:id/send',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { to: { type: 'string', format: 'email', maxLength: 254 }, message: { type: 'string', maxLength: 2000 }, email: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const { po, lines } = await loadPo(db, request.tenantId, request.params.id);
      if (po.status !== 'draft' && po.status !== 'sent') throw new ApiError(409, 'not_open', `A ${po.status} order is not sent again`);
      const byEmail = request.body?.email !== false;
      let to: string | null = null;
      if (byEmail) {
        requireMail(ctx);
        to = request.body?.to ?? po.supplier_email;
        if (!to) throw new ApiError(422, 'no_email', 'This supplier has no email address; enter one');
        if (await overLimit(db, `po-send|${po.id}`, 10, 24 * 3600_000)) throw new ApiError(429, 'too_many_emails', 'Enough emails for this order today');
        if (await overLimit(db, `po-send-business|${request.tenantId}`, 200, 24 * 3600_000)) throw new ApiError(429, 'too_many_emails', 'Enough purchase order emails for today');
        const j = poJson(po, lines);
        const biz = await businessContext(db, request.tenantId);
        const mail = await renderEmail(db, request.tenantId, 'email.purchase-order', {
          business: biz,
          supplier: { name: po.supplier_name, email: to },
          order: { number: j.number, expected_on: po.expected_on, total: j.total, lines: j.lines.map((l) => ({ description: l.description, code: l.code, quantity: l.quantity, unit_cost: l.unitCost, total: l.total })) },
          message: request.body?.message?.trim() || null,
        }, { publicUrl: ctx.publicUrl });
        await ctx.mailer.send({ type: 'purchase-order', tenantId: request.tenantId, userId: request.userId || null,
          to, replyTo: biz.email, subject: mail.subject, text: mail.text, html: mail.html,
          attachments: [{ filename: `${j.number}.pdf`, content: await poPdf(db, request.tenantId, po, lines), contentType: 'application/pdf' }],
        });
      }
      await db.query("update purchase_orders set status = 'sent', sent_at = coalesce(sent_at, now()), supplier_email = coalesce($3, supplier_email), updated_at = now() where id = $1 and tenant_id = $2", [po.id, request.tenantId, to]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'purchase_order.sent', target: poNumber(po.number), details: to ? { to } : { email: false }, ip: request.ip });
      const after = await loadPo(db, request.tenantId, po.id);
      return { ...poJson(after.po, after.lines), to };
    },
  );

  app.post<{ Params: { id: string } }>('/purchase-orders/:id/cancel', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    const po = await db.transaction(async (tx) => {
      const { po } = await loadPo(tx, request.tenantId, request.params.id, true);
      if (!(OPEN_PO as readonly string[]).includes(po.status)) throw new ApiError(409, 'not_open', `This order is already ${po.status}`);
      await tx.query("update purchase_orders set status = 'cancelled', updated_at = now() where id = $1", [po.id]);
      return po;
    });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: po.status === 'partial' ? 'purchase_order.closed' : 'purchase_order.cancelled', target: poNumber(po.number), ip: request.ip });
    const after = await loadPo(db, request.tenantId, po.id);
    return poJson(after.po, after.lines);
  });

  app.get<{ Params: { id: string } }>('/purchase-orders/:id/pdf', { schema: { params: idParams } }, async (request, reply) => {
    canRead(request);
    const { po, lines } = await loadPo(db, request.tenantId, request.params.id);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${poNumber(po.number)}.pdf"`).send(await poPdf(db, request.tenantId, po, lines));
  });
}
