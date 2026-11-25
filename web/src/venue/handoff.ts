/**
 * Paying a check. The part to pay is handed to the counter, which already
 * knows every way to be paid (cash in BZ$ or US$, card, wallet, split, tips,
 * the receipt, the offline till). When the counter has issued the document,
 * the payment is written back on the check.
 */

import { dispatch } from './store';

export interface PayLine {
  itemId?: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode?: string;
  allowanceCharges?: Array<{ isCharge: boolean; reason: string; amount: string }>;
}

export interface VenuePay {
  checkId: string;
  /** "Table 5, seat 2", "Maria's tab". */
  label: string;
  lines: PayLine[];
  /** What the payment takes of each item (bill.ts paymentOf). */
  items: Array<{ itemId: string; shares: number; grossCents: number; allowCents: number; serviceCents: number }>;
  /** Charged to a hotel room: the stay, and who the server confirmed it with. */
  room?: { bookingId: string; guest: string; room: string };
}

export const PAY_EVENT = 'venue:pay';
export const PAID_EVENT = 'venue:paid';
let current: VenuePay | null = null;

export function startPay(pay: VenuePay) {
  current = pay;
  window.dispatchEvent(new Event(PAY_EVENT));
}
export const peekPay = () => current;
export function clearPay() {
  current = null;
  window.dispatchEvent(new Event(PAID_EVENT));
}
/** The document is issued: mark what it paid, and go back to the floor. */
export function finishPay(pay: VenuePay, documentId: string, tipCents: number, tipMeans: string, summary: string) {
  dispatch(pay.checkId, 'pay', { documentId, items: pay.items, ...(tipCents > 0 && { tipCents, tipMeans }), summary });
  current = null;
  window.dispatchEvent(new CustomEvent(PAID_EVENT, { detail: { documentId } }));
}
