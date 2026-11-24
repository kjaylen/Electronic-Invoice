/**
 * A payment reminder for WhatsApp: many customers in Belize read WhatsApp
 * and not email. Nothing is sent from here: this writes the message and a
 * wa.me link that opens the chat with it typed in, on the phone or computer
 * of whoever is collecting. They press send themselves.
 */

import type { Lang } from '../templates/lang.ts';

/** Belize's country code: local numbers are 7 digits. */
const BELIZE = '501';

/**
 * A phone number as WhatsApp wants it: digits only, with the country code.
 * A 7-digit number is taken as a Belize one. Null when it cannot be a number.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // An extension, or a second number after a slash or comma, is not part of it.
  let digits = phone.split(/[,/;]|\bext\b|\bx\b/i)[0]!.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 7) digits = BELIZE + digits;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export interface ReminderMessage {
  customer: string;
  business: string;
  /** "invoice 001-000000012". */
  what: string;
  /** "BZ$1,250.00". */
  balance: string;
  /** "24 November 2026", in the language of the message. */
  dueDate: string;
  /** Days past the due date (negative: still to come). */
  daysLate: number;
  /** Where to see the invoice and, when the business takes payments online, pay it. */
  link?: string;
  canPayOnline?: boolean;
  /** The business's own words on how to pay (bank details). */
  instructions?: string;
}

/** The message, short and polite, in the business's email language. */
export function reminderMessage(m: ReminderMessage, lang: Lang = 'en'): string {
  const first = m.customer.trim().split(/\s+/)[0] ?? '';
  const person = /^(walk-in|cliente)/i.test(m.customer) ? '' : ` ${m.customer.length <= 24 ? m.customer.trim() : first}`;
  if (lang === 'es') {
    const due = m.daysLate > 0 ? `venció el ${m.dueDate}` : m.daysLate === 0 ? 'vence hoy' : `vence el ${m.dueDate}`;
    return [
      `Hola${person}, le saluda ${m.business}.`,
      `Le recordamos que la ${m.what} por ${m.balance} ${due}.`,
      m.link ? (m.canPayOnline ? `Puede verla y pagarla aquí: ${m.link}` : `Puede verla aquí: ${m.link}`) : '',
      m.instructions ?? '',
      'Si ya pagó, no haga caso de este mensaje. ¡Gracias!',
    ].filter(Boolean).join('\n\n');
  }
  const due = m.daysLate > 0 ? `was due on ${m.dueDate}` : m.daysLate === 0 ? 'is due today' : `is due on ${m.dueDate}`;
  return [
    `Hello${person}, this is ${m.business}.`,
    `A friendly reminder that ${m.what} for ${m.balance} ${due}.`,
    m.link ? (m.canPayOnline ? `You can see it and pay here: ${m.link}` : `You can see it here: ${m.link}`) : '',
    m.instructions ?? '',
    'If you have already paid, please ignore this message. Thank you!',
  ].filter(Boolean).join('\n\n');
}

/** The link that opens WhatsApp with the message written, to that number. */
export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
