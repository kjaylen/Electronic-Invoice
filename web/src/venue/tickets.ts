/**
 * What the hospitality module prints: the ticket a station works from, and
 * the guest check (a pre-bill, which is not a tax document and says so).
 * Pure, like the receipts in pos/ticket.ts, and printed the same ways.
 */

import type { BillPart } from '../../../src/venue/bill.ts';
import { centsText } from '../../../src/venue/bill.ts';
import { COURSES } from '../../../src/venue/check.ts';
import { formatAmount, type Ticket as Printed } from '../pos/ticket';
import type { Ticket } from './store';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const money = (cents: number) => formatAmount(centsText(cents));

/**
 * A station's ticket. Large where a cook looks first: the table, then each
 * dish with its count; choices indented under it; an allergy in a block of
 * its own that cannot be missed. A void or a change says so at the top and
 * the bottom, so it is never read as a new order.
 */
export function stationTicket(t: Ticket, stationName: string): Printed {
  const out: Printed = [];
  const b = t.body;
  if (t.kind !== 'order') {
    out.push({ kind: 'text', text: t.kind === 'void' ? '*** VOID: DO NOT MAKE ***' : '*** CHANGE ***', align: 'center', bold: true, size: 'large' });
    out.push({ kind: 'rule' });
  }
  out.push({ kind: 'text', text: stationName.toUpperCase(), align: 'center', bold: true });
  out.push({ kind: 'text', text: b.table, align: 'center', bold: true, size: 'large' });
  out.push({ kind: 'pair', left: `${time(b.at)}  #${b.number}`, right: `${b.server} · ${b.partySize}p` });
  if (b.allergy) {
    out.push({ kind: 'rule' });
    out.push({ kind: 'text', text: '!!! ALLERGY !!!', align: 'center', bold: true, size: 'large' });
    out.push({ kind: 'text', text: b.allergy, align: 'center', bold: true });
  }
  let course = -1;
  for (const i of b.items) {
    if (i.course !== course) {
      course = i.course;
      out.push({ kind: 'rule' });
      out.push({ kind: 'text', text: (COURSES[course] ?? 'Course').toUpperCase(), bold: true });
    }
    out.push({ kind: 'text', text: `${t.kind === 'void' ? 'VOID ' : ''}${i.quantity} x ${i.name}${i.seat ? `  (S${i.seat})` : ''}`, bold: true, size: 'large' });
    for (const m of i.modifiers) out.push({ kind: 'text', text: `    > ${m}` });
    if (i.note) out.push({ kind: 'text', text: `    ** ${i.note}`, bold: true });
    if (b.allergy && i.allergens.length) out.push({ kind: 'text', text: `    !! contains ${i.allergens.join(', ')}`, bold: true });
  }
  out.push({ kind: 'rule' });
  if (t.kind !== 'order') out.push({ kind: 'text', text: t.kind === 'void' ? '*** VOID ***' : '*** CHANGE ***', align: 'center', bold: true });
  out.push({ kind: 'feed', lines: 2 });
  return out;
}

/** The guest check: what the bill will be, before anyone pays. Never a tax document, and it says so twice. */
export function guestCheck(o: { business: string; label: string; server: string; partySize: number; part: BillPart; servicePercent: string | null; usdRateCents: number | null; at: Date }): Printed {
  const out: Printed = [];
  const notice = 'NOT A TAX DOCUMENT';
  out.push({ kind: 'text', text: o.business, align: 'center', bold: true });
  out.push({ kind: 'text', text: 'GUEST CHECK', align: 'center', bold: true, size: 'large' });
  out.push({ kind: 'text', text: notice, align: 'center', bold: true });
  out.push({ kind: 'pair', left: o.label, right: `${o.server} · ${o.partySize}p` });
  out.push({ kind: 'text', text: o.at.toLocaleString() });
  out.push({ kind: 'rule' });
  for (const l of o.part.lines) {
    out.push({ kind: 'pair', left: `${l.quantity === '1' ? '' : `${l.quantity} x `}${l.description}`, right: money(l.grossCents) });
    if (l.allowCents > 0) out.push({ kind: 'pair', left: `   ${l.allowReason || 'Discount'}`, right: `-${money(l.allowCents)}` });
  }
  out.push({ kind: 'rule' });
  out.push({ kind: 'pair', left: 'Subtotal', right: money(o.part.subtotalCents - o.part.allowCents) });
  if (o.part.serviceCents > 0) out.push({ kind: 'pair', left: `Service charge ${o.servicePercent ?? ''}%`, right: money(o.part.serviceCents) });
  out.push({ kind: 'pair', left: 'GST', right: money(o.part.gstCents) });
  out.push({ kind: 'pair', left: 'TOTAL BZ$', right: money(o.part.totalCents), bold: true });
  if (o.usdRateCents) out.push({ kind: 'pair', left: 'In US$', right: money(Math.ceil((o.part.totalCents * 100) / o.usdRateCents)) });
  out.push({ kind: 'rule' });
  out.push({ kind: 'text', text: `${notice}. Your tax receipt follows payment.`, align: 'center' });
  out.push({ kind: 'feed', lines: 2 });
  return out;
}
