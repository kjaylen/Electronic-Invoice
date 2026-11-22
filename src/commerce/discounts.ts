/**
 * Discount codes for the online store.
 *
 *   percent        a percent off every item line
 *   amount         BZ$ off the items, GST included (shared over the lines by their total)
 *   free_delivery  the delivery fee is not charged
 *
 * A discount becomes an allowance on each item line (before GST), so the
 * e-invoice shows it the way BTS expects and GST is charged on the discounted
 * price. Refunds share a line's allowance over its units exactly (the parts of
 * several partial refunds always add up to the whole).
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { compare, formatCents, parseCents, parseDecimal, percentOf, roundToCents } from '../engine/decimal.ts';

export class DiscountError extends Error {
  override name = 'DiscountError';
}

export type DiscountKind = 'percent' | 'amount' | 'free_delivery';

export interface DiscountRow {
  id: string;
  tenant_id: string;
  code: string;
  kind: DiscountKind;
  value: string;
  min_subtotal: string | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  max_uses: number | null;
  uses: number;
  active: boolean;
  created_at: Date | string;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function discountJson(r: DiscountRow) {
  const trim = (v: string | null) => (v === null ? null : String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  return {
    id: r.id, code: r.code, kind: r.kind, value: trim(r.value), minSubtotal: trim(r.min_subtotal),
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null, endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    maxUses: r.max_uses, uses: r.uses, active: r.active, createdAt: new Date(r.created_at).toISOString(),
  };
}

export interface NewDiscount {
  code: string;
  kind: DiscountKind;
  value?: string;
  minSubtotal?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  maxUses?: number | null;
}

export async function createDiscount(db: Queryable, tenantId: string, d: NewDiscount): Promise<DiscountRow> {
  const code = normalizeCode(d.code);
  if (!CODE.test(code)) throw new DiscountError('Codes are 3 to 32 letters, digits, dashes or underscores');
  const value = d.kind === 'free_delivery' ? '0' : d.value ?? '';
  if (d.kind !== 'free_delivery') {
    const v = parseDecimal(value, { maxScale: 2, field: 'value' });
    if (compare(v, parseDecimal('0')) <= 0) throw new DiscountError('The discount must be more than zero');
    if (d.kind === 'percent' && compare(v, parseDecimal('100')) > 0) throw new DiscountError('A percent discount is at most 100');
  }
  if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt)) throw new DiscountError('The end must be after the start');
  if ((await db.query('select 1 from discount_codes where tenant_id = $1 and code = $2', [tenantId, code])).rows.length) throw new DiscountError('You already have this code');
  const id = randomUUID();
  await db.query(
    'insert into discount_codes (id, tenant_id, code, kind, value, min_subtotal, starts_at, ends_at, max_uses) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, tenantId, code, d.kind, value, d.minSubtotal || null, d.startsAt || null, d.endsAt || null, d.maxUses ?? null],
  );
  return (await db.query<DiscountRow>('select * from discount_codes where id = $1', [id])).rows[0]!;
}

/** A code a buyer may use now, for an order whose items come to `itemsTotal` (with GST). */
export async function findUsableDiscount(db: Queryable, tenantId: string, rawCode: string, itemsTotalCents: bigint): Promise<DiscountRow> {
  const code = normalizeCode(rawCode);
  const d = (await db.query<DiscountRow>('select * from discount_codes where tenant_id = $1 and code = $2', [tenantId, code])).rows[0];
  const now = new Date();
  if (!d || !d.active) throw new DiscountError('This discount code is not valid');
  if (d.starts_at && new Date(d.starts_at) > now) throw new DiscountError('This discount code is not valid yet');
  if (d.ends_at && new Date(d.ends_at) <= now) throw new DiscountError('This discount code has expired');
  if (d.max_uses !== null && d.uses >= d.max_uses) throw new DiscountError('This discount code has been used up');
  if (d.min_subtotal !== null && itemsTotalCents < parseCents(String(Number(d.min_subtotal).toFixed(2)))) {
    throw new DiscountError(`This code needs an order of at least BZ$${Number(d.min_subtotal).toFixed(2)}`);
  }
  return d;
}

/**
 * Each item line's discount, before GST, in cents.
 * `lines` are the undiscounted lines: net (before GST) and total (with GST).
 */
export function allocateDiscount(d: Pick<DiscountRow, 'kind' | 'value'>, lines: Array<{ net: bigint; total: bigint }>): bigint[] {
  if (d.kind === 'free_delivery') return lines.map(() => 0n);
  if (d.kind === 'percent') {
    const pct = parseDecimal(String(d.value));
    return lines.map((l) => {
      const off = roundToCents(percentOf(parseDecimal(formatCents(l.net)), pct));
      return off > l.net ? l.net : off;
    });
  }
  // A BZ$ amount off the items, GST included: shared by line total (largest remainder), then each share taken back to before GST.
  const total = lines.reduce((s, l) => s + l.total, 0n);
  if (total <= 0n) return lines.map(() => 0n);
  let off = parseCents(String(Number(d.value).toFixed(2)));
  if (off > total) off = total;
  const raw = lines.map((l) => (off * l.total * 1000n) / total);
  const shares = raw.map((r) => r / 1000n);
  let rest = off - shares.reduce((s, x) => s + x, 0n);
  const order = raw.map((r, i) => [r % 1000n, i] as const).sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0));
  for (const [, i] of order) {
    if (rest <= 0n) break;
    shares[i]! += 1n;
    rest -= 1n;
  }
  return lines.map((l, i) => {
    if (l.total === 0n) return 0n;
    const net = (shares[i]! * l.net * 2n + l.total) / (2n * l.total); // rounded half up
    return net > l.net ? l.net : net;
  });
}

/** The part of a line's discount that goes with `quantity` more units, after `alreadyRefunded` units. Parts always add up to the whole. */
export function discountShare(lineDiscount: bigint, lineQuantity: number, alreadyRefunded: number, quantity: number): bigint {
  if (lineDiscount === 0n || lineQuantity <= 0) return 0n;
  const at = (q: number) => (lineDiscount * BigInt(q) * 2n + BigInt(lineQuantity)) / (2n * BigInt(lineQuantity));
  return at(alreadyRefunded + quantity) - at(alreadyRefunded);
}
