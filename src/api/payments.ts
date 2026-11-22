/**
 * Online payments: the business's payment account, and settling what was paid
 * (store orders, and invoices paid from their link).
 *
 *   GET    /v1/payment-accounts            which providers are connected
 *   PUT    /v1/payment-accounts/paypal     { clientId, secret?, mode }: checked with PayPal before saving
 *   DELETE /v1/payment-accounts/paypal
 *
 * Buyer-side routes are in storefront.ts; this file also has what both share:
 * settling a paid order (issue the receipt, email it) and the reconciliation
 * run for buyers who paid but never came back to the store.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { loadOrder, markOrderPaid } from '../commerce/store.ts';
import { confirmPayment, type GatewayOptions, gatewayFor, getPaymentAccount, paypalGateway, PaymentError, type PaymentRow, savePayPalAccount } from '../commerce/payments.ts';
import { toBigInt } from '../db/database.ts';
import { recordPayment, ReceivableError } from '../receivables/receivables.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { sendDocumentEmail } from './documents.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';

/** Gateway settings for a server: the test page lives in the store's own app. */
export function gatewayOptions(deps: PipelineDeps, slugOf: (tenantId: string) => Promise<string>, extra: { fetch?: typeof fetch; allowTestInProduction?: boolean } = {}): (tenantId: string) => Promise<GatewayOptions> {
  return async (tenantId) => {
    const slug = await slugOf(tenantId);
    return { keys: deps.keys, testPage: (paymentId) => `/${slug}/shop/pay/${paymentId}`, ...extra };
  };
}

/** A payment the provider says is paid: mark the order paid (issues the BTS document) and email the buyer. Safe to repeat. */
export async function settlePaidOrder(deps: PipelineDeps, ctx: ServerContext, payment: PaymentRow): Promise<void> {
  if (payment.status !== 'paid' || !payment.order_id) return;
  const loaded = await loadOrder(deps.db, payment.tenant_id, { id: payment.order_id });
  if (!loaded || loaded.order.payment_status === 'paid' || loaded.order.status === 'cancelled') return;
  const { order, document } = await markOrderPaid(deps, payment.tenant_id, payment.order_id, null);
  await audit(deps.db, { tenantId: payment.tenant_id, action: 'order.paid', target: `#${order.number}`, details: { provider: payment.provider, transaction: payment.transaction_id } });
  if (document && order.customer_email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
    await sendDocumentEmail(deps, ctx, payment.tenant_id, document.documentId, { to: order.customer_email, message: `Thank you for your order #${order.number}. Your payment was received.` }).catch(() => {});
  }
}

/** An invoice paid from its link: record the payment against it (once). */
export async function settlePaidInvoice(deps: PipelineDeps, payment: PaymentRow): Promise<void> {
  if (payment.status !== 'paid' || !payment.document_id) return;
  const provider = payment.provider === 'paypal' ? 'PayPal' : 'Test payment';
  try {
    // The money was taken, so it is recorded even if the invoice was paid another way meanwhile (a credit to return).
    await recordPayment(deps.db, payment.tenant_id, payment.document_id, {
      amountCents: toBigInt(payment.amount_cents), method: 'online', reference: `${provider} ${payment.transaction_id ?? ''}`.trim(),
      note: 'Paid online from the invoice link', onlinePaymentId: payment.id,
    }, null, { allowOverpay: true });
    await audit(deps.db, { tenantId: payment.tenant_id, action: 'invoice.paid_online', details: { documentId: payment.document_id, provider: payment.provider, transaction: payment.transaction_id } });
  } catch (e) {
    if (e instanceof ReceivableError && /already recorded/.test(e.message)) return;
    if (e instanceof ReceivableError) {
      // The invoice was cancelled after the link went out: keep a record so the business can refund.
      await audit(deps.db, { tenantId: payment.tenant_id, action: 'invoice.paid_online_unmatched', details: { documentId: payment.document_id, paymentId: payment.id, reason: e.message } });
      return;
    }
    throw e;
  }
}

/** Whatever an online payment was for. Safe to repeat. */
export async function settlePayment(deps: PipelineDeps, ctx: ServerContext, payment: PaymentRow): Promise<void> {
  if (payment.order_id) return settlePaidOrder(deps, ctx, payment);
  if (payment.document_id) return settlePaidInvoice(deps, payment);
}

/** Pending online payments a few minutes old: ask the provider, settle the paid ones. */
export async function reconcilePayments(deps: PipelineDeps, ctx: ServerContext, options: (tenantId: string) => Promise<GatewayOptions>): Promise<{ checked: number; settled: number }> {
  const pending = (await deps.db.query<PaymentRow>(
    "select * from order_payments where status = 'pending' and reference is not null and created_at < now() - interval '5 minutes' and created_at > now() - interval '3 days' order by created_at limit 100",
  )).rows;
  let settled = 0;
  for (const p of pending) {
    try {
      const gateway = await gatewayFor(deps.db, p.tenant_id, p.provider, await options(p.tenant_id));
      const now = await confirmPayment(deps.db, gateway, p.id);
      if (now.status === 'paid') {
        await settlePayment(deps, ctx, now);
        settled++;
      }
    } catch {
      // One business's provider being down never stops the others.
    }
  }
  // Older than three days and never paid: give up on them.
  await deps.db.query("update order_payments set status = 'cancelled', updated_at = now() where status = 'pending' and created_at < now() - interval '3 days'");
  return { checked: pending.length, settled };
}

export function registerPaymentAccountRoutes(app: FastifyInstance, deps: PipelineDeps, options: { fetch?: typeof fetch } = {}) {
  const { db } = deps;
  app.get('/payment-accounts', async (request) => {
    requirePermission(request, 'business.manage');
    const paypal = await getPaymentAccount(db, request.tenantId, 'paypal');
    const env = (await db.query<{ environment: string }>('select environment from tenants where id = $1', [request.tenantId])).rows[0]!.environment;
    return {
      paypal: paypal ? { connected: paypal.configured, clientId: paypal.publicId, mode: paypal.mode } : { connected: false, clientId: null, mode: 'sandbox' },
      test: { available: env === 'test' },
    };
  });

  app.put<{ Body: { clientId: string; secret?: string; mode: 'sandbox' | 'live' } }>(
    '/payment-accounts/paypal',
    { schema: { body: { type: 'object', required: ['clientId', 'mode'], additionalProperties: false, properties: { clientId: { type: 'string', minLength: 10, maxLength: 200 }, secret: { type: 'string', minLength: 10, maxLength: 200 }, mode: { type: 'string', enum: ['sandbox', 'live'] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      if (b.secret) {
        // Check the credentials with PayPal before saving them.
        try {
          await paypalGateway({ clientId: b.clientId.trim(), secret: b.secret, mode: b.mode, ...(options.fetch && { fetch: options.fetch }) }).createCheckout({
            paymentId: `check-${Date.now()}`, amountCents: 100n, description: 'Connection check', invoiceId: `check-${Date.now()}`,
            returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel',
          });
        } catch (e) {
          throw new ApiError(422, 'payment_account', e instanceof PaymentError ? e.message : 'PayPal could not be reached to check these credentials');
        }
      }
      try {
        await savePayPalAccount(db, deps.keys, request.tenantId, b);
      } catch (e) {
        throw new ApiError(422, 'payment_account', (e as Error).message);
      }
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payments.paypal_connected', details: { mode: b.mode }, ip: request.ip });
      return { connected: true, clientId: b.clientId.trim(), mode: b.mode };
    },
  );

  app.delete('/payment-accounts/paypal', async (request, reply) => {
    requirePermission(request, 'business.manage');
    await db.query("delete from payment_accounts where tenant_id = $1 and provider = 'paypal'", [request.tenantId]);
    // Online payments cannot stay on without a provider.
    await db.query(
      `update tenants set store_settings = jsonb_set(coalesce(store_settings, '{}'::jsonb), '{payments,online}', '{"enabled": false, "provider": "test"}'::jsonb, true)
       where id = $1 and store_settings #>> '{payments,online,provider}' = 'paypal'`,
      [request.tenantId],
    );
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payments.paypal_disconnected', ip: request.ip });
    return reply.code(204).send();
  });
}
