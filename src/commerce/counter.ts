/**
 * How a business sells at the counter and on its tills, beyond prices and
 * discounts (kept in tenants.counter_settings; the tills get it with
 * GET /v1/me and in their offline snapshot):
 *
 *   showUsd               totals also shown in US dollars, at the fixed BZ$2 to US$1
 *   serviceChargePercent  a service charge a cashier can add to a sale with one tap
 *                         (and that is on by default for a table's tab); null: none
 *   tips                  a tip can be recorded with a card or wallet payment
 *   tables                a bar or restaurant's tables: each can hold one open tab (a held sale)
 *   stations              where order tickets print (Kitchen, Bar), each with the item categories
 *                         it makes; an item in none of them prints no ticket
 *
 * A service charge is a charge on every line of the sale ("Service charge
 * 10%"): it is part of what the customer pays for, so it is on the tax
 * document and GST applies to it like the rest of the line. A tip is the
 * customer's gift to the staff: it is never on the tax document.
 */

export interface Station { name: string; categories: string[] }

export interface CounterSettings {
  showUsd: boolean;
  serviceChargePercent: string | null;
  tips: boolean;
  tables: string[];
  stations: Station[];
}

export const MAX_TABLES = 80;
export const MAX_STATIONS = 4;

/** Names as typed, trimmed, without blanks or repeats (whatever the letter case). */
function names(raw: unknown, max: number, length: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = v.replace(/\s+/g, ' ').trim().slice(0, length);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/** The reason a service charge carries on a document line (the percentage follows it). */
export const SERVICE_CHARGE = 'Service charge';
export const isServiceCharge = (reason: string | undefined) => Boolean(reason?.startsWith(SERVICE_CHARGE));

/** Up to 30%, two decimals. */
export const SERVICE_PERCENT = /^(30(\.0{1,2})?|[12]?\d(\.\d{1,2})?)$/;

export function counterSettings(raw: unknown): CounterSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const percent = typeof r.serviceChargePercent === 'string' && SERVICE_PERCENT.test(r.serviceChargePercent) && Number(r.serviceChargePercent) > 0 ? String(Number(r.serviceChargePercent)) : null;
  const stations = (Array.isArray(r.stations) ? r.stations : []).slice(0, MAX_STATIONS).flatMap((s: unknown) => {
    const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const [name] = names([x.name], 1, 30);
    return name ? [{ name, categories: names(x.categories, 60, 80) }] : [];
  });
  return { showUsd: r.showUsd === true, serviceChargePercent: percent, tips: r.tips === true, tables: names(r.tables, MAX_TABLES, 30), stations };
}

/** BZ$ cents as US$ cents at 2 to 1, half a cent rounded up (what a shop asks for). */
export const usdCents = (bzCents: bigint): bigint => (bzCents + 1n) / 2n;
