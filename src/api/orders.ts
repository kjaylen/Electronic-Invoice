/**
 * Online orders, for the business's staff.
 *
 *   GET  /v1/orders                 list: view=to_do (default) | unpaid | unfulfilled | done | cancelled | all
 *   GET  /v1/orders/:id
 *   GET  /v1/store-checkouts        checkouts left unfinished (view=open|recovered|all) and the last 30 days' reminders and recovered sales
 *   GET  /v1/store-buyers?q=        buyers with an account at the store: their orders and what they spent
 *   POST /v1/orders/:id/paid        payment received: issues the BTS receipt (or tax invoice) and emails it
 *   POST /v1/orders/:id/ready       ready for pickup or out for delivery { message?, notify? }: emails the buyer
 *   POST /v1/orders/:id/fulfilled   delivered or picked up
 *   POST /v1/orders/:id/cancel      cancel an unpaid order; its stock goes back
 *   POST /v1/orders/:id/refund      refund a paid order (all or some lines): a credit note against its document
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { toBigInt } from '../db/database.ts';
import { BELIZE_DISTRICTS } from '../engine/ubl.ts';
import { formatCents } from '../engine/decimal.ts';
import { cancelOrder, centsString, fulfillOrder, loadOrder, loadRefunds, markOrderPaid, type OrderLineRow, type OrderRow, refundable, refundOrder, type RefundRow, trimDecimal } from '../commerce/store.ts';
import { checkoutSummary, listCheckouts } from '../commerce/checkouts.ts';
import { listBuyers } from '../commerce/buyers.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { checkCreditLimit, sendDocumentEmail } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { renderEmail } from '../templates/render.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';
import { assertCanIssue } from '../billing/billing.ts';
import { emailLanguage, PHRASES } from '../templates/lang.ts';

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
    // Paid partly (or fully) with a gift card; the rest is what is collected the way chosen.
    giftCard: toBigInt(o.gift_card_cents ?? 0) > 0n ? { amount: centsString(o.gift_card_cents) } : null,
    amountDue: formatCents(toBigInt(o.total_cents) - toBigInt(o.gift_card_cents ?? 0)),
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
    readyAt: iso(o.ready_at ?? null),
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
    const full = await fullOrder(deps, request.tenantId, loaded.order.id);
    // Placed after a checkout reminder.
    const recovered = (await db.query('select 1 from store_checkouts where tenant_id = $1 and order_id = $2 and recovered limit 1', [request.tenantId, loaded.order.id])).rows.length > 0;
    return { ...full, recoveredByReminder: recovered };
  });

  // Checkouts left unfinished (checkout reminders), and the last 30 days' summary.
  app.get<{ Querystring: { view?: 'open' | 'recovered' | 'all' } }>(
    '/store-checkouts',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { view: { type: 'string', enum: ['open', 'recovered', 'all'] } } } } },
    async (request) => {
      requirePermission(request, 'orders.manage');
      return { data: await listCheckouts(db, request.tenantId, request.query.view ?? 'open'), summary: await checkoutSummary(db, request.tenantId) };
    },
  );

  // Buyers with an account at the store.
  app.get<{ Querystring: { q?: string } }>(
    '/store-buyers',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      requirePermission(request, 'orders.manage');
      return { data: await listBuyers(db, request.tenantId, request.query.q) };
    },
  );

  app.post<{ Params: { id: string } }>('/orders/:id/paid', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    await assertCanIssue(db, request.tenantId);
    const { order, document } = await markOrderPaid(deps, request.tenantId, request.params.id, request.userId || null, request.posDevice?.id ?? null);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.paid', target: `#${order.number}`, ip: request.ip });
    // Email the buyer their receipt when it is ready (best effort: the order page always has it too).
    let emailed = false;
    if (document && order.customer_email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
      try {
        await sendDocumentEmail(deps, ctx, request.tenantId, document.documentId, { to: order.customer_email, message: PHRASES[await emailLanguage(db, request.tenantId)].orderThanks(order.number), userId: request.userId || null });
        emailed = true;
      } catch (e) {
        request.log.error({ err: e }, 'order receipt email failed');
      }
    }
    return { ...(await fullOrder(deps, request.tenantId, order.id)), emailed };
  });

  // Ready for pickup, or out for delivery: the buyer is told by email (when they gave one).
  app.post<{ Params: { id: string }; Body: { message?: string; notify?: boolean } | null }>(
    '/orders/:id/ready',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { message: { type: 'string', maxLength: 1000 }, notify: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'orders.manage');
      const loaded = await loadOrder(db, request.tenantId, { id: request.params.id });
      if (!loaded) throw notFound('Order');
      const o = loaded.order;
      if (o.status !== 'open' || o.fulfillment_status !== 'unfulfilled') throw new ApiError(409, 'not_open', 'This order is closed or already delivered');
      await db.query('update orders set ready_at = now() where id = $1 and tenant_id = $2', [o.id, request.tenantId]);
      let emailed: string | null = null;
      if (request.body?.notify !== false && o.customer_email && ctx.mailConfigured) {
        const t = (await db.query<{ name: string; telephone: string; city: string; street: string; email: string; store_settings: { pickup?: { instructions?: string } } | null }>(
          'select coalesce(trade_name, legal_name) as name, telephone, city, street, email, store_settings from tenants where id = $1', [request.tenantId],
        )).rows[0]!;
        const lang = await emailLanguage(db, request.tenantId);
        const mail = await renderEmail(db, request.tenantId, 'email.order-ready', {
          store: { name: t.name, city: t.city, telephone: t.telephone },
          order: {
            number: o.number, customer_name: o.customer_name, delivery: o.fulfillment === 'delivery', address: o.delivery_zone,
            pickup_address: `${t.street}, ${t.city}`, pickup_instructions: t.store_settings?.pickup?.instructions || null,
            items: loaded.lines.map((l) => ({ name: l.product_title, variant: l.variant_title, quantity: Number(l.quantity) })),
          },
          message: request.body?.message?.trim() || null,
        }, { publicUrl: ctx.publicUrl, lang });
        await ctx.mailer.send({ to: o.customer_email, replyTo: t.email, subject: mail.subject, text: mail.text, html: mail.html });
        emailed = o.customer_email;
      }
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.ready', target: `#${o.number}`, details: { emailed }, ip: request.ip });
      return { ...(await fullOrder(deps, request.tenantId, o.id)), emailed };
    },
  );

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
      const { refundId, document, amount, toGiftCard } = await refundOrder(deps, request.tenantId, request.params.id, request.body, request.userId || null,
        (req) => checkCreditLimit(deps, request.tenantId, req));
      const full = await fullOrder(deps, request.tenantId, request.params.id);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'order.refunded', target: `#${full.number}`, details: { amount, reason: request.body.reason, refundId }, ip: request.ip });
      // Email the buyer their credit note (best effort).
      let emailed = false;
      if (full.customer.email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
        try {
          await sendDocumentEmail(deps, ctx, request.tenantId, document.documentId, { to: full.customer.email, message: PHRASES[await emailLanguage(db, request.tenantId)].refund(full.number), userId: request.userId || null });
          emailed = true;
        } catch (e) {
          request.log.error({ err: e }, 'refund email failed');
        }
      }
      return { ...full, refund: { id: refundId, amount, toGiftCard, documentId: document.documentId, status: document.status }, emailed };
    },
  );
}
