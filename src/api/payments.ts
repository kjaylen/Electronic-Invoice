/**
 * Online payments: the business's payment account, and settling what was paid
 * (store orders, and invoices paid from their link).
 *
 *   GET    /v1/payment-accounts                which providers are connected
 *   PUT    /v1/payment-accounts/paypal         { clientId, secret?, mode }: checked with PayPal before saving
 *   PUT    /v1/payment-accounts/belizebank     { userName, password?, mode }: checked with the bank before saving
 *   PUT    /v1/payment-accounts/ekyash         { sid, pinHash?, apiKey?, apiPassword?, mode }
 *   DELETE /v1/payment-accounts/:provider
 *
 * Public, for the providers:
 *
 *   POST /v1/payment-callbacks/belizebank      the bank says something happened to a payment
 *   POST /v1/payment-callbacks/ekyash/:slug    E-Kyash says an invoice was accepted or declined (signed)
 *
 * Buyer-side routes are in storefront.ts; this file also has what both share:
 * settling a paid order (issue the receipt, email it) and the reconciliation
 * run for buyers who paid but never came back to the store.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { loadOrder, markOrderPaid } from '../commerce/store.ts';
import {
  confirmPayment, type GatewayOptions, gatewayFor, getPaymentAccount, paymentAccountSecret, paypalGateway, PaymentError, type PaymentRow, PROVIDER_NAMES, type Provider,
  savePaymentAccount, savePayPalAccount,
} from '../commerce/payments.ts';
import { checkBelizeBankLogin } from '../commerce/belizebank.ts';
import { ekyashClient, verifyEKyashCallback } from '../commerce/ekyash.ts';
import { toBigInt } from '../db/database.ts';
import { recordPayment, ReceivableError } from '../receivables/receivables.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { sendDocumentEmail } from './documents.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';

/** Gateway settings for a server: the test page lives in the store's own app. */
export interface GatewayExtras {
  fetch?: typeof fetch;
  allowTestInProduction?: boolean;
  publicUrl?: string;
  ekyash?: { sandboxUrl?: string; liveUrl?: string };
}

export function gatewayOptions(deps: PipelineDeps, slugOf: (tenantId: string) => Promise<string>, extra: GatewayExtras = {}): (tenantId: string) => Promise<GatewayOptions> {
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
  const provider = PROVIDER_NAMES[payment.provider] ?? payment.provider;
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

export function registerPaymentAccountRoutes(app: FastifyInstance, deps: PipelineDeps, options: GatewayExtras = {}) {
  const { db } = deps;
  app.get('/payment-accounts', async (request) => {
    requirePermission(request, 'business.manage');
    const [paypal, bank, ekyash] = await Promise.all((['paypal', 'belizebank', 'ekyash'] as const).map((p) => getPaymentAccount(db, request.tenantId, p)));
    const t = (await db.query<{ environment: string; slug: string }>('select environment, slug from tenants where id = $1', [request.tenantId])).rows[0]!;
    const base = options.publicUrl?.replace(/\/$/, '');
    return {
      paypal: paypal ? { connected: paypal.configured, clientId: paypal.publicId, mode: paypal.mode } : { connected: false, clientId: null, mode: 'sandbox' },
      belizebank: bank ? { connected: bank.configured, userName: bank.publicId, mode: bank.mode } : { connected: false, userName: null, mode: 'sandbox' },
      ekyash: {
        ...(ekyash ? { connected: ekyash.configured, sid: ekyash.publicId, mode: ekyash.mode } : { connected: false, sid: null, mode: 'sandbox' }),
        available: { sandbox: Boolean(options.ekyash?.sandboxUrl), live: Boolean(options.ekyash?.liveUrl) },
        // Give this address to Belize Bank: E-Kyash tells us there when a customer pays.
        callbackUrl: base ? `${base}/v1/payment-callbacks/ekyash/${t.slug}` : null,
      },
      test: { available: t.environment === 'test' },
    };
  });

  app.put<{ Body: { userName: string; password?: string; mode: 'sandbox' | 'live' } }>(
    '/payment-accounts/belizebank',
    { schema: { body: { type: 'object', required: ['userName', 'mode'], additionalProperties: false, properties: { userName: { type: 'string', minLength: 2, maxLength: 100 }, password: { type: 'string', minLength: 4, maxLength: 200 }, mode: { type: 'string', enum: ['sandbox', 'live'] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      if (b.password) {
        try {
          await checkBelizeBankLogin({ userName: b.userName.trim(), password: b.password, mode: b.mode, ...(options.fetch && { fetch: options.fetch }) });
        } catch (e) {
          throw new ApiError(422, 'payment_account', e instanceof PaymentError ? e.message : 'Belize Bank could not be reached to check this login');
        }
      }
      try {
        await savePaymentAccount(db, deps.keys, request.tenantId, 'belizebank', { publicId: b.userName, ...(b.password && { secret: b.password }), mode: b.mode });
      } catch (e) {
        throw new ApiError(422, 'payment_account', (e as Error).message);
      }
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payments.belizebank_connected', details: { mode: b.mode }, ip: request.ip });
      return { connected: true, userName: b.userName.trim(), mode: b.mode };
    },
  );

  app.put<{ Body: { sid: string; pinHash?: string; apiKey?: string; apiPassword?: string; mode: 'sandbox' | 'live' } }>(
    '/payment-accounts/ekyash',
    {
      schema: {
        body: {
          type: 'object', required: ['sid', 'mode'], additionalProperties: false,
          properties: {
            sid: { type: 'string', pattern: '^\\d{5,10}$' },
            pinHash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
            apiKey: { type: 'string', minLength: 8, maxLength: 200 },
            apiPassword: { type: 'string', minLength: 8, maxLength: 200 },
            mode: { type: 'string', enum: ['sandbox', 'live'] },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      const before = await paymentAccountSecret(db, deps.keys, request.tenantId, 'ekyash').catch(() => null);
      const old = before ? (JSON.parse(before) as { pinHash: string; apiKey: string; apiPassword: string }) : null;
      const creds = { pinHash: (b.pinHash ?? old?.pinHash ?? '').toLowerCase(), apiKey: b.apiKey ?? old?.apiKey ?? '', apiPassword: b.apiPassword ?? old?.apiPassword ?? '' };
      if (!creds.pinHash || !creds.apiKey || !creds.apiPassword) throw new ApiError(422, 'payment_account', 'Enter the PIN hash, API key and API password from Belize Bank');
      const baseUrl = b.mode === 'live' ? options.ekyash?.liveUrl : options.ekyash?.sandboxUrl;
      if (!baseUrl) throw new ApiError(422, 'payment_account', `E-Kyash ${b.mode === 'live' ? 'live payments are' : 'sandbox is'} not available on this server yet`);
      // Check the merchant id and PIN with E-Kyash before saving.
      try {
        await ekyashClient({ ...creds, sid: b.sid, baseUrl, ...(options.fetch && { fetch: options.fetch }) }).session();
      } catch (e) {
        throw new ApiError(422, 'payment_account', e instanceof PaymentError ? e.message : 'E-Kyash could not be reached to check these details');
      }
      await savePaymentAccount(db, deps.keys, request.tenantId, 'ekyash', { publicId: b.sid, secret: JSON.stringify(creds), mode: b.mode });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payments.ekyash_connected', details: { mode: b.mode }, ip: request.ip });
      return { connected: true, sid: b.sid, mode: b.mode };
    },
  );

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

  app.delete<{ Params: { provider: string } }>('/payment-accounts/:provider', { schema: { params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['paypal', 'belizebank', 'ekyash'] } } } } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const provider = request.params.provider as Exclude<Provider, 'test'>;
    await db.query('delete from payment_accounts where tenant_id = $1 and provider = $2', [request.tenantId, provider]);
    // Online payments cannot stay on without a provider.
    await db.query(
      `update tenants set store_settings = jsonb_set(coalesce(store_settings, '{}'::jsonb), '{payments,online}', '{"enabled": false, "provider": "test"}'::jsonb, true)
       where id = $1 and store_settings #>> '{payments,online,provider}' = $2`,
      [request.tenantId, provider],
    );
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `payments.${provider}_disconnected`, ip: request.ip });
    return reply.code(204).send();
  });
}

/**
 * What the providers send us. Neither is trusted on its own: a callback only
 * makes us ask the provider about that payment (and E-Kyash's must also carry
 * a valid signature).
 */
export function registerPaymentCallbacks(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, options: (tenantId: string) => Promise<GatewayOptions>) {
  const { db } = deps;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  const check = async (p: PaymentRow) => {
    if (p.status !== 'pending') return;
    const gateway = await gatewayFor(db, p.tenant_id, p.provider, await options(p.tenant_id));
    const now = await confirmPayment(db, gateway, p.id);
    if (now.status === 'paid') await settlePayment(deps, ctx, now);
  };

  app.post<{ Body: Record<string, string> }>('/belizebank', async (request, reply) => {
    const order = String(request.body?.mdOrder ?? '');
    if (!/^[0-9a-zA-Z-]{8,64}$/.test(order)) return reply.code(400).send({ error: { code: 'invalid_request', message: 'mdOrder is required' } });
    const p = (await db.query<PaymentRow>("select * from order_payments where provider = 'belizebank' and reference = $1", [order])).rows[0];
    if (p) await check(p).catch((e) => request.log.warn({ err: e }, 'belize bank callback'));
    return reply.send({ ok: true });
  });

  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    '/ekyash/:slug',
    { schema: { params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' } } } } },
    async (request, reply) => {
      const tenant = (await db.query<{ id: string }>('select id from tenants where slug = $1', [request.params.slug])).rows[0];
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      const secret = tenant ? await paymentAccountSecret(db, deps.keys, tenant.id, 'ekyash').catch(() => null) : null;
      if (!tenant || !secret || !verifyEKyashCallback(body, (JSON.parse(secret) as { apiPassword: string }).apiPassword)) {
        return reply.code(401).send({ success: false });
      }
      const invoiceId = String(body.invoiceId ?? '');
      const p = (await db.query<PaymentRow>("select * from order_payments where tenant_id = $1 and provider = 'ekyash' and split_part(reference, '|', 1) = $2", [tenant.id, invoiceId])).rows[0];
      if (p) await check(p).catch((e) => request.log.warn({ err: e }, 'e-kyash callback'));
      return reply.send({ success: true });
    },
  );
}
