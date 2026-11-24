# Plan: email (SMTP settings, one mail service, a queue, a log)

Who this is for: small businesses in Belize and the people who buy from them.
A business's customers get its invoices, receipts, order confirmations and
reminders by email, so these must look like they come from the business and
must arrive. The platform's own staff set up the server everything goes
through; a business can add its own.

Status marks: `[ ]` to do, `[x]` done, `[-]` skipped (the reason is in DECISIONS.md).

The plan before this one (connecting a site built elsewhere) is finished and
kept in `docs/plans/2026-11-connect-your-site.md`.

## What exists (read end to end, 24 Nov 2026)

- **One small module** (`src/mail/mailer.ts`): `smtpMailer(SMTP_URL, MAIL_FROM)`
  with nodemailer, an outbox of `.eml` files for development, and a memory
  mailer for tests. Everything goes from one address set in the environment;
  the business's address is only the reply-to.
- **No queue.** Every email is sent inside the request that causes it (or the
  housekeeping run). A slow mail server holds up checkout; a dead one loses
  the order confirmation, or fails the request.
- **No settings screens, no log, no test button.** A failure is a line in the
  server log, or a row in `document_messages` for emailed documents.
- **Templates** (`src/templates/`, Liquid): eleven customer-facing emails a
  business can edit, with a live preview, versions and a Spanish default. The
  other emails are built in code with `simpleHtml`, which looks different.
- **Opt-outs** only for checkout reminders (`store_email_optouts`).
- **No sign-up verification email.** A new business's owner signs in at once.

## Every email the platform sends (27, from 25 places in the code)

From a business, to its customers and suppliers (its own server when it has one):

| Type | Where | Template |
|---|---|---|
| `document` | `sendDocumentEmail` in `src/api/documents.ts`: invoices, receipts, credit notes, with PDF and XML | `email.document` |
| `reminder` | the same function, for invoices coming due and overdue | `email.reminder` |
| `statement` | `src/api/receivables.ts` | `email.statement` |
| `quote` | `src/api/quotes.ts` | `email.quote` |
| `purchase-order` | `src/api/purchasing.ts` | `email.purchase-order` |
| `order` | `src/api/storefront.ts` (order confirmation) | `email.order` |
| `order-ready` | `src/api/orders.ts` | `email.order-ready` |
| `back-in-stock` | `src/commerce/stock-alerts.ts` | `email.back-in-stock` |
| `checkout-reminder` | `src/commerce/checkouts.ts` (not transactional: unsubscribe link) | `email.checkout-reminder` |
| `gift-card` | `src/api/giftcards.ts` | `email.gift-card` |
| `sign-in-code` | `src/api/store-accounts.ts` | `email.sign-in-code` |
| `account-link` | `src/api/accounts.ts` (built in code today) | new: `email.account-link` |

From the platform, to a business and its people:

| Type | Where |
|---|---|
| `password-reset` | `src/api/auth.ts` |
| `staff-invitation`, `staff-password` | `src/api/users.ts` |
| `support-password-reset`, `two-factor-off`, `support-notice`, `business-live` | `src/api/platform.ts` |
| `business-closed` | `src/api/business.ts` |
| `service-invoice` | `src/api/billing.ts` (when there is no e-invoice to send) |
| `store-message` | `src/api/storefront.ts` (the store's contact form, to the business) |
| `new-order` | `src/api/storefront.ts` (to the business) |
| `quote-answer` | `src/api/quotes.ts` (accepted or declined, to the business) |
| `notice` | `src/notify/notifications.ts` (rejections, outages, certificates, plan, low stock) |
| `daily-summary` | `src/notify/daily.ts` (not transactional: unsubscribe link) |
| `test` | new: the "Send test email" button |

## A. Foundations

- [x] A1. Migration `057_mail.sql`: `mail_settings` (the platform's row and one
  per business), `mail_messages` (the queue and the log in one table),
  `mail_suppressions`. New tables only. (054 to 056 are taken by branches not
  merged yet.)
- [x] A2. `src/mail/types.ts`: the catalogue of every email type above: who
  sends it, who gets it, transactional or not, whether its text holds a secret.
- [x] A3. `src/mail/address.ts`: one check for recipient addresses; subjects,
  names and headers that cannot carry a line break (header injection).
- [x] A4. `src/mail/settings.ts`: the settings themselves: validation in plain
  words, presets, the password encrypted with the server's key and bound to
  its row, never returned.
- [x] A5. `src/mail/smtp.ts`: the only file that talks SMTP (nodemailer): the
  three encryption modes, time limits, what a server's refusal means (retry,
  give up, the address is dead, the settings are wrong) and a hint for a person.
- [x] A6. `src/mail/service.ts`: the one mail service. `send()` checks, writes
  the message to the queue and returns; delivery happens in the background.

## B. The queue

- [x] B1. Background delivery: claimed rows (safe with several servers), a
  time limit per attempt, a message left "sending" by a crash goes back.
- [x] B2. Retry with backoff on temporary failures (1 min, 5 min, 30 min,
  2 h), failed after 5 attempts (`MAIL_MAX_ATTEMPTS`); permanent refusals fail at once.
- [x] B3. A business's own server first; if it has none, or its server fails
  for a reason that is the server's, the platform's sender with the business's
  name as the from name, and the business told on its settings page.
- [x] B4. Messages that hold a secret (reset links, codes) are scrubbed once
  delivered, are never resent, and are not sent after they stop working.
- [x] B5. Rate limit per business (per hour and per day); mail over the limit waits, it is not lost.
- [x] B6. Housekeeping: the log is kept 90 days (`MAIL_LOG_DAYS`), message
  bodies and attachments 30 (`MAIL_CONTENT_DAYS`).

## C. Every email moved onto the service, one at a time

- [x] C1. `document`, `reminder`, `statement`
- [x] C2. `quote`, `quote-answer`, `purchase-order`
- [x] C3. `order`, `new-order`, `order-ready`, `store-message`
- [x] C4. `back-in-stock`, `checkout-reminder`, `gift-card`, `sign-in-code`
- [x] C5. `account-link` (now a template a business can edit)
- [x] C6. `password-reset`, `staff-invitation`, `staff-password`
- [x] C7. `support-password-reset`, `two-factor-off`, `support-notice`, `business-live`, `business-closed`, `service-invoice`
- [x] C8. `notice`, `daily-summary`
- [x] C9. Nothing but `src/mail/smtp.ts` imports nodemailer; a test keeps it so.

## D. Settings

- [ ] D1. Platform console → Email: host, port, encryption, username,
  password, from name, from address, reply-to; presets; the password shown as
  set with "Replace".
- [ ] D2. Settings → Email for a business (optional), the same fields.
- [ ] D3. "Send test email" on both: a real message, the server's own answer,
  and the likely cause in plain words.
- [x] D4. Presets: Gmail / Google Workspace, Outlook / Microsoft 365, Zoho,
  Amazon SES, with the note where an app password is needed.
- [x] D5. A business's server may not be an address inside the platform's own network.

## E. Templates

- [x] E1. One layout (`src/mail/layout.ts`) for every email built in code:
  the business's logo or name, a heading, text, a button, a footer; phone-friendly; HTML and plain text.
- [x] E2. The eleven Liquid templates keep working as they are; `account-link` joins them.
- [x] E3. Everything put into an email is escaped; tests with hostile values.

## F. Log, safeguards, deliverability

- [ ] F1. The email log: recipient, subject, type, status, error, times. Staff
  see all; a business sees its own. Resend.
- [ ] F2. Suppression list: an address a server says does not exist, and
  people who opt out. Shown and removable on the settings page.
- [ ] F3. An unsubscribe link (and one-click header) on every email that is not transactional.
- [ ] F4. Deliverability guide: SPF, DKIM, DMARC in plain language, and a
  check of the sending domain's DNS.

## G. Proof

- [x] G1. Tests: valid and invalid settings, each encryption mode, wrong
  password, server unreachable, retry then success, retry then failure,
  fallback to the platform, templates with missing and hostile values.
- [ ] G2. A local mail catcher (`npm run mail:catch`); the demo and the
  browser tests send through it by SMTP.
- [ ] G3. Every type triggered end to end and looked at in the catcher.
- [ ] G4. README, `deploy/env.example`, DECISIONS.md, and the steps to go live.
