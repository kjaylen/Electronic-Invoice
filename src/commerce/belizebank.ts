/**
 * Belize Bank: card payments through the bank's hosted payment page, in
 * Belize dollars (no conversion). The card is typed on the bank's page, so
 * no card data ever reaches this server.
 *
 *   register.do               start a payment → the bank's order id and its payment page
 *   getOrderStatusExtended.do was it paid? (the only answer that is trusted)
 *
 * Requests are form-encoded POSTs with the merchant's user name and password;
 * answers are JSON. The bank can also call back when something happens to a
 * payment; the callback carries no signature, so it only prompts a status
 * check.
 */

import { formatCents } from '../engine/decimal.ts';
import { type Gateway, PaymentError } from './payments.ts';

export const BELIZE_BANK_HOSTS = { sandbox: 'https://sandbox.belizebank.com/payment/rest', live: 'https://gateway.belizebank.com/payment/rest' } as const;
/** ISO 4217 numeric code of the Belize dollar. */
const BZD = '084';

export interface BelizeBankConfig {
  userName: string;
  password: string;
  mode: 'sandbox' | 'live';
  fetch?: typeof fetch;
  /** Where the bank may call back about a payment (optional). */
  callbackUrl?: string;
}

type Answer = Record<string, unknown> & { errorCode?: string | number; errorMessage?: string };

function client(config: BelizeBankConfig) {
  const base = BELIZE_BANK_HOSTS[config.mode];
  const doFetch = config.fetch ?? fetch;
  return async (path: string, params: Record<string, string>): Promise<Answer> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ userName: config.userName, password: config.password, ...params }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PaymentError('Belize Bank could not be reached; try again in a moment');
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as Answer;
    } catch {
      throw new PaymentError(`Belize Bank answered ${res.status} with something other than JSON`);
    }
  };
}

const failed = (a: Answer) => a.errorCode !== undefined && String(a.errorCode) !== '0';

export function belizeBankGateway(config: BelizeBankConfig): Gateway {
  const call = client(config);
  return {
    provider: 'belizebank',
    async createCheckout(req) {
      const a = await call('register.do', {
        amount: String(req.amountCents),
        currency: BZD,
        description: req.description.slice(0, 99),
        // Back to the same page whether it worked or not: it asks the bank which.
        returnURL: req.returnUrl,
        failURL: req.returnUrl,
        orderNumber: req.invoiceId.slice(0, 32),
        ...(config.callbackUrl && { dynamicCallbackUrl: config.callbackUrl }),
      });
      const orderId = String(a.orderId ?? a.orderID ?? '');
      const formUrl = String(a.formURL ?? a.formUrl ?? '');
      if (failed(a) || !orderId || !/^https:\/\//.test(formUrl)) {
        throw new PaymentError(`Belize Bank could not start the payment${a.errorMessage ? `: ${a.errorMessage}` : ''}`);
      }
      return { reference: orderId, redirectUrl: formUrl, currency: 'BZD', chargedAmount: formatCents(req.amountCents) };
    },
    async confirm(reference, expected) {
      const a = await call('getOrderStatusExtended.do', { orderId: reference });
      if (failed(a)) return { status: 'pending' };
      const status = Number(a.orderStatus);
      if (status === 2) {
        const charged = formatCents(BigInt(String(a.amount ?? '0')));
        if (expected.currency !== 'BZD' || charged !== expected.chargedAmount) {
          return { status: 'failed', reason: `Belize Bank charged BZ$${charged}, not BZ$${expected.chargedAmount}` };
        }
        const approval = (a.cardAuthInfo as { approvalCode?: string } | undefined)?.approvalCode;
        return { status: 'paid', transactionId: approval ? `${approval}` : reference, chargedAmount: charged };
      }
      if (status === 6) return { status: 'failed', reason: 'The card was declined' };
      if (status === 3) return { status: 'failed', reason: 'The payment was cancelled' };
      if (status === 4) return { status: 'failed', reason: 'The payment was refunded' };
      return { status: 'pending' };
    },
  };
}

/**
 * Check a merchant's user name and password before saving them: ask about an
 * order that does not exist. "Not found" means the bank accepted the login.
 */
export async function checkBelizeBankLogin(config: BelizeBankConfig): Promise<void> {
  const a = await client(config)('getOrderStatusExtended.do', { orderId: '00000000-0000-0000-0000-000000000000' });
  const message = String(a.errorMessage ?? '');
  if (String(a.errorCode) === '5' || /access|denied|password|login|auth|credential/i.test(message)) {
    throw new PaymentError('Belize Bank refused this user name or password');
  }
}
