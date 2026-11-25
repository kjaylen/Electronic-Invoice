/**
 * From a check to a bill: what each item comes to, the parts of a split
 * bill, and the lines that go on the receipt. Pure, whole cents, shared by
 * the server and the apps.
 *
 * Splitting never loses or invents a cent. Every item has three amounts
 * (gross, allowance, service charge); each payment takes a slice of what is
 * left and is recorded with what it took; whoever pays last takes what
 * remains. So the parts' amounts before GST always add up to the bill's.
 *
 * GST is rounded on each receipt (the manual's rule), so several receipts
 * could differ from one by a cent. To stop that, a part that is not the last
 * is nudged by a few cents (taken from, and left for, a shared item) until
 * its taxable amount carries GST with nothing to round. Then the parts'
 * totals add up to the unsplit bill's total exactly. It needs one shared
 * standard-rated item in the part; an even split always has one.
 */

import { type Check, type CheckItem, fullyPaid, lineCents, paidShares, unitWithModifiers } from './check.ts';
import { type BillUnit, billPromotions, type Period } from './pricing.ts';

export interface BillContext {
  /** The service charge in percent ("10"), or null when this check carries none. */
  servicePercent: string | null;
  /** GST standard rate in percent ("12.5"). */
  gstPercent: string;
  periods: Period[];
}

export interface ItemAmounts { grossCents: number; allowCents: number; allowReason: string; serviceCents: number }

/** Percent of cents, half up, with a decimal percent ("12.5") and no floating point. */
export function percentCents(cents: number, percent: string): number {
  const [whole, frac = ''] = percent.split('.');
  const scale = 10 ** frac.length;
  const p = Number(whole) * scale + Number(frac || 0);
  const n = cents * p;
  const d = 100 * scale;
  return n >= 0 ? Math.floor((2 * n + d) / (2 * d)) : -Math.floor((2 * -n + d) / (2 * d));
}

/** The smallest step of a taxable amount whose GST is a whole number of cents: 8 cents at 12.5%. */
export function exactStep(percent: string): number {
  const [whole, frac = ''] = percent.split('.');
  const scale = 10 ** frac.length;
  const num = Number(whole) * scale + Number(frac || 0);
  const den = 100 * scale;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  return num === 0 ? 1 : den / gcd(num, den);
}

/** Does the venue's service charge apply to this check? (Someone's decision on the check wins over the rule.) */
export function serviceApplies(check: Check, rule: { serviceCharge: 'off' | 'all' | 'party'; servicePartySize: number }): boolean {
  if (rule.serviceCharge === 'off') return false;
  if (check.serviceCharge !== null) return check.serviceCharge;
  if (check.kind === 'quick') return false;
  return rule.serviceCharge === 'all' || check.partySize >= rule.servicePartySize;
}

/** What every live item of the check comes to, whole: before any of it is paid. */
export function checkAmounts(check: Check, ctx: BillContext): Map<string, ItemAmounts> {
  const items = check.items.filter((i) => i.status !== 'void');
  // Two for one and bundles look at the whole bill, unit by unit.
  const units: BillUnit[] = items.flatMap((i) => (i.itemId && i.tags.length && !i.comp ? Array.from({ length: i.quantity }, (_, n) => ({ key: `${i.id}#${n}`, itemId: i.itemId!, unitCents: unitWithModifiers(i), tags: i.tags })) : []));
  const promos = units.length ? billPromotions(units, ctx.periods) : new Map<string, { cents: number; name: string }>();
  const out = new Map<string, ItemAmounts>();
  for (const i of items) {
    const grossCents = lineCents(i);
    let allowCents = 0;
    const reasons: string[] = [];
    if (i.comp) {
      allowCents = grossCents;
      reasons.push(`Complimentary: ${i.comp.reason}`);
    } else {
      for (let n = 0; n < i.quantity; n++) {
        const promo = promos.get(`${i.id}#${n}`);
        if (promo) { allowCents += promo.cents; if (!reasons.includes(promo.name)) reasons.push(promo.name); }
      }
      if (i.discount) {
        const base = grossCents - allowCents;
        const cut = i.discount.percent ? percentCents(base, String(i.discount.percent)) : Math.min(i.discount.cents ?? 0, base);
        allowCents += cut;
        reasons.push(`Discount${i.discount.percent ? ` ${i.discount.percent}%` : ''}: ${i.discount.reason}`);
      }
    }
    const serviceCents = ctx.servicePercent ? percentCents(grossCents - allowCents, ctx.servicePercent) : 0;
    // A deposit already paid (and receipted): off the line, after the service charge is worked out on the full price.
    if (i.deposit && !i.comp) {
      allowCents += Math.min(i.deposit.cents, grossCents - allowCents);
      reasons.push('Deposit paid');
    }
    out.set(i.id, { grossCents, allowCents, allowReason: reasons.join('; ').slice(0, 100), serviceCents });
  }
  return out;
}

export interface BillLine {
  checkItemId: string;
  itemId: string | null;
  description: string;
  /** For the receipt: a whole item keeps its quantity and price; a share is one of "a third of". */
  quantity: string;
  unitCents: number;
  unitCode: string;
  gst: 'S' | 'Z' | 'E';
  exemptionReasonCode?: string;
  grossCents: number;
  allowCents: number;
  allowReason: string;
  serviceCents: number;
  /** gross - allowance + service. */
  netCents: number;
  /** Shares of the item this line pays, of how many. */
  shares: number;
  ofShares: number;
  seat: number;
  /** This line takes all that was left of the item. */
  last: boolean;
  /** The item whole and untouched: the receipt line is the catalog item, and stock comes off with it. */
  whole: boolean;
}

export interface BillPart {
  key: string;
  label: string;
  lines: BillLine[];
  subtotalCents: number;
  allowCents: number;
  serviceCents: number;
  gstCents: number;
  totalCents: number;
}

const left = (item: CheckItem, a: ItemAmounts) => item.paid.reduce((r, p) => ({
  grossCents: r.grossCents - (p.grossCents ?? 0), allowCents: r.allowCents - (p.allowCents ?? 0), serviceCents: r.serviceCents - (p.serviceCents ?? 0),
}), { grossCents: a.grossCents, allowCents: a.allowCents, serviceCents: a.serviceCents });

const describe = (i: CheckItem) => (i.modifiers.length ? `${i.name} (${i.modifiers.map((m) => m.name).join(', ')})` : i.name).slice(0, 180);

/** Totals of a set of lines as one receipt: GST rounded per category on the receipt's total. */
export function totalsOf(lines: BillLine[], gstPercent: string) {
  const standard = lines.filter((l) => l.gst === 'S').reduce((a, l) => a + l.netCents, 0);
  const gstCents = percentCents(standard, gstPercent);
  const subtotalCents = lines.reduce((a, l) => a + l.grossCents, 0);
  const allowCents = lines.reduce((a, l) => a + l.allowCents, 0);
  const serviceCents = lines.reduce((a, l) => a + l.serviceCents, 0);
  return { subtotalCents, allowCents, serviceCents, gstCents, totalCents: subtotalCents - allowCents + serviceCents + gstCents };
}

/**
 * One part of a bill: these shares of these items. `final` says nothing of
 * the check will be left to pay after it; a part that is not final is
 * balanced so its GST needs no rounding (see the top of the file).
 */
export function billPart(check: Check, amounts: Map<string, ItemAmounts>, take: Array<{ itemId: string; shares: number }>, ctx: BillContext, key: string, label: string): BillPart {
  const lines: BillLine[] = [];
  for (const t of take) {
    const item = check.items.find((i) => i.id === t.itemId);
    const whole = amounts.get(t.itemId);
    if (!item || !whole || item.status === 'void') continue;
    const remainingShares = item.shares - paidShares(item);
    const shares = Math.min(t.shares, remainingShares);
    if (shares < 1) continue;
    const rest = left(item, whole);
    const last = shares === remainingShares;
    const slice = (cents: number) => (last ? cents : Math.floor((cents * shares) / remainingShares));
    const grossCents = slice(rest.grossCents);
    const allowCents = Math.min(slice(rest.allowCents), grossCents);
    const serviceCents = Math.max(0, slice(rest.serviceCents));
    const untouched = item.shares === 1 && item.paid.length === 0;
    lines.push({
      checkItemId: item.id, itemId: item.itemId,
      description: untouched ? describe(item) : `${describe(item)} (${shares} of ${item.shares} shares${item.quantity > 1 ? ` of ${item.quantity}` : ''})`.slice(0, 200),
      quantity: untouched ? String(item.quantity) : '1',
      unitCents: untouched ? unitWithModifiers(item) : grossCents,
      unitCode: item.unitCode, gst: item.gst, ...(item.exemptionReasonCode && { exemptionReasonCode: item.exemptionReasonCode }),
      grossCents, allowCents, allowReason: whole.allowReason, serviceCents, netCents: grossCents - allowCents + serviceCents,
      shares, ofShares: item.shares, seat: item.seat, last, whole: untouched,
    });
  }
  // Is anything of the check left after this part? Then make this part's GST exact.
  const taken = new Map(lines.map((l) => [l.checkItemId, l.shares]));
  const final = check.items.every((i) => i.status === 'void' || fullyPaid(i) || (taken.get(i.id) ?? 0) >= i.shares - paidShares(i));
  if (!final) {
    const step = exactStep(ctx.gstPercent);
    const over = lines.filter((l) => l.gst === 'S').reduce((a, l) => a + l.netCents, 0) % step;
    // A shared line that leaves something behind can give up a few cents to whoever pays after.
    const give = lines.filter((l) => l.gst === 'S' && !l.last && l.grossCents - l.allowCents > over).sort((a, b) => b.grossCents - a.grossCents)[0];
    if (over && give) {
      give.grossCents -= over;
      give.unitCents = give.grossCents;
      give.netCents -= over;
    }
  }
  return { key, label, lines, ...totalsOf(lines, ctx.gstPercent) };
}

const unpaid = (check: Check) => check.items.filter((i) => i.status !== 'void' && !fullyPaid(i));

/** Everything still to pay, as one bill. */
export function wholeBill(check: Check, ctx: BillContext): BillPart {
  const amounts = checkAmounts(check, ctx);
  return billPart(check, amounts, unpaid(check).map((i) => ({ itemId: i.id, shares: i.shares - paidShares(i) })), ctx, 'all', 'The whole bill');
}

/** By seat: each guest's own items; what was ordered for the table is a part of its own until it is shared. */
export function billBySeat(check: Check, ctx: BillContext): BillPart[] {
  const amounts = checkAmounts(check, ctx);
  const seats = [...new Set(unpaid(check).map((i) => i.seat))].sort((a, b) => a - b);
  return seats.map((seat) => billPart(check, amounts, unpaid(check).filter((i) => i.seat === seat).map((i) => ({ itemId: i.id, shares: i.shares - paidShares(i) })), ctx, `seat-${seat}`, seat === 0 ? 'Table' : `Seat ${seat}`));
}

/** One share of every unpaid item: an even split once each item is shared between the payers. */
export function billOneShare(check: Check, ctx: BillContext): BillPart {
  const amounts = checkAmounts(check, ctx);
  const n = Math.max(...unpaid(check).map((i) => i.shares - paidShares(i)), 1);
  return billPart(check, amounts, unpaid(check).map((i) => ({ itemId: i.id, shares: 1 })), ctx, 'share', `1 of ${n} left`);
}

/** Chosen items (and shares of them). */
export function billOfItems(check: Check, ctx: BillContext, take: Array<{ itemId: string; shares: number }>, label = 'Selected items'): BillPart {
  return billPart(check, checkAmounts(check, ctx), take, ctx, 'items', label);
}

const money = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
export const centsText = money;

/** A part as the lines of a tax document (POST /v1/documents), amounts given outright so nothing is worked out twice. */
export function documentLines(part: BillPart, servicePercent: string | null) {
  return part.lines.map((l) => ({
    ...(l.itemId && l.whole ? { itemId: l.itemId } : {}),
    description: l.description,
    quantity: l.quantity,
    unitCode: l.unitCode,
    unitPrice: money(l.unitCents),
    gstCategory: l.gst,
    ...(l.gst === 'E' && l.exemptionReasonCode && { exemptionReasonCode: l.exemptionReasonCode }),
    ...((l.allowCents > 0 || l.serviceCents > 0) && {
      allowanceCharges: [
        ...(l.allowCents > 0 ? [{ isCharge: false, reason: l.allowReason || 'Discount', amount: money(l.allowCents) }] : []),
        ...(l.serviceCents > 0 ? [{ isCharge: true, reason: `Service charge ${servicePercent ?? ''}%`.replace(' %', ''), amount: money(l.serviceCents) }] : []),
      ],
    }),
  }));
}

/** What a payment of this part records on the check: the shares and the cents each took. */
export const paymentOf = (part: BillPart) => part.lines.map((l) => ({ itemId: l.checkItemId, shares: l.shares, grossCents: l.grossCents, allowCents: l.allowCents, serviceCents: l.serviceCents }));
