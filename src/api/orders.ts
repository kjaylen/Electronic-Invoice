/**
 * Online orders, for the business's staff.
 *
 *   GET  /v1/orders                 list: view=to_do (default) | unpaid | unfulfilled | done | cancelled | all
 *   GET  /v1/orders/:id
 *   POST /v1/orders/:id/paid        payment received: issues the BTS receipt (or tax invoice) and emails it
 *   POST /v1/orders/:id/fulfilled   delivered or picked up
 *   POST /v1/orders/:id/cancel      cancel an unpaid order; its stock goes back
 *   POST /v1/orders/:id/refund      refund a paid order (all or some lines): a credit note against its document
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { BELIZE_DISTRICTS } from '../engine/ubl.ts';
import { cancelOrder, centsString, fulfillOrder, loadOrder, loadRefunds, markOrderPaid, type OrderLineRow, type OrderRow, refundable, refundOrder, type RefundRow, trimDecimal } from '../commerce/store.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { checkCreditLimit, sendDocumentEmail } from './documents.ts';
import { notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';
import { assertCanIssue } from '../billing/billing.ts';

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

export function orderJson(o: OrderRow, lines?: OrderLineRow[], document?: { id: string; status: string; type: string; series: string; number: string } | null) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    paymentStatus: o.payment_status,
    fulfillmentStatus: o.fulfillment_status,
    paymentMethod: o.payment_method,
    fulfillment: o.fulfillment,
    deliveryZone: o.delivery_zone,
    deliveryFee: trimDecimal(o.delivery_fee),
    customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
    address: o.street ? { street: o.street, city: o.city, districtCode: o.district_code, districtName: o.district_code ? BELIZE_DISTRICTS[o.district_code] : null } : null,
    business: o.buyer_tin ? { tin: o.buyer_tin, name: o.buyer_name } : null,
    note: o.note,
    discount: o.discount_code ? { code: o.discount_code, net: centsString(o.discount_cents ?? 0) } : null,
    totals: { lineExtension: centsString(o.line_extension_cents), gst: centsString(o.gst_cents), total: centsString(o.total_cents), refunded: centsString(o.refunded_cents ?? 0) },
    documentId: o.document_id,
    ...(document !== undefined && { document }),
    ...(lines && {
      lines: lines.map((l) => ({
        lineNumber: l.line_number,
        variantId: l.item_id,
        productTitle: l.product_title,
        variantTitle: l.variant_title,
        quantity: Number(l.quantity),
        unitPrice: trimDecimal(l.unit_price),
        gstCategory: l.gst_category,
        total: centsString(l.total_cents),
      })),
    }),
    createdAt: iso(o.created_at),
    paidAt: iso(o.paid_at),
    fulfilledAt: iso(o.fulfilled_at),
    cancelledAt: iso(o.cancelled_at),
    cancelReason: o.cancel_reason,
  };
}

/** Refunds made and what is left to refund, for the order page. */
async function refundsJson(deps: PipelineDeps, tenantId: string, order: OrderRow, lines: OrderLineRow[]) {
  const refunds = await loadRefunds(deps.db, tenantId, order.id);
  const left = refundable(order, lines, refunds);
  const docs = await Promise.all(refunds.map((r) => documentSummary(deps, tenantId, r.document_id)));
  return {
    refunds: refunds.map((r: RefundRow, i) => ({
      id: r.id, amount: centsString(r.amount_cents), lines: r.lines, delivery: r.delivery, reason: r.reason, restocked: r.restocked, createdAt: iso(r.created_at), document: docs[i],
    })),
    refundable: { lines: [...left.lines].map(([lineNumber, quantity]) => ({ lineNumber, quantity: Math.max(0, quantity) })), delivery: left.delivery },
  };
}

/** The full order for its page: lines, document, refunds. */
async function fullOrder(deps: PipelineDeps, tenantId: string, orderId: string) {
  const loaded = (await loadOrder(deps.db, tenantId, { id: orderId }))!;
  const payments = (await deps.db.query<{ id: string; provider: string; status: string; amount_cents: unknown; currency: string; charged_amount: string | null; transaction_id: string | null; created_at: Date }>(
    'select id, provider, status, amount_cents, currency, charged_amount, transaction_id, created_at from order_payments where order_id = $1 order by created_at', [orderId],
  )).rows;
  return {
    ...orderJson(loaded.order, loaded.lines, await documentSummary(deps, tenantId, loaded.order.document_id)),
    ...(await refundsJson(deps, tenantId, loaded.order, loaded.lines)),
    payments: payments.map((p) => ({ id: p.id, provider: p.provider, status: p.status, amount: centsString(p.amount_cents), charged: p.charged_amount ? `${p.currency} ${p.charged_amount}` : null, transactionId: p.transaction_id, createdAt: iso(p.created_at) })),
  };
}

export async function documentSummary(deps: PipelineDeps, tenantId: string, documentId: string | null) {
  if (!documentId) return null;
  const d = (await deps.db.query<{ id: string; status: string; etd_type: string; series_number: number; serial: unknown }>(
    'select id, status, etd_type, series_number, serial from documents where id = $1 and tenant_id = $2', [documentId, tenantId],
  )).rows[0];
  return d ? { id: d.id, status: d.status, type: d.etd_type, series: String(d.series_number).padStart(3, '0'), number: String(d.serial).padStart(9, '0') } : null;
}

const VIEWS: Record<string, string> = {
  to_do: `status = 'open' and (payment_status = 'unpaid' or fulfillment_status = 'unfulfilled')`,
  unpaid: `status = 'open' and payment_status = 'unpaid'`,
  unfulfilled: `status = 'open' and fulfillment_status = 'unfulfilled'`,
  done: `status = 'open' and payment_status = 'paid' and fulfillment_status = 'fulfilled'`,
  cancelled: `status = 'cancelled'`,
  all: 'true',
};

export function registerOrderRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

  app.get<{ Querystring: { view?: string; q?: string } }>(
    '/orders',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { view: { type: 'string', enum: Object.keys(VIEWS) }, q: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      const params: unknown[] = [request.tenantId];
      let where = `tenant_id = $1 and ${VIEWS[request.query.view ?? 'to_do']}`;
      const q = request.query.q?.trim();
      if (q) {
        if (/^#?\d{1,9}$/.test(q)) {
          params.push(Number(q.replace('#', '')));
          where += ` and number = $${params.length}`;
        } else {
          params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          where += ` and (customer_name ilike $${params.length} or customer_phone like $${params.length} or customer_email ilike $${params.length})`;
        }
      }
      const rows = (await db.query<OrderRow>(`select * from orders where ${where} order by created_at desc limit 300`, params)).rows;
      const counts = (await db.query<{ unpaid: number; unfulfilled: number }>(
        `select count(*) filter (where ${VIEWS.unpaid})::int as unpaid, count(*) filter (where ${VIEWS.unfulfilled})::int as unfulfilled from orders where tenant_id = $1`,
        [request.tenantId],
      )).rows[0]!;
      return { data: rows.map((o) => orderJson(o)), counts };
    },
  );

  app.get<{ Params: { id: string } }>('/orders/:id', { schema: { params: idParams } }, async (request) => {
    const loaded = await loadOrder(db, request.tenantId, { id: request.params.id });
    if (!loaded) throw notFound('Order');
    return fullOrder(deps, request.tenantId, loaded.order.id);
  });

  app.post<{ Params: { id: string } }>('/orders/:id/paid', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    await assertCanIssue(db, request.tenantId);
    const { order, document } = await markOrderPaid(deps, request.tenantId, request.params.id, request.userId || null);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.paid', target: `#${order.number}`, ip: request.ip });
    // Email the buyer their receipt when it is ready (best effort: the order page always has it too).
    let emailed = false;
    if (document && order.customer_email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
      try {
        await sendDocumentEmail(deps, ctx, request.tenantId, document.documentId, { to: order.customer_email, message: `Thank you for your order #${order.number}.`, userId: request.userId || null });
        emailed = true;
      } catch (e) {
        request.log.error({ err: e }, 'order receipt email failed');
      }
    }
    return { ...(await fullOrder(deps, request.tenantId, order.id)), emailed };
  });

  app.post<{ Params: { id: string } }>('/orders/:id/fulfilled', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'orders.manage');
    await fulfillOrder(db, request.tenantId, request.params.id);
    const full = await fullOrder(deps, request.tenantId, request.params.id);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.fulfilled', target: `#${full.number}`, ip: request.ip });
    return full;
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/orders/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } } },
    async (request) => {
      requirePermission(request, 'orders.manage');
      await cancelOrder(db, request.tenantId, request.params.id, request.body.reason);
      const loaded = (await loadOrder(db, request.tenantId, { id: request.params.id }))!;
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.cancelled', target: `#${loaded.order.number}`, details: { reason: request.body.reason }, ip: request.ip });
      return orderJson(loaded.order, loaded.lines, null);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string; lines?: Array<{ lineNumber: number; quantity: number }>; delivery?: boolean; restock?: boolean } }>(
    '/orders/:id/refund',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['reason'], additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            lines: {
              type: 'array', minItems: 1, maxItems: 100,
              items: { type: 'object', required: ['lineNumber', 'quantity'], additionalProperties: false, properties: { lineNumber: { type: 'integer', minimum: 1 }, quantity: { type: 'integer', minimum: 0, maximum: 9999 } } },
            },
            delivery: { type: 'boolean' },
            restock: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'documents.adjust');
      const { refundId, document, amount } = await refundOrder(deps, request.tenantId, request.params.id, request.body, request.userId || null,
        (req) => checkCreditLimit(deps, request.tenantId, req));
      const full = await fullOrder(deps, request.tenantId, request.params.id);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.refunded', target: `#${full.number}`, details: { amount, reason: request.body.reason, refundId }, ip: request.ip });
      // Email the buyer their credit note (best effort).
      let emailed = false;
      if (full.customer.email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
        try {
          await sendDocumentEmail(deps, ctx, request.tenantId, document.documentId, { to: full.customer.email, message: `Your refund for order #${full.number}.`, userId: request.userId || null });
          emailed = true;
        } catch (e) {
          request.log.error({ err: e }, 'refund email failed');
        }
      }
      return { ...full, refund: { id: refundId, amount, documentId: document.documentId, status: document.status }, emailed };
    },
  );
}
