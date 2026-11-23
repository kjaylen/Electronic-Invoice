/**
 * Every template a business can edit: what it is for, its built-in default (defaults/*.liquid),
 * what it must keep, the variables it can use, and sample data to preview it with.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TemplateGroup = 'emails' | 'documents' | 'store';
export interface VariableDoc { name: string; description: string }

export interface TemplateDef {
  key: string;
  group: TemplateGroup;
  name: string;
  description: string;
  /** What the editor highlights and the preview shows. */
  language: 'html' | 'css';
  /** For emails: the subject line template (and its Spanish default). */
  subject?: string;
  subjectEs?: string;
  /** How the preview is framed: an email, a page of A4, a receipt roll, a store section. */
  preview: 'email' | 'a4' | 'receipt' | 'section' | 'css';
  /** Things a saved template must contain. */
  requires?: Array<{ pattern: RegExp; message: string }>;
  variables: VariableDoc[];
  file: string;
}

const BTS = { pattern: /\{%-?\s*bts\b[^%]*-?%\}/, message: 'Keep {% bts %}: BTS requires the QR code, the ETDUI, the authorization and the legal notices on every printed copy.' };

const BUSINESS: VariableDoc[] = [
  { name: 'business.name', description: 'Your business name (trade name, or legal name)' },
  { name: 'business.legal_name', description: 'Your registered name' },
  { name: 'business.tin', description: 'Your TIN' },
  { name: 'business.address_lines', description: 'Your address, line by line (a list)' },
  { name: 'business.telephone', description: 'Your phone number' },
  { name: 'business.email', description: 'Your email address' },
  { name: 'business.logo', description: 'Your logo\'s address, for <img src="…"> (empty when you have none; choose it under Images)' },
];
const IMAGES: VariableDoc = { name: "'name.png' | asset_url", description: 'Any image you uploaded under Images, e.g. <img src="{{ \'banner.png\' | asset_url }}">' };
const CUSTOMER: VariableDoc[] = [
  { name: 'customer.name', description: "The customer's name" },
  { name: 'customer.email', description: "The customer's email" },
];
const DOCUMENT_SUMMARY: VariableDoc[] = [
  { name: 'document.type_name', description: 'Tax Invoice, Tax Receipt, Credit Note…' },
  { name: 'document.number_display', description: 'Series and number, e.g. 001-000000042' },
  { name: 'document.issue_date', description: 'The date it was issued (YYYY-MM-DD; use | date)' },
  { name: 'document.due_date', description: 'When it is due (invoices on credit)' },
  { name: 'document.total', description: 'The total (use | money)' },
];
const PRINTED: VariableDoc[] = [
  { name: 'document.type_name', description: 'Tax Invoice, Tax Receipt, Debit Note, Credit Note' },
  { name: 'document.number', description: 'The number (9 digits)' },
  { name: 'document.series', description: 'The series (3 digits)' },
  { name: 'document.issue_date', description: 'YYYY-MM-DD (use | date)' },
  { name: 'document.issue_time', description: 'HH:MM:SS, Belize time' },
  { name: 'document.issuer', description: 'Your business as on the document: name, tin, address_lines, telephone, email' },
  { name: 'document.customer', description: 'The customer as on the document: name, tin, other_id, address_lines (empty for walk-in sales)' },
  { name: 'document.lines', description: 'The lines: number, description, code, quantity, unit_code, unit_price, adjustments, net, tax, total' },
  { name: 'document.totals', description: 'tax_exclusive, gst, other_taxes (name, amount), tax_inclusive, prepaid, payable' },
  { name: 'document.payment', description: 'due_date and terms, when the document has them' },
  { name: 'document.note', description: 'The note written on the document' },
  { name: 'document.info', description: 'Payment and note lines, ready to print (a list)' },
  { name: 'message', description: 'Your message for printed copies (Settings → Business)' },
  { name: 'business.logo', description: 'Your logo\'s address (empty when you have none)' },
  { name: '{% bts %}', description: "BTS's required block: QR code, ETDUI, authorization and legal notices. {% bts 'stacked' %} for narrow layouts" },
  IMAGES,
];

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'email.document', group: 'emails', name: 'Document email', preview: 'email', language: 'html', file: 'email-document.liquid',
    description: 'Sent with an invoice, receipt or note. The PDF and the signed XML are attached.',
    subject: '{{ document.type_name }} {{ document.number_display }} from {{ business.name }}',
    subjectEs: '{{ document.type_name }} {{ document.number_display }} de {{ business.name }}',
    variables: [...BUSINESS, IMAGES, ...CUSTOMER, ...DOCUMENT_SUMMARY, { name: 'intro', description: 'Opening lines the app writes for some emails (a list; empty for a plain send)' }, { name: 'message', description: 'The message typed when sending, or your payment instructions' }, { name: 'pay_url', description: 'A link to pay online (invoices, when payments are on)' }],
  },
  {
    key: 'email.reminder', group: 'emails', name: 'Payment reminder', preview: 'email', language: 'html', file: 'email-reminder.liquid',
    description: 'Sent before, on and after an invoice is due, as set in Getting paid.',
    subject: "{% case reminder.when %}{% when 'after' %}Overdue: {{ reminder.what }} from {{ business.name }}{% when 'due' %}Reminder: {{ reminder.what }} from {{ business.name }} is due today{% else %}Reminder: {{ reminder.what }} from {{ business.name }} is due {% if reminder.days == 1 %}tomorrow{% else %}in {{ reminder.days }} days{% endif %}{% endcase %}",
    subjectEs: "{% case reminder.when %}{% when 'after' %}Vencida: {{ reminder.what }} de {{ business.name }}{% when 'due' %}Recordatorio: {{ reminder.what }} de {{ business.name }} vence hoy{% else %}Recordatorio: {{ reminder.what }} de {{ business.name }} vence {% if reminder.days == 1 %}mañana{% else %}en {{ reminder.days }} días{% endif %}{% endcase %}",
    variables: [...BUSINESS, IMAGES, ...CUSTOMER, ...DOCUMENT_SUMMARY, { name: 'reminder.when', description: '"before", "due" or "after"' }, { name: 'reminder.days', description: 'Days before or after the due date' }, { name: 'reminder.what', description: 'The invoice, e.g. "invoice 001-000000042"' }, { name: 'reminder.balance', description: 'What is still owed (use | money)' }, { name: 'message', description: 'Your payment instructions' }, { name: 'pay_url', description: 'A link to pay online' }],
  },
  {
    key: 'email.statement', group: 'emails', name: 'Statement of account', preview: 'email', language: 'html', file: 'email-statement.liquid',
    description: 'A customer\'s statement, with the PDF attached.',
    subject: 'Statement of account from {{ business.name }}',
    subjectEs: 'Estado de cuenta de {{ business.name }}',
    variables: [...BUSINESS, IMAGES, ...CUSTOMER, { name: 'statement.as_of', description: 'The date of the statement' }, { name: 'statement.open', description: 'What is still owed: label, number, issue_date, due_date, days_overdue, total, paid, balance, pay_url' }, { name: 'statement.total_due', description: 'Everything owed' }, { name: 'statement.overdue', description: 'What is past due' }, { name: 'statement.note', description: 'Your payment instructions' }, { name: 'statement.account_url', description: 'The customer\'s account page (saved customers; may be empty)' }],
  },
  {
    key: 'email.quote', group: 'emails', name: 'Quotation email', preview: 'email', language: 'html', file: 'email-quote.liquid',
    description: 'Sent with a quotation; the customer views and accepts it online.',
    subject: 'Quotation {{ quote.number }} from {{ business.name }}',
    subjectEs: 'Cotización {{ quote.number }} de {{ business.name }}',
    variables: [...BUSINESS, IMAGES, ...CUSTOMER, { name: 'quote.number', description: 'The quotation number' }, { name: 'quote.total', description: 'The total' }, { name: 'quote.valid_until', description: 'Until when it stands' }, { name: 'view_url', description: 'The link to view and accept it' }, { name: 'message', description: 'The message typed when sending' }],
  },
  {
    key: 'email.purchase-order', group: 'emails', name: 'Purchase order email', preview: 'email', language: 'html', file: 'email-purchase-order.liquid',
    description: 'Sent to a supplier with a purchase order; the PDF is attached.',
    subject: 'Purchase order {{ order.number }} from {{ business.name }}',
    subjectEs: 'Orden de compra {{ order.number }} de {{ business.name }}',
    variables: [...BUSINESS, IMAGES, { name: 'supplier.name', description: "The supplier's name" }, { name: 'supplier.email', description: 'Where it is sent' }, { name: 'order.number', description: 'The order number, e.g. PO-12' }, { name: 'order.expected_on', description: 'When you want it (may be empty)' }, { name: 'order.lines', description: 'What is ordered: description, code, quantity, unit_cost, total' }, { name: 'order.total', description: 'The total before GST' }, { name: 'message', description: 'The message typed when sending' }],
  },
  {
    key: 'email.order', group: 'emails', name: 'Order confirmation', preview: 'email', language: 'html', file: 'email-order.liquid',
    description: 'Sent to a buyer after they order from your online store.',
    subject: 'Order #{{ order.number }} at {{ store.name }}',
    subjectEs: 'Pedido #{{ order.number }} en {{ store.name }}',
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES, { name: 'store.city', description: 'Where you are' }, { name: 'store.telephone', description: 'Your phone' }, { name: 'order.number', description: 'The order number' }, { name: 'order.customer_name', description: "The buyer's name" }, { name: 'order.items', description: 'What they bought: name, variant, quantity, total' }, { name: 'order.payment_method', description: 'bank_transfer, cash_on_delivery, pay_at_pickup or online' }, { name: 'order.payment_lines', description: 'How to pay, from your store settings (a list)' }, { name: 'order.delivery', description: 'true for delivery, false for pickup' }, { name: 'order.address', description: 'The delivery area' }, { name: 'order.delivery_fee', description: 'The delivery charge' }, { name: 'order.total', description: 'The total' }, { name: 'order.paid', description: 'true when paid online' }, { name: 'order.url', description: 'The order page' }],
  },
  {
    key: 'email.order-ready', group: 'emails', name: 'Order ready', preview: 'email', language: 'html', file: 'email-order-ready.liquid',
    description: 'Sent to a buyer when you mark their order ready for pickup, or out for delivery.',
    subject: "{% if order.delivery %}Your order #{{ order.number }} from {{ store.name }} is on its way{% else %}Your order #{{ order.number }} is ready for pickup at {{ store.name }}{% endif %}",
    subjectEs: "{% if order.delivery %}Su pedido #{{ order.number }} de {{ store.name }} va en camino{% else %}Su pedido #{{ order.number }} está listo para recoger en {{ store.name }}{% endif %}",
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES, { name: 'store.city', description: 'Where you are' }, { name: 'store.telephone', description: 'Your phone' }, { name: 'order.number', description: 'The order number' }, { name: 'order.customer_name', description: "The buyer's name" }, { name: 'order.delivery', description: 'true for delivery, false for pickup' }, { name: 'order.address', description: 'The delivery area' }, { name: 'order.pickup_address', description: 'Where to pick it up' }, { name: 'order.pickup_instructions', description: 'Your pickup instructions (store settings)' }, { name: 'order.items', description: 'What they bought: name, variant, quantity' }, { name: 'message', description: 'The message typed when marking it ready' }],
  },
  {
    key: 'document.invoice', group: 'documents', name: 'Invoice and notes (A4)', preview: 'a4', language: 'html', file: 'document-invoice.liquid',
    description: 'The printed copy of tax invoices, debit notes and credit notes, and the PDF you email.',
    requires: [BTS], variables: PRINTED,
  },
  {
    key: 'document.receipt', group: 'documents', name: 'Receipt (80 mm roll)', preview: 'receipt', language: 'html', file: 'document-receipt.liquid',
    description: 'Tax receipts, and any document printed as a receipt.',
    requires: [BTS], variables: PRINTED,
  },
  {
    key: 'document.quote', group: 'documents', name: 'Quotation (A4)', preview: 'a4', language: 'html', file: 'document-quote.liquid',
    description: 'The quotation PDF. Not a tax document: lay it out however you like.',
    variables: [...BUSINESS, IMAGES, { name: 'customer', description: 'name, tin, address_lines, email' }, { name: 'quote', description: 'number, date, valid_until, status, lines (description, quantity, unit, unit_price, gst, total), totals (subtotal, gst, total), terms, note' }],
  },
  {
    key: 'document.statement', group: 'documents', name: 'Statement of account (A4)', preview: 'a4', language: 'html', file: 'document-statement.liquid',
    description: 'The statement PDF: what a customer still owes and their recent payments.',
    variables: [...BUSINESS, IMAGES, { name: 'customer', description: 'name, tin' }, { name: 'statement', description: 'as_of, open (type, number, issue_date, due_date, days_overdue, total, paid, balance), payments (number, paid_on, method, reference, amount), total_due, overdue, note' }, { name: 'pay_url', description: 'A link to pay online' }],
  },
  {
    key: 'store.theme', group: 'store', name: 'Theme CSS', preview: 'css', language: 'css', file: 'store-theme.liquid',
    description: 'Your own CSS for the online store, added after the built-in styles.',
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES],
  },
  {
    key: 'store.announcement', group: 'store', name: 'Announcement bar', preview: 'section', language: 'html', file: 'store-announcement.liquid',
    description: 'A bar across the top of every store page. Empty: none.',
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES, { name: 'store.city', description: 'Where you are' }],
  },
  {
    key: 'store.home', group: 'store', name: 'Home page section', preview: 'section', language: 'html', file: 'store-home.liquid',
    description: 'A section on the home page, between the welcome and the products. Empty: none.',
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES, { name: 'store.tagline', description: 'Your tagline' }, { name: 'store.city', description: 'Where you are' }, { name: 'products', description: 'Your products: name, price, url, image (newest first)' }],
  },
  {
    key: 'store.footer', group: 'store', name: 'Footer section', preview: 'section', language: 'html', file: 'store-footer.liquid',
    description: 'Added to the footer of every store page. Empty: none.',
    variables: [{ name: 'store.name', description: 'Your store name' }, { name: 'store.logo', description: 'Your logo\'s address (empty when you have none)' }, IMAGES, { name: 'store.telephone', description: 'Your phone' }, { name: 'store.city', description: 'Where you are' }],
  },
];

export const templateDef = (key: string) => TEMPLATES.find((t) => t.key === key);

const here = dirname(fileURLToPath(import.meta.url));
const defaults = new Map<string, string>();
/** The built-in source of a template; emails have a Spanish one too (defaults/es). */
export function defaultSource(def: TemplateDef, lang: 'en' | 'es' = 'en'): string {
  const spanish = lang === 'es' && def.group === 'emails';
  const cacheKey = `${def.key}:${spanish ? 'es' : 'en'}`;
  let s = defaults.get(cacheKey);
  if (s === undefined) {
    // Checked out with Windows line endings or not, the editor and the saved versions use plain newlines.
    s = readFileSync(join(here, 'defaults', ...(spanish ? ['es'] : []), def.file), 'utf8').replace(/\r\n?/g, '\n');
    defaults.set(cacheKey, s);
  }
  return s;
}

/** The built-in subject line of an email, in the language its emails go out in. */
export const defaultSubject = (def: TemplateDef, lang: 'en' | 'es' = 'en'): string | null => (lang === 'es' ? def.subjectEs ?? def.subject : def.subject) ?? null;

/** Problems that stop a template being saved (beyond Liquid syntax). */
export function requirementProblems(def: TemplateDef, source: string): string[] {
  return (def.requires ?? []).filter((r) => !r.pattern.test(source)).map((r) => r.message);
}
