/**
 * Tax values the hospitality module uses, as dated configuration. The
 * defaults are what TAX-RULES.md records, with where each came from and
 * whether it could be verified; a business's own rows (venue_tax_rules)
 * override them from their start date. A calculation asks for the rules "as
 * of" a day and never holds a rate of its own.
 */

import type { Queryable } from '../db/database.ts';

export const TAX_KEYS = ['gstPercent', 'hotelTaxPercent', 'hotelTaxGst', 'serviceChargeGst', 'serviceChargeHotelTax'] as const;
export type TaxKey = (typeof TAX_KEYS)[number];

export interface TaxRule { key: TaxKey; value: string; from: string; source: string; verified: boolean; custom: boolean; label: string }

export const DEFAULT_TAX_RULES: TaxRule[] = [
  { key: 'gstPercent', value: '12.5', from: '2010-04-01', source: 'Belize Tax Service, "What is GST" (bts.gov.bz), read 25 Nov 2026', verified: true, custom: false, label: 'GST standard rate (%)' },
  { key: 'hotelTaxPercent', value: '9', from: '2000-01-01', source: 'Belize Tourism Board, Hotels page (belizetourismboard.org/hotels), read 25 Nov 2026. A rise to 12.5% was proposed in Oct 2025; not found in force', verified: true, custom: false, label: 'Hotel tax on accommodation (%)' },
  { key: 'hotelTaxGst', value: 'no', from: '2000-01-01', source: 'No source found: taken as not charged', verified: false, custom: false, label: 'GST charged on the hotel tax' },
  { key: 'serviceChargeGst', value: 'yes', from: '2000-01-01', source: 'BTS public ruling on service charge for the hospitality industry exists but could not be read on 25 Nov 2026: taken as charged, the cautious reading', verified: false, custom: false, label: 'GST charged on the service charge' },
  { key: 'serviceChargeHotelTax', value: 'no', from: '2000-01-01', source: 'No source found: hotel tax taken as on the room charge only', verified: false, custom: false, label: 'Hotel tax charged on the service charge' },
];

const VALID: Record<TaxKey, RegExp> = {
  gstPercent: /^\d{1,2}(\.\d{1,3})?$/, hotelTaxPercent: /^\d{1,2}(\.\d{1,3})?$/, hotelTaxGst: /^(yes|no)$/, serviceChargeGst: /^(yes|no)$/, serviceChargeHotelTax: /^(yes|no)$/,
};
export const validTaxValue = (key: TaxKey, value: string) => VALID[key].test(value);

interface Row { key: TaxKey; value: string; valid_from: string; note: string | null }

/** Every rule as of a day: the business's latest row that has started, else the default. */
export async function taxRuleList(db: Queryable, tenantId: string, at: Date): Promise<TaxRule[]> {
  const day = new Date(at.getTime() - 6 * 3600_000).toISOString().slice(0, 10);
  const rows = (await db.query<Row>('select key, value, valid_from::text as valid_from, note from venue_tax_rules where tenant_id = $1 and valid_from <= $2::date order by valid_from desc, created_at desc', [tenantId, day])).rows;
  return DEFAULT_TAX_RULES.map((d) => {
    const own = rows.find((r) => r.key === d.key);
    return own ? { ...d, value: own.value, from: own.valid_from, source: own.note || 'Set by the business', verified: true, custom: true } : d;
  });
}

export interface TaxValues { gstPercent: string; hotelTaxPercent: string; hotelTaxGst: boolean; serviceChargeGst: boolean; serviceChargeHotelTax: boolean; unverified: string[] }

export async function taxRules(db: Queryable, tenantId: string, at: Date): Promise<TaxValues> {
  const list = await taxRuleList(db, tenantId, at);
  const v = (k: TaxKey) => list.find((r) => r.key === k)!.value;
  return {
    gstPercent: v('gstPercent'), hotelTaxPercent: v('hotelTaxPercent'), hotelTaxGst: v('hotelTaxGst') === 'yes', serviceChargeGst: v('serviceChargeGst') === 'yes', serviceChargeHotelTax: v('serviceChargeHotelTax') === 'yes',
    unverified: list.filter((r) => !r.verified).map((r) => r.label),
  };
}
