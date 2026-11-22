/**
 * E-Kyash (Belize Bank's wallet): the customer pays from the E-Kyash app by
 * scanning a QR code, or with one tap on a phone (a deep link).
 *
 *   authorization        a session for this transaction (merchant id + PIN hash)
 *   create-new-invoice   an E-Kyash invoice for the amount → its QR data and deep link
 *   get-invoice-info     was it paid? (the only answer that is trusted)
 *
 * Every request carries a JWT (HS256 over the request body, keyed with the
 * merchant's API key). E-Kyash calls back when the customer accepts or
 * declines, with an HMAC-SHA256 of the message keyed with the merchant's API
 * password; a callback that checks out prompts a status check, nothing more.
 *
 * The API address is the same for every merchant and is given by the bank,
 * so the platform sets it (EKYASH_SANDBOX_URL, EKYASH_LIVE_URL).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatCents } from '../engine/decimal.ts';
import { type Gateway, PaymentError } from './payments.ts';

export interface EKyashCredentials {
  /** Merchant id ("SID"), given by the bank. */
  sid: string;
  /** sha256(md5(PIN)), given by the bank. */
  pinHash: string;
  /** Signs the JWT on each request. */
  apiKey: string;
  /** Signs E-Kyash's callbacks. */
  apiPassword: string;
}

export interface EKyashConfig extends EKyashCredentials {
  baseUrl: string;
  fetch?: typeof fetch;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** HS256 JWT over a payload (the request body). */
export function ekyashJwt(payload: unknown, apiKey: string): string {
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${head}.${createHmac('sha256', apiKey).update(head).digest('base64url')}`;
}

/** E-Kyash's order ids are at most 20 characters: the payment id without dashes, shortened. */
export const ekyashOrderId = (paymentId: string) => paymentId.replace(/-/g, '').slice(0, 20);

/** Our reference for an E-Kyash payment: "<invoiceId>|<orderId>" (status checks need both). */
export const ekyashReference = (invoiceId: string, orderId: string) => `${invoiceId}|${orderId}`;

function belizeStamp(d: Date): string {
  return new Date(d.getTime() - 6 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function ekyashClient(config: EKyashConfig) {
  const doFetch = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/$/, '');
  const call = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${ekyashJwt(body, config.apiKey)}`,
          'accept-language': 'en',
          'the-timezone-iana': 'America/Belize',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PaymentError('E-Kyash could not be reached; try again in a moment');
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PaymentError(`E-Kyash answered ${res.status} with something other than JSON`);
    }
    if (!res.ok) throw new PaymentError(`E-Kyash refused the request (${res.status}${json.message ? `: ${String(json.message)}` : ''})`);
    return json;
  };
  const session = async () => {
    const r = await call('authorization', { sid: config.sid, pinHash: config.pinHash, pushkey: '' });
    if (typeof r.session !== 'string' || !r.session) throw new PaymentError('E-Kyash refused the merchant id or PIN');
    return r.session;
  };
  return { call, session };
}

export interface EKyashDisplay {
  qrData: string;
  deepLink: string | null;
}

export function ekyashGateway(config: EKyashConfig, onCreated?: (paymentId: string, display: EKyashDisplay) => Promise<void>): Gateway {
  const api = ekyashClient(config);
  return {
    provider: 'ekyash',
    async createCheckout(req) {
      const orderId = ekyashOrderId(req.paymentId);
      const r = await api.call('create-new-invoice', {
        session: await api.session(),
        orderId,
        amount: Number(req.amountCents),
        currency: 'BZD',
        description: req.description.slice(0, 1000),
        payer: null,
        longTerm: false,
        receipt: null,
        dateLife: belizeStamp(new Date(Date.now() + 3 * 86_400_000)),
        fieldsOther: null,
        fieldsApp: null,
      });
      const invoiceId = String(r.invoiceId ?? '');
      const qrData = String(r.qrData ?? '');
      if (!invoiceId || !qrData) throw new PaymentError('E-Kyash did not create the invoice');
      await onCreated?.(req.paymentId, { qrData, deepLink: typeof r.paymentLink === 'string' && /^https:\/\//.test(r.paymentLink) ? r.paymentLink : null });
      // The customer stays on our page, which shows the QR code and the button.
      return { reference: ekyashReference(invoiceId, orderId), redirectUrl: req.returnUrl, currency: 'BZD', chargedAmount: formatCents(req.amountCents) };
    },
    async confirm(reference, expected) {
      const [invoiceId, orderId] = reference.split('|');
      const r = await api.call('get-invoice-info', { session: await api.session(), orderId: orderId ?? null, invoiceId });
      const inv = ((r.list ?? []) as Array<{ statusPay?: number | string; amount?: number | string; transactions?: Array<{ transactionId?: string; statusPay?: number | string }> }>)[0];
      if (!inv) return { status: 'pending' };
      const status = Number(inv.statusPay);
      if (status === 3) {
        const charged = formatCents(BigInt(String(inv.amount ?? '0')));
        if (charged !== expected.chargedAmount) return { status: 'failed', reason: `E-Kyash shows BZ$${charged}, not BZ$${expected.chargedAmount}` };
        const tx = (inv.transactions ?? []).find((t) => Number(t.statusPay) === 3) ?? inv.transactions?.[0];
        return { status: 'paid', transactionId: String(tx?.transactionId ?? invoiceId), chargedAmount: charged };
      }
      if (status === 2) return { status: 'failed', reason: 'The payment was declined or cancelled in E-Kyash' };
      return { status: 'pending' };
    },
  };
}

/** Does an E-Kyash callback carry a valid signature? (HMAC-SHA256 of the message without "hash", as sent.) */
export function verifyEKyashCallback(body: Record<string, unknown>, apiPassword: string): boolean {
  const { hash, ...rest } = body;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  // PHP's json_encode escapes "/"; the callback's values are ids and numbers, but match it anyway.
  const json = JSON.stringify(rest).replace(/\//g, '\\/');
  const expected = createHmac('sha256', apiPassword).update(json).digest();
  const given = Buffer.from(hash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
