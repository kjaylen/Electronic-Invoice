/**
 * Paying online at checkout, through the business's own payment account.
 *
 * Every provider is a hosted checkout: we create a checkout for the order,
 * send the buyer to the provider's page, and when they come back (or later,
 * from the reconciliation run) we ask the provider whether it was paid. Only
 * then is the order marked paid and its BTS receipt issued.
 *
 *   test    a built-in pretend card page, for the BTS test environment and demos; no money moves
 *   paypal  PayPal Checkout (Orders v2). PayPal does not take Belize dollars, so the charge is in
 *           US dollars at the fixed rate of BZ$2 to US$1; the receipt stays in BZ$.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { formatCents } from '../engine/decimal.ts';

export type Provider = 'paypal' | 'test';

export class PaymentError extends Error {
  override name = 'PaymentError';
}

export interface CheckoutRequest {
  paymentId: string;
  amountCents: bigint;
  description: string;
  invoiceId: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  reference: string;
  redirectUrl: string;
  currency: string;
  chargedAmount: string;
}

export type ConfirmResult = { status: 'paid'; transactionId: string; chargedAmount: string } | { status: 'pending' } | { status: 'failed'; reason: string };

export interface Gateway {
  provider: Provider;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  confirm(reference: string, expected: { chargedAmount: string; currency: string }): Promise<ConfirmResult>;
}

// ---------- the test gateway ----------

/** Pretend payments for the test environment: the "provider page" is our own, and approving it is recorded in the payment's detail. */
export function testGateway(db: Queryable, pagePath: (paymentId: string) => string): Gateway {
  return {
    provider: 'test',
    async createCheckout(req) {
      return { reference: `test_${req.paymentId}`, redirectUrl: pagePath(req.paymentId), currency: 'BZD', chargedAmount: formatCents(req.amountCents) };
    },
    async confirm(reference) {
      const id = reference.replace(/^test_/, '');
      const row = (await db.query<{ detail: { testDecision?: 'approved' | 'declined' } | null; charged_amount: string }>('select detail, charged_amount from order_payments where id = $1', [id])).rows[0];
      const decision = row?.detail?.testDecision;
      if (decision === 'approved') return { status: 'paid', transactionId: `TEST-${id.slice(0, 8).toUpperCase()}`, chargedAmount: row!.charged_amount };
      if (decision === 'declined') return { status: 'failed', reason: 'The test card was declined' };
      return { status: 'pending' };
    },
  };
}

// ---------- PayPal ----------

export const PAYPAL_HOSTS = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' } as const;

/** BZ$ to US$ at the fixed rate (BZ$2 = US$1), rounded up to the cent so the business never receives less. */
export function bzdToUsd(cents: bigint): string {
  return formatCents((cents + 1n) / 2n);
}

export function paypalGateway(config: { clientId: string; secret: string; mode: 'sandbox' | 'live'; fetch?: typeof fetch }): Gateway {
  const base = PAYPAL_HOSTS[config.mode];
  const doFetch = config.fetch ?? fetch;
  let token: { value: string; until: number } | null = null;
  const accessToken = async () => {
    if (token && token.until > Date.now()) return token.value;
    const res = await doFetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new PaymentError(`PayPal refused the credentials (${res.status}). Check the client id and secret in Settings → Online store.`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return token.value;
  };
  const call = async (method: string, path: string, body?: unknown, requestId?: string) => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...(requestId && { 'paypal-request-id': requestId }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  return {
    provider: 'paypal',
    async createCheckout(req) {
      const usd = bzdToUsd(req.amountCents);
      const r = await call('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: req.paymentId, invoice_id: req.invoiceId, description: req.description.slice(0, 127), amount: { currency_code: 'USD', value: usd } }],
        payment_source: { paypal: { experience_context: { return_url: req.returnUrl, cancel_url: req.cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      }, req.paymentId);
      if (r.status >= 300) throw new PaymentError(`PayPal could not start the payment (${r.status})`);
      const links = (r.json.links ?? []) as Array<{ rel: string; href: string }>;
      const approve = links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      if (!approve) throw new PaymentError('PayPal did not return a payment page');
      return { reference: String(r.json.id), redirectUrl: approve.href, currency: 'USD', chargedAmount: usd };
    },
    async confirm(reference, expected) {
      let r = await call('POST', `/v2/checkout/orders/${encodeURIComponent(reference)}/capture`, {}, `capture-${reference}`);
      if (r.status === 422) r = await call('GET', `/v2/checkout/orders/${encodeURIComponent(reference)}`);
      if (r.status >= 300 && r.status !== 201) return { status: 'pending' };
      const status = String(r.json.status);
      if (status !== 'COMPLETED') return status === 'VOIDED' ? { status: 'failed', reason: 'PayPal voided the payment' } : { status: 'pending' };
      const capture = ((r.json.purchase_units as Array<{ payments?: { captures?: Array<{ id: string; status: string; amount: { value: string; currency_code: string } }> } }> | undefined)?.[0]?.payments?.captures ?? [])[0];
      if (!capture || capture.status !== 'COMPLETED') return { status: 'pending' };
      if (capture.amount.currency_code !== expected.currency || capture.amount.value !== expected.chargedAmount) {
        return { status: 'failed', reason: `PayPal captured ${capture.amount.currency_code} ${capture.amount.value}, not ${expected.currency} ${expected.chargedAmount}` };
      }
      return { status: 'paid', transactionId: capture.id, chargedAmount: capture.amount.value };
    },
  };
}

// ---------- the business's payment account ----------

export interface PaymentAccount {
  provider: Provider;
  publicId: string | null;
  mode: 'sandbox' | 'live';
  configured: boolean;
}

export async function getPaymentAccount(db: Queryable, tenantId: string, provider: Provider): Promise<PaymentAccount | null> {
  const r = (await db.query<{ provider: Provider; public_id: string | null; mode: 'sandbox' | 'live'; credentials_encrypted: string | null }>(
    'select provider, public_id, mode, credentials_encrypted from payment_accounts where tenant_id = $1 and provider = $2', [tenantId, provider],
  )).rows[0];
  return r ? { provider: r.provider, publicId: r.public_id, mode: r.mode, configured: provider === 'test' || Boolean(r.credentials_encrypted) } : null;
}

export async function savePayPalAccount(db: Queryable, keys: KeyProtector, tenantId: string, input: { clientId: string; secret?: string; mode: 'sandbox' | 'live' }): Promise<void> {
  const existing = (await db.query<{ credentials_encrypted: string | null }>("select credentials_encrypted from payment_accounts where tenant_id = $1 and provider = 'paypal'", [tenantId])).rows[0];
  const encrypted = input.secret ? await keys.encrypt(Buffer.from(input.secret), `payments:${tenantId}:paypal`) : existing?.credentials_encrypted ?? null;
  if (!encrypted) throw new PaymentError('Enter the PayPal secret');
  await db.query(
    `insert into payment_accounts (tenant_id, provider, public_id, credentials_encrypted, mode) values ($1, 'paypal', $2, $3, $4)
     on conflict (tenant_id, provider) do update set public_id = excluded.public_id, credentials_encrypted = excluded.credentials_encrypted, mode = excluded.mode, updated_at = now()`,
    [tenantId, input.clientId.trim(), encrypted, input.mode],
  );
}

export interface GatewayOptions {
  keys: KeyProtector;
  /** The buyer-facing page of the test gateway, for a payment. */
  testPage: (paymentId: string) => string;
  /** Allow the test gateway for businesses in production (never, outside tests). */
  allowTestInProduction?: boolean;
  fetch?: typeof fetch;
}

/** The gateway a business uses for a provider; throws when it is not set up. */
export async function gatewayFor(db: Queryable, tenantId: string, provider: Provider, options: GatewayOptions): Promise<Gateway> {
  if (provider === 'test') {
    const env = (await db.query<{ environment: string }>('select environment from tenants where id = $1', [tenantId])).rows[0]?.environment;
    if (env === 'production' && !options.allowTestInProduction) throw new PaymentError('Test payments are only for the BTS test environment; connect PayPal to take real payments');
    return testGateway(db, options.testPage);
  }
  const r = (await db.query<{ public_id: string | null; credentials_encrypted: string | null; mode: 'sandbox' | 'live' }>(
    "select public_id, credentials_encrypted, mode from payment_accounts where tenant_id = $1 and provider = 'paypal'", [tenantId],
  )).rows[0];
  if (!r?.public_id || !r.credentials_encrypted) throw new PaymentError('PayPal is not connected yet');
  const secret = (await options.keys.decrypt(r.credentials_encrypted, `payments:${tenantId}:paypal`)).toString('utf8');
  return paypalGateway({ clientId: r.public_id, secret, mode: r.mode, ...(options.fetch && { fetch: options.fetch }) });
}

// ---------- payments for orders ----------

export interface PaymentRow {
  id: string;
  tenant_id: string;
  order_id: string | null;
  document_id: string | null;
  provider: Provider;
  reference: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  amount_cents: unknown;
  currency: string;
  charged_amount: string | null;
  transaction_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date | string;
}

export interface PaymentTarget {
  tenantId: string;
  /** An online order, or an invoice being paid from its link. */
  orderId?: string;
  documentId?: string;
  amountCents: bigint;
  /** What the buyer sees at the provider, e.g. "Corner Store order #1001". */
  description: string;
  /** Short and unique per attempt, for the provider's records. */
  invoiceRef: string;
}

/** Start an online payment: records it and returns where to send the buyer. */
export async function startPayment(db: Queryable, gateway: Gateway, target: PaymentTarget, urls: { returnUrl: (paymentId: string) => string; cancelUrl: string }): Promise<{ paymentId: string; redirectUrl: string }> {
  const paymentId = randomUUID();
  const amount = target.amountCents;
  await db.query(
    "insert into order_payments (id, tenant_id, order_id, document_id, provider, status, amount_cents, currency) values ($1, $2, $3, $4, $5, 'pending', $6, 'BZD')",
    [paymentId, target.tenantId, target.orderId ?? null, target.documentId ?? null, gateway.provider, String(amount)],
  );
  try {
    const c = await gateway.createCheckout({ paymentId, amountCents: amount, description: target.description, invoiceId: `${target.invoiceRef}-${paymentId.slice(0, 6)}`, returnUrl: urls.returnUrl(paymentId), cancelUrl: urls.cancelUrl });
    await db.query('update order_payments set reference = $2, currency = $3, charged_amount = $4, updated_at = now() where id = $1', [paymentId, c.reference, c.currency, c.chargedAmount]);
    return { paymentId, redirectUrl: c.redirectUrl };
  } catch (e) {
    await db.query("update order_payments set status = 'failed', detail = $2, updated_at = now() where id = $1", [paymentId, JSON.stringify({ error: (e as Error).message })]);
    throw e;
  }
}

/** Ask the provider about a pending payment and record the answer. Returns the payment as it now stands. */
export async function confirmPayment(db: Queryable, gateway: Gateway, paymentId: string): Promise<PaymentRow> {
  const p = (await db.query<PaymentRow>('select * from order_payments where id = $1', [paymentId])).rows[0];
  if (!p) throw new PaymentError('Payment not found');
  if (p.status !== 'pending' || !p.reference) return p;
  const r = await gateway.confirm(p.reference, { chargedAmount: p.charged_amount ?? '', currency: p.currency });
  if (r.status === 'paid') {
    return (await db.query<PaymentRow>("update order_payments set status = 'paid', transaction_id = $2, updated_at = now() where id = $1 and status = 'pending' returning *", [paymentId, r.transactionId])).rows[0] ?? p;
  }
  if (r.status === 'failed') {
    return (await db.query<PaymentRow>("update order_payments set status = 'failed', detail = coalesce(detail, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1 and status = 'pending' returning *", [paymentId, JSON.stringify({ reason: r.reason })])).rows[0] ?? p;
  }
  return p;
}
