/**
 * The language of a business's customer emails (English or Spanish): the lines the app writes
 * into them (amounts due, order thanks, how to pay) and the names of documents. Printed documents
 * keep BTS's English names; emails speak the customer's language.
 */

import type { Queryable } from '../db/database.ts';

export type Lang = 'en' | 'es';
export const LANGS: readonly Lang[] = ['en', 'es'];

export async function emailLanguage(db: Queryable, tenantId: string): Promise<Lang> {
  const r = (await db.query<{ email_language: string | null }>('select email_language from tenants where id = $1', [tenantId])).rows[0];
  return r?.email_language === 'es' ? 'es' : 'en';
}

const TYPE_NAMES_ES: Record<string, string> = {
  'Tax Invoice': 'Factura fiscal',
  'Tax Receipt': 'Recibo fiscal',
  'Debit Note': 'Nota de débito',
  'Credit Note': 'Nota de crédito',
};

/** "Tax Invoice" as the email's reader says it. */
export const documentTypeName = (name: string, lang: Lang) => (lang === 'es' ? TYPE_NAMES_ES[name] ?? name : name);

/** 22 Nov 2026 / 22 nov 2026. */
export const shortDate = (iso: string, lang: Lang) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

interface Phrases {
  /** A receivable's kind: an invoice ("01") or a debit note ("03"). */
  receivable: (type: string) => string;
  amountDue: (amount: string, date: string) => string;
  orderThanks: (number: number | string) => string;
  orderPaid: (number: number | string) => string;
  refund: (number: number | string) => string;
  payByTransfer: (total: string) => string;
  bankDetailsLater: string;
  orderReference: (number: number | string) => string;
  payCashOnDelivery: (total: string) => string;
  paidOnline: (total: string) => string;
  payAtPickup: (total: string) => string;
}

export const PHRASES: Record<Lang, Phrases> = {
  en: {
    receivable: (type) => (type === '03' ? 'Debit note' : 'Invoice'),
    amountDue: (amount, date) => `Amount due: ${amount} by ${date}.`,
    orderThanks: (n) => `Thank you for your order #${n}.`,
    orderPaid: (n) => `Thank you for your order #${n}. Your payment was received.`,
    refund: (n) => `Your refund for order #${n}.`,
    payByTransfer: (total) => `Pay ${total} by bank transfer:`,
    bankDetailsLater: 'The store will send you its bank details.',
    orderReference: (n) => `Use order #${n} as the reference.`,
    payCashOnDelivery: (total) => `Pay ${total} in cash when your order is delivered.`,
    paidOnline: (total) => `Total ${total}, paid online. Your receipt is emailed as soon as the payment is confirmed.`,
    payAtPickup: (total) => `Pay ${total} when you pick up your order.`,
  },
  es: {
    receivable: (type) => (type === '03' ? 'Nota de débito' : 'Factura'),
    amountDue: (amount, date) => `Monto a pagar: ${amount}, a más tardar el ${date}.`,
    orderThanks: (n) => `Gracias por su pedido #${n}.`,
    orderPaid: (n) => `Gracias por su pedido #${n}. Recibimos su pago.`,
    refund: (n) => `Su reembolso del pedido #${n}.`,
    payByTransfer: (total) => `Pague ${total} por transferencia bancaria:`,
    bankDetailsLater: 'La tienda le enviará sus datos bancarios.',
    orderReference: (n) => `Use el pedido #${n} como referencia.`,
    payCashOnDelivery: (total) => `Pague ${total} en efectivo cuando reciba su pedido.`,
    paidOnline: (total) => `Total ${total}, pagado en línea. Su recibo se envía por correo en cuanto se confirme el pago.`,
    payAtPickup: (total) => `Pague ${total} cuando retire su pedido.`,
  },
};
