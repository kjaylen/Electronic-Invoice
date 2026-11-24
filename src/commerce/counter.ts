/**
 * How a business sells at the counter and on its tills, beyond prices and
 * discounts (kept in tenants.counter_settings; the tills get it with
 * GET /v1/me and in their offline snapshot):
 *
 *   showUsd               totals also shown in US dollars, at the fixed BZ$2 to US$1
 *   serviceChargePercent  a service charge a cashier can add to a sale with one tap
 *                         (and that is on by default for a table's tab); null: none
 *   tips                  a tip can be recorded with a card or wallet payment
 *
 * A service charge is a charge on every line of the sale ("Service charge
 * 10%"): it is part of what the customer pays for, so it is on the tax
 * document and GST applies to it like the rest of the line. A tip is the
 * customer's gift to the staff: it is never on the tax document.
 */

export interface CounterSettings {
  showUsd: boolean;
  serviceChargePercent: string | null;
  tips: boolean;
}

/** The reason a service charge carries on a document line (the percentage follows it). */
export const SERVICE_CHARGE = 'Service charge';
export const isServiceCharge = (reason: string | undefined) => Boolean(reason?.startsWith(SERVICE_CHARGE));

/** Up to 30%, two decimals. */
export const SERVICE_PERCENT = /^(30(\.0{1,2})?|[12]?\d(\.\d{1,2})?)$/;

export function counterSettings(raw: unknown): CounterSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const percent = typeof r.serviceChargePercent === 'string' && SERVICE_PERCENT.test(r.serviceChargePercent) && Number(r.serviceChargePercent) > 0 ? String(Number(r.serviceChargePercent)) : null;
  return { showUsd: r.showUsd === true, serviceChargePercent: percent, tips: r.tips === true };
}

/** BZ$ cents as US$ cents at 2 to 1, half a cent rounded up (what a shop asks for). */
export const usdCents = (bzCents: bigint): bigint => (bzCents + 1n) / 2n;
