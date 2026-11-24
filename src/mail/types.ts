/**
 * Every email the platform sends, by type. The mail service reads this to
 * know who an email is from, whether the person may opt out of it, and
 * whether its text holds something that lets a person in.
 *
 *   sender     'business': from the business, through its own mail server when
 *              it has one (else the platform's, under the business's name);
 *              'platform': from the platform itself (sign-in, billing, notices).
 *   category   'transactional': about something the person did or owes;
 *              'optional': anything else. Optional emails always carry a way
 *              to stop them and are not sent to people who used it.
 *   sensitive  the text holds a link or code that signs someone in or is worth
 *              money: it is deleted once delivered and can never be resent.
 *   lifetime   minutes after which sending is pointless (the code expired).
 */

export interface MailTypeDef {
  /** Shown in the email log. */
  label: string;
  sender: 'business' | 'platform';
  category: 'transactional' | 'optional';
  sensitive?: boolean;
  lifetimeMinutes?: number;
}

export const MAIL_TYPES = {
  // From a business, to its customers and suppliers.
  'document': { label: 'Invoice or receipt', sender: 'business', category: 'transactional' },
  'reminder': { label: 'Payment reminder', sender: 'business', category: 'transactional' },
  'statement': { label: 'Statement of account', sender: 'business', category: 'transactional' },
  'quote': { label: 'Quotation', sender: 'business', category: 'transactional' },
  'purchase-order': { label: 'Purchase order', sender: 'business', category: 'transactional' },
  'order': { label: 'Order confirmation', sender: 'business', category: 'transactional' },
  'order-ready': { label: 'Order ready', sender: 'business', category: 'transactional' },
  'back-in-stock': { label: 'Back in stock', sender: 'business', category: 'transactional' },
  'checkout-reminder': { label: 'Checkout reminder', sender: 'business', category: 'optional' },
  'gift-card': { label: 'Gift card', sender: 'business', category: 'transactional', sensitive: true },
  'sign-in-code': { label: 'Sign-in code', sender: 'business', category: 'transactional', sensitive: true, lifetimeMinutes: 10 },
  'account-link': { label: 'Customer account link', sender: 'business', category: 'transactional', sensitive: true },
  // From the platform, to a business and its people.
  'password-reset': { label: 'Password reset', sender: 'platform', category: 'transactional', sensitive: true, lifetimeMinutes: 60 },
  'staff-invitation': { label: 'Invitation', sender: 'platform', category: 'transactional', sensitive: true },
  'staff-password': { label: 'New password link', sender: 'platform', category: 'transactional', sensitive: true },
  'support-password-reset': { label: 'Password reset (from support)', sender: 'platform', category: 'transactional', sensitive: true, lifetimeMinutes: 60 },
  'two-factor-off': { label: 'Two-step sign-in turned off', sender: 'platform', category: 'transactional' },
  'support-notice': { label: 'Notice from support', sender: 'platform', category: 'transactional' },
  'business-live': { label: 'Live with BTS', sender: 'platform', category: 'transactional' },
  'business-closed': { label: 'Business closed', sender: 'platform', category: 'transactional' },
  'service-invoice': { label: 'Plan invoice', sender: 'platform', category: 'transactional' },
  'store-message': { label: 'Message from the store', sender: 'platform', category: 'transactional' },
  'new-order': { label: 'New order', sender: 'platform', category: 'transactional' },
  'quote-answer': { label: 'Quote accepted or declined', sender: 'platform', category: 'transactional' },
  'notice': { label: 'Notice', sender: 'platform', category: 'transactional' },
  'daily-summary': { label: 'Daily summary', sender: 'platform', category: 'optional' },
  'test': { label: 'Test email', sender: 'business', category: 'transactional' },
} as const satisfies Record<string, MailTypeDef>;

export type MailType = keyof typeof MAIL_TYPES;

export const mailTypeDef = (type: string): MailTypeDef | undefined => (MAIL_TYPES as Record<string, MailTypeDef>)[type];
