# Belize E-Invoicing

A multi-tenant service that turns invoices into signed UBL 2.1 Electronic Tax Documents (ETDs), submits them to the Belize Tax Service (BTS / VERTX-BZ) for authorization, and stores the legal record. The invoicing app, POS, public API and accounting connectors (QuickBooks, NetSuite, and others) all sit on top of the core engine.

The reference is the **BTS Orientation Manual for Issuers of Electronic Tax Documents, v1.30 (May 2026)**. Section numbers below refer to it.

## Requirements

- Node.js 22.18 or later. TypeScript runs directly, with no build step.

## Commands

```
npm install
npm start         # API server + background worker + web app (see "HTTP API" for the environment variables)
npm run demo      # local demo: the whole app against a stand-in BTS (see "Web app")
npm run web:dev   # web app with hot reload (proxies the API on :3000)
npm run web:build # build the web app into web/dist
npm run e2e       # browser tests (Playwright; needs the Docker database, see "Web app")
npm run icons     # redraw the app icons in web/public
npm run platform-admin -- add you@example.com "Your Name"   # a platform console account (see "Platform console")
npm run rotate-keys # re-encrypt stored secrets under a new KEY_ENCRYPTION_KEY (see docs/operations.md)
npm run move-photos # move product photos from the database to S3-compatible storage
npm run backup      # pg_dump with checksum and pruning (BACKUP_DIR, BACKUP_S3_URI); npm run restore -- <file>
npm test          # unit and API tests
npm run typecheck # tsc --noEmit
npm run check     # both
npm run example   # print a sample Tax Invoice (or: npm run example -- 04)
npm run example:pdf # render sample printed copies (A4, multi-page, contingency, thermal) into out/
npm run test-certs # regenerate the throwaway test certificates in test/certs
```

`test/certs` holds **throwaway test keys** shaped like a BTS taxpayer certificate (TIN in the subject and in extension 1.2.84.2.1). They are public test data; BTS rejects anything signed with them. Real taxpayer keys never go in the repository.

On Windows, the signing tests also verify each signature with .NET's `SignedXml` through `scripts/verify-signature.ps1`. That is an implementation independent of the one used to sign. On other platforms that test is skipped.

## Core engine (`src/engine`)

| Module | Job | Status |
|---|---|---|
| `decimal.ts` | Exact decimal and cents arithmetic (BigInt, never floating point) | Done |
| `time.ts` | Belize local time (UTC-6, no DST) | Done |
| `etdui.ts` | 44-digit ETDUI, modulus 11 check digit, security code, operating modes | Done; all 13 example IDs in the manual pass |
| `calc.ts` | Line and document totals, GST, ENV/EXC taxes, allowances, document-level GST rounding (4.2) | Done; matches the manual's diesel example |
| `sequence.ts` | Per-series SHA-1 hash chain (4.3.4) | Done; reproduces the manual's 2 worked examples and 4 annex samples |
| `xml.ts` | Deterministic XML writer: escaping, invalid-character rejection, no whitespace between tags | Done |
| `ubl.ts` | UBL 2.1 XML for Tax Invoice, Tax Receipt, Debit Note, Credit Note, incl. subsequent authorization | Done; validates against the official OASIS UBL 2.1 schemas |
| `certificate.ts` | Load taxpayer key and certificate, read TIN/issuer/serial, refuse expired or wrong-TIN certificates (codes 231, 243) | Done |
| `sign.ts` | XAdES-EPES enveloped signature (chapter 8), laid out like BTS's own signature in 7.3.1 | Done; verified independently by .NET `SignedXml` and libxml2 C14N |
| `verify.ts` | Verify a signed ETD before sending (and BTS replies later): XMLDSig core plus XAdES checks | Done |
| `transport.ts` | Mutual-TLS client for the five reception services, Document Query and System Status; one connection pool per taxpayer | Done; tested against a local fake BTS server |
| `response.ts` | Parse BTS replies: ApplicationResponse (001/002/003, rule codes, protocol number), Document Query (004–007), System Status (008/009) | Done; parses the manual's example reply |
| `delivery.ts` | Send one document and settle its fate: pre-send checks, query-before-resend, 255 handling, backoff, 401 stop, "undetermined" handed back for contingency | Done |
| `event.ts` | Cancellation event 050 (UBL ApplicationResponse), enforcing BTS event rules 227, 257, 258, 268, 285–287 | Done; validates against the official ApplicationResponse schema |

Engine modules are pure and stateless. Everything tenant-specific (TIN, environment, series, tax rates, certificate) is passed in, so any number of businesses can be processed in parallel.

## Storage and submit pipeline (`src/db`, `src/pipeline`, `migrations`)

| Module | Job | Status |
|---|---|---|
| `migrations/001_init.sql` | Spec's eight tables, every row tenant-scoped; triggers make issued documents, lines and submissions permanent | Done |
| `migrations/002_events_contingency.sql` | Permanent `events` table, contingency periods, `superseded` status, event attempts in `submissions` | Done |
| `db/database.ts` | Small database interface; adapters for node-postgres and PGlite; migration runner | Done |
| `db/keystore.ts` | Private keys encrypted at rest (AES-256-GCM), bound to the tenant id; pluggable for a cloud KMS | Done |
| `db/tenants.ts` | Onboard a business and its BTS certificate (key must match, TIN must match, valid now); load what issuing needs | Done |
| `pipeline/issue.ts` | `issueDocument`: lock series → number → build → sign → store pending → deliver → record → settle; contingency reissue when BTS can't be reached. `resumePending`, `catchUpContingency`, `reconcileSuperseded`, `cancelDocument` | Done |
| `pipeline/clients.ts` | One pooled BTS client per tenant certificate | Done |

### Contingency mode (manual 3.3.6)

1. **Entering:** a normal-mode delivery that stays undetermined opens a contingency period for the business. In one transaction:
   - The sale is reissued in the contingency series (900 by default), with operMode 2, or 3 for Tax Receipts.
   - The reissue carries `contingencyInfo`; every document in the period shares its reason and start date and time.
   - The original becomes `superseded` and is never sent again.
2. **While the period is open:** new documents go straight to contingency without trying BTS. Their printed copy says "Pending of BTS authorization".
3. **`catchUpContingency`:** sends the queue oldest first.
   - The first success closes the period, because BTS is demonstrably back, and normal mode resumes.
   - It stops at the first delivery that is still undetermined.
4. **`reconcileSuperseded`:** checks each superseded original with Document Query.
   - Not found: nothing to do.
   - Authorized after all: the sale now has two authorized documents, so the original is cancelled with event 050.
5. **`cancelDocument`:** registers event 050 for any authorized document.
   - Refused while in contingency, because events are previous-authorization only.
   - A cancellation that can't reach BTS stays pending; the next call resumes the same event instead of registering a second one.

Run `resumePending` and `catchUpContingency` from a scheduled worker for each business, e.g. every minute while a contingency period is open.

Notes:

- **Locking:** only documents in the same series wait for each other, and only while one takes its number, which is a few milliseconds. Different series and different businesses run in parallel.
- **Store before send:** a crash during sending leaves the document `pending` with its exact signed XML. `resumePending` asks BTS's Document Query first, so nothing is sent or authorized twice.
- **Rejections:** a rejected serial stays used. If no later document has chained to it yet, the series hash pointer moves back so the next document skips it (manual 4.3.4). If a later document already chained to the rejected one, that link stays. BTS validates only each document's own hash (code 271), so this is a gap-analysis question for BTS, not a rejection.
- **Database tests:** they run on PGlite, which is real PostgreSQL in WebAssembly and needs no server. `test/pipeline.postgres.test.ts` repeats the parallel-issuing check on a real server, with 10 connections, when `DATABASE_URL` is set.

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `KEY_ENCRYPTION_KEY` | 32 random bytes, Base64 (`openssl rand -base64 32`). Encrypts taxpayers' private keys. Keep it outside the database, ideally in a secrets manager, and never commit it |

Local database: `docker compose up -d db`, then `DATABASE_URL=postgres://einvoicing:einvoicing@localhost:5432/einvoicing`.

## HTTP API (`src/api`, `src/server.ts`)

`npm start` runs the API and the background worker. It applies database migrations on startup.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `KEY_ENCRYPTION_KEY` | 32 random bytes, Base64; encrypts taxpayers' private keys (required) |
| `ADMIN_TOKEN` | Enables `/v1/admin` onboarding routes; at least 32 characters. Leave unset to disable them |
| `PORT`, `HOST` | Default `3000`, `0.0.0.0` |
| `WORKER_INTERVAL_MS` | Default `60000`; `0` turns the worker off in this process (run it in exactly one instance) |
| `BTS_BASE_URL`, `BTS_TIMEOUT_MS` | Override the BTS host (e.g. a proxy) and the request timeout |
| `BTS_CA_FILE` | Extra CA certificate (PEM) to trust for the BTS host |
| `WEB_ROOT` | Built web app to serve; default `web/dist` when it exists |
| `COOKIE_SECURE` | `false` only for local plain-HTTP development; default `true` |
| `ALLOW_SIGNUP` | `false` to close self-service sign-up |
| `PUBLIC_URL` | Public address of the web app, e.g. `https://app.example.bz`. Links in emails and share links are built from it, never from the request's Host header. Without it, password reset, welcome links and share links are off |
| `SMTP_URL`, `MAIL_FROM` | Outgoing mail (password resets, welcome links, documents), e.g. `smtps://user:pass@smtp.example.com:465` |
| `MAIL_OUTBOX_DIR` | Instead of SMTP, write each email as an `.eml` file here (development and the demo) |
| `PDF_RENDERER` | `chromium` to print documents from the businesses' templates (the Docker image sets it). Unset: the built-in layouts |
| `CHROMIUM_PATH`, `CHROMIUM_CHANNEL` | The browser that prints them: a Chromium or Chrome at a path, or an installed `chrome` / `msedge`. Default: the one `npx playwright install chromium` downloads |
| `KEY_ENCRYPTION_KEYS_PREVIOUS` | While rotating the key: older keys still accepted for reading, comma separated |
| `HOUSEKEEPING_INTERVAL_MS` | Default `300000`: notification emails to businesses, operations alerts, clean-up. `0` turns it off in this process |
| `ALERT_WEBHOOK_URL`, `DEPLOY_ENVIRONMENT` | Operations alerts (worker stopped, documents stuck, contingency queue, expired certificates) posted as JSON `{text}` to Slack/Teams/Discord, labelled with the environment |
| `METRICS_TOKEN` | Enables `GET /metrics` (Prometheus) for a bearer token of 32+ characters |
| `PLATFORM_BILLING_TENANT`, `PLATFORM_PAYMENT_INSTRUCTIONS` | The platform's own business (its address), which issues subscribers' e-invoices; how subscribers pay |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` | The platform's Intuit app, for the QuickBooks Online integration |
| `STORE_DOMAIN_TARGET` | The host businesses point their store domains at (CNAME) |
| `API_RATE_LIMIT_PER_MINUTE`, `WEBHOOK_INTERVAL_MS`, `INTEGRATION_SYNC_INTERVAL_MS`, `CONNECTOR_INTERVAL_MS`, `NETSUITE_POLL_MINUTES` | API key limit (600); how often webhooks (5 s) and QuickBooks Online (60 s) are sent, how often documents picked up from QuickBooks Desktop, Point of Sale and NetSuite are issued (10 s), and how often each NetSuite account is read (5 min), from the worker's process |
| `LEGAL_NAME`, `CONTACT_EMAIL` | Who runs the service, on the pricing, terms and privacy pages |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`, `S3_FORCE_PATH_STYLE` | Product photos in S3-compatible storage (S3, R2, Spaces, MinIO) behind a CDN; without them photos stay in the database |

**Conventions:**
- **Authentication:** `Authorization: Bearer <key>`. Tenant routes take an API key (`etd_<prefix>_<secret>`) or a signed-in person's session cookie; admin routes take the admin token. The business is always taken from the key or the account (which belongs to one business), never from the URL or the body. What a person may do depends on their role (`src/api/permissions.ts`).
- **Money and quantities:** decimal strings (`"24.99"`); JSON numbers are refused.
- **Errors:** always `{ "error": { "code", "message", "details"? } }`. A malformed request is 400. A document BTS would refuse is 422, with the rule and BTS code in the message. A wrong state is 409, a missing record is 404, and a bad or missing key is 401.
- **Issuing:** `POST /v1/documents` answers **201 whenever a document was created**, whatever BTS decided. Check `status`: `authorized`, `authorized_with_alert`, `rejected` (with `conditions`), `contingency_pending` or `pending`.
- **Idempotency:** send an `Idempotency-Key` header, unique per sale. A retry returns the original response (`Idempotent-Replayed: true`) and never issues twice. Reusing a key for a different request is refused (422), and a request that failed validation releases its key.

| Method and path | What it does |
|---|---|
| `GET /health` | `ok` or `degraded` (worker stopped, documents stuck...) while the database answers; 503 when it does not |
| `GET /metrics` | Prometheus metrics, with `Authorization: Bearer <METRICS_TOKEN>` |
| `POST /v1/admin/tenants` | Create a business |
| `POST /v1/admin/tenants/:id/certificate` | Upload its BTS certificate and key (PEM) |
| `POST /v1/admin/tenants/:id/api-keys` | Create an API key; the secret is shown once |
| `DELETE /v1/admin/tenants/:id/api-keys/:keyId` | Revoke a key |
| `GET /v1/me` | The business, its certificate (days left) and contingency state |
| `GET/PUT /v1/business` | The business's details and address (slug). Owners and admins edit; only owners change the address |
| `PUT /v1/certificate` | Renew the business's own certificate |
| `POST/GET /v1/customers`, `GET/PUT/DELETE /v1/customers/:id` | Saved customers; list supports `q` (name, TIN, phone, email), `limit`, `cursor`. `PUT` replaces every field; `DELETE` archives |
| `POST/GET /v1/items`, `GET/PUT/DELETE /v1/items/:id` | Catalog items, with optional `barcode` and `favorite`. List supports `q`, `favorite=true`, and `code` (exact barcode or your own code). `DELETE` archives and frees the barcode |
| `POST /v1/documents` | Issue a document (see the body below) |
| `GET /v1/documents` | List; filters `status`, `type`, `from`/`to` (issue date), `customerId`, and `q` (number like `12` or `001-000000012`, ETDUI, or customer name or TIN); cursor pagination |
| `GET /v1/documents/:id` | Status, totals, lines, conditions, protocol number, contingency links |
| `GET /v1/documents/:id/xml` | The signed XML exactly as sent to BTS |
| `GET /v1/documents/:id/view` | The document as signed (read from its XML) plus its QR code, for the on-screen paper copy |
| `GET /v1/documents/:id/pdf` | Printed copy. Query options: `format=sheet\|receipt`, `paper=A4\|LETTER`, `orientation`, `widthMm`, `draft=true` |
| `POST /v1/documents/:id/cancel` | Cancel an authorized document (event 050). Returns 200 when registered or rejected, 202 when BTS couldn't be reached |
| `POST /v1/documents/:id/email` | Email the printed copy (PDF) and the signed XML to one address, replies going to the business. Recorded; at most 200 emails per business per hour |
| `GET /v1/documents/:id/messages` | Emails sent for a document |
| `POST /v1/documents/:id/share` | A link (`/d/<token>`) that opens the PDF without logging in, valid 90 days. It stops working if the document is cancelled. For WhatsApp, SMS or anywhere else |
| `GET /v1/reports/summary` | `from`, `to`: totals, GST by rate, by type and by day. Credit notes subtract; only documents with legal value count |
| `GET /v1/reports/customers`, `/v1/reports/items` | Sales by customer and by item |
| `GET /v1/reports/documents` | The document register as CSV, every status included |
| `GET /v1/reports/accountant-pack` | `from`, `to` (at most a year): one ZIP for the accountant (see "For your accountant"); recorded in the activity log |
| `GET/POST /v1/connectors`, `PUT/DELETE /v1/connectors/:id` | QuickBooks Desktop, Point of Sale and NetSuite connections (Pro): what each picked up and the tax codes it saw; a new QuickBooks connection returns its Web Connector password once, a NetSuite one its certificate; NetSuite details (`netsuite: { accountId, clientId, certificateId, numberField, statusField }`) are tested when saved |
| `GET /v1/connectors/:id/qwc`, `POST /v1/connectors/:id/password` | The `.qwc` file to open in the Web Connector; a new password (the old one stops working) |
| `GET /v1/connectors/:id/certificate`, `POST /v1/connectors/:id/sync` | The certificate to upload to NetSuite; read NetSuite now |
| `GET /v1/connectors/imports`, `POST /v1/connectors/imports/:id/retry`, `.../skip` | What was picked up (`status=attention\|issued\|rejected\|skipped\|waiting`), sending one again (`force` accepts a tax difference) or leaving it out |
| `POST /v1/qbwc` | The QuickBooks Web Connector's SOAP service (signs in with the connection's password) |
| `GET /v1/reports/archive` | `from`, `to`, `pdf=true`: one ZIP with every document's signed XML, BTS's replies, cancellation events, the register and (optionally) the PDFs. Streamed; up to 20,000 documents per download; recorded in the activity log |

Every report also answers `?format=csv` (UTF-8 with BOM for Excel; cells that a spreadsheet would run as formulas are neutralised).

Issuing body:

```json
{
  "type": "01",
  "series": 1,
  "customerId": "…",
  "lines": [
    { "itemId": "…", "quantity": "2" },
    { "description": "Gift wrap", "quantity": "1", "unitCode": "H87", "unitPrice": "5.00", "gstCategory": "S" }
  ],
  "payment": { "meansCode": "30", "dueDate": "2026-12-31", "terms": "Net 30" }
}
```

- **Customer:** use `customerId` for a saved customer, or `customer` to give one inline.
- **Lines:** a line references a catalog item with `itemId`, or gives its fields in full. Item fields can be overridden per line.
- **Credit and debit notes:** add `"reference": { "documentId": "…", "reason": "…" }`. A credit note cannot exceed what is left to credit on the original (its total, plus debit notes, minus credit notes already issued or on their way): 422 `credit_exceeds_original`. `GET /v1/documents/:id` returns `credit: { credited, debited, remaining }` for invoices and receipts, and the web app's credit-note form starts with the original's lines.

`POST /v1/certificate/pfx` installs a `.pfx` certificate (owners and admins). `POST /v1/documents/preview` returns totals without issuing anything.

**People and sign-in (web app, session cookie only; API keys never manage people):**

| Method and path | What it does |
|---|---|
| `POST /v1/auth/signup` | Create a business (test environment) and its first owner |
| `POST /v1/auth/login` | `{ business: slug, login: email or username, password, remember? }`. With two-step sign-in on, answers `{ twoFactorRequired, challenge }` instead of a session. `remember: false` ("Keep me signed in" unticked) gives a cookie that ends when the browser closes |
| `POST /v1/auth/login/verify` | `{ challenge, code, remember? }`: the 6-digit code from the authenticator app, or a recovery code. The challenge lasts 5 minutes and allows 5 tries; a code works once |
| `GET /v1/auth/two-factor`, `POST .../setup`, `.../confirm`, `.../disable`, `.../recovery-codes` | Two-step sign-in for the signed-in person (TOTP, RFC 6238): setup needs the password and returns the secret and a QR code; confirming with a code returns ten single-use recovery codes |
| `PUT /v1/business/security` | Owners: `{ requireTwoFactor }` for owners and admins (who must then set it up before anything else) |
| `GET /v1/auth/session` | The account, its business and its permissions |
| `POST /v1/auth/password/forgot` | `{ business, email }`; always 204, so it cannot reveal who has an account |
| `GET /v1/auth/password/link/:token`, `POST /v1/auth/password/reset` | Who a reset or welcome link is for; set the password and sign in |
| `POST /v1/auth/password/change`, `POST /v1/auth/logout` | |
| `GET /v1/auth/business/:slug`, `GET /v1/auth/slug` | A business's public name (for its login page); is an address free |
| `GET/POST /v1/users`, `PATCH /v1/users/:id` | The business's accounts: create with a temporary password or an emailed welcome link; name, email, username, role |
| `POST /v1/users/:id/disable`, `/enable`, `/password`, `/sign-out` | Deactivate (signs them out), reactivate, set a temporary password or send a link, end all sessions |
| `POST /v1/users/:id/two-factor/reset` | A lost phone: turns their two-step sign-in off and ends their sessions |
| `GET/POST/DELETE /v1/api-keys` | The business's API keys |
| `GET /v1/audit` | The activity log, newest first, 50 a page (`before` for the next): filtered by `kind` (`security`, `people`, `sales`, `store`, `stock`, `settings`), `userId`, `from` and `to` (days in Belize) |

Each business has its own session cookie (`etd_s_<slug>`), so one browser can be signed in to several. Requests name the business with the `X-Business` header, or `?b=<slug>` on plain links such as PDF downloads.

Sign-in, sign-up, password-link, order and email limits are kept in the database (`rate_limits`), so they hold across any number of server processes.

**Not built yet:** rate limiting per API key, and OpenAPI docs.

## Web app (`web/`)

A React + TypeScript app (Vite) served by the API server from `web/dist`. It's built for business owners and staff, not developers.

- **Each business is its own instance:**
  - Its own address: `app.example.bz/<slug>` (suggested from the name when the business is created; owners can change it). The start page (`/`) finds a business by its address and remembers the ones used on the device.
  - Its own accounts. A person working for two businesses has two separate logins, and can be signed in to both in one browser.
  - Its own records, settings, certificate, API keys and activity log.
- **Accounts, managed by the business:**
  - Owners and admins create accounts directly: with an email, a username (for staff without email, e.g. `till1`), or both.
  - The new person gets either a temporary password, which they must replace at first sign-in, or an emailed welcome link (7 days). The link is also shown to share by WhatsApp.
  - Owners and admins edit names, sign-ins and roles, reset passwords (temporary or by link), sign people out everywhere, and deactivate or reactivate accounts. Deactivating signs them out at once. Accounts are never deleted, so the record of who issued or cancelled what stays complete.
  - People sign in with their email or username. Forgotten passwords are reset by an emailed one-time link (one hour). Changing or resetting a password signs out every other session.
- **Roles** (fixed, the same in every business):

  | Role | May |
  |---|---|
  | Owner | everything, including managing owners and admins |
  | Admin | everything except managing owners and admins |
  | Manager | issue all documents including credit and debit notes, cancel, send, manage customers and items, reports |
  | Cashier | issue and send invoices and receipts; add a customer while selling |
  | Accountant | read documents and reports; download records |

  The server enforces them; the screens only show what a role may use. Nobody changes their own role or deactivates themselves, and a business always keeps an active owner.
- **Activity log:** sign-ins (and failed ones), account changes with before and after, business details, the certificate, API keys and cancellations, with who, when and from where. It cannot be edited or deleted. Each document also records who issued it.
- **Security:**
  - Passwords are hashed with scrypt; only a hash of each session token and each password link is stored.
  - Sessions live in httpOnly, SameSite=Lax cookies, one per business. Every change sent with a cookie also needs `X-Requested-With: etd-web`, which blocks CSRF.
  - Failed sign-ins are rate-limited per account and per IP (successful ones never count), and unknown accounts take as long as wrong passwords.
- **Creating a business:**
  1. The business, its address, and the owner account, in one form. Self-service businesses start in the BTS **test** environment; moving to production is an admin step.
  2. The BTS certificate, uploaded as a `.pfx`/`.p12` file with its password and converted to PEM on the server with node-forge.
- **Screens:**
  - **Navigation:** a sidebar grouped into Sell, Records and Business, with icons, a badge for online orders to handle, the business and its BTS environment at the top, and the signed-in person, language, business switch and log-out at the bottom. On phones it becomes a drawer behind a menu button.
  - **Overview:** a greeting with quick actions; today's sales (credit notes subtracted, with the last 7 days), documents issued today, online orders to handle and documents needing attention; sales for the last 14 days (for roles that see reports); a to-do list (unpaid and undelivered orders, rejected or waiting documents, certificate problems); recent documents. It refreshes while documents are still waiting for BTS.
  - **Counter** (tax receipts at speed):
    - scan a barcode or type a code and press Enter; `3*code` adds three
    - star items in the catalog to make them quick buttons
    - `+` / `−` change the last line, `Del` removes it, `F2` or `Ctrl+Enter` issues
    - cash received and change, card or transfer, optional customer TIN
    - "repeat last sale", free-text items
    - optional automatic printing on an 80 mm receipt printer (the browser remembers the printer)
    - discounts on a line (a percentage or an amount) or on the whole sale, shown on the receipt
    - hold a sale (with a name: "Table 4") to serve the next customer, and recall it later; held sales stay on the device
    - a saved customer on the receipt, or the sale charged to their account as a tax invoice due in 7, 15 or 30 days
    - payment split between cash and a card or transfer: the parts must add up to the total before anything is signed, the receipt lists them, and the shift counts each in its place
    - the sale in progress survives a closed tab
  - **New invoice or receipt:**
    - pick a saved customer or add one, or sell to a walk-in on receipts
    - keyboard-friendly search for items (arrow keys, Enter), barcode scanners work too
    - live totals from the engine (`POST /v1/documents/preview`)
    - drafts saved on the device and restored after a reload or crash; `Ctrl+Enter` issues
    - one idempotency key per form (kept in the draft), so a retry never issues twice
  - **Document detail:** plain-language status that updates by itself while BTS answers, BTS rule codes on rejection, the lines, printing (A4 or receipt) without leaving the page, XML download, "issue again", credit and debit notes, cancellation.
  - **Sending:** email with the PDF and XML attached, WhatsApp (to the customer's phone when saved), copy link, or the phone's share sheet; a log of what was sent.
  - **Documents:** search by number, customer name or TIN; filters for dates, type, status and customer, kept in the address bar; CSV download.
  - **A page per item** (the item's name in the list): sold in 30 days and a year, sales by month, margin over the year, stock and about how many days it lasts at the current pace, its suppliers with their last cost, and the bundles it is part of (`GET /v1/items/:id/summary`).
  - **Customers and items:** add, edit, archive; customers link to their documents. Editing an item that has a cost (from stock received) shows the margin at the price typed, and warns when it is below cost.
  - **Quantity prices:** an item can cost less each from a quantity on ("12 or more: BZ$2.50 each", up to 10 steps, in the item's form). The counter and the invoice form re-price a line as its quantity changes (on the invoice form, until the price is changed by hand), a document line that names the item without a price gets the price for its quantity (`priceBreaks` on items), and labels show the first one ("6+ BZ$3.94 each"). Wholesale customers keep the wholesale price.
  - **Customer account page** (a customer's page → Account link): a private link (a year, revocable; `/a/<token>`) where the customer sees what they owe and what is past due, pays each invoice online (or sees how to pay), and downloads their invoices, receipts and notes of the last year and their statement. Copy it, or email it to them in the business's email language (`POST /v1/customers/:id/account-link`, `.../send`, `DELETE .../account-links`).
  - **Loyalty points** (`src/api/loyalty.ts`; Settings → Business → Loyalty points): saved customers earn points on receipts and invoices (so many per BZ$1 paid, GST included) and use them at the counter ("Use points", or `redeemPoints` on `POST /v1/documents` and its preview). Points used are a reward spread over the sale's lines as discounts ("Loyalty reward"), sized so the total falls by the reward's value; GST is charged on what is paid, and a cashier's discount limit does not count them. A fewest-points-at-once setting applies. Credit notes take back the points their amount earned; a document rejected or cancelled gives back the points it used and takes back those it earned (once). The customer's page shows the balance and its history, and managers can give or take points with a note.
  - **Credit limits:** a customer can have a credit limit (Customers → edit; only owners, admins and managers set it). An invoice on account (not paid on the spot) that would take what they owe over it is refused with what they owe and what is left; an owner, admin or manager can allow it once ("Allow it this time" at the counter and on the invoice form, `overrideCreditLimit` in the API). Receipts, paid invoices and recurring invoices are not held back. The customer's page shows the credit left.
  - **Wholesale prices:** an item can have a wholesale price (before GST) and a customer can be on the wholesale price list; the counter (which re-prices the cart when such a customer is picked), the invoice form and the API (a line naming an item without a price) then use the wholesale price. Documents keep the price they were issued at.
  - **Categories:** an item can have a category (Coffee, Bakery, Hardware…). The counter shows them as tabs over the quick buttons, the item list filters by them, Reports shows sales by category (each document line remembers the item it was sold from), and **Change prices** moves every price in a category (or every item) by a percentage or an amount, or to one price, rounded up to the cent, 5 cents, 25 cents or a dollar, with a preview first (`POST /v1/items/reprice`, `dryRun`). A category typed in another case joins the spelling already in use.
  - **Import from a spreadsheet** (Items and Customers → Import): a CSV from Excel, Google Sheets or another system, with flexible column names (Name, Code/SKU, Barcode, Category, Price or Price with GST, GST S/Z/E, Unit, Stock, Low stock, Quick button; for customers Name, TIN, Email, Phone, Street, City, District). A dry run shows what each row will do; the import adds or updates the good rows (items matched by code then barcode, customers by TIN then email; stock goes through the stock ledger) and lists the rest with the reason.
  - **Price list** (Products → All items → Price list): a PDF of the items by category with their prices, retail or wholesale, with or without GST, and quantity prices; one category or all (`GET /v1/items/price-list.pdf`).
  - **Labels** (Products → All items → Print labels): price tags with the price including GST and a barcode (EAN-13 when the item's barcode is one, Code 128 otherwise, or the item's own code), on A4 sheets of 24 (70 × 37 mm) or one per label on a 50 × 30 mm label printer.
  - **Reports:** this month, last month, quarter, year or custom; sales and GST collected, sales per day, GST by rate for the GST return, top customers and items, sales by category; under Profit and loss, the **gross margin** by category or item (sales before GST against each item's average cost when it was sold, kept on the document line); CSV for each.
  - **Settings:** my account (language, password, sign out everywhere); business (details, address, certificate); online store; users; activity; API keys.
  - **Templates:** the code behind every email, printed document and store section, in Liquid, with a live preview, and the business's images and logo (see "Templates" below).
  - **Products and Orders:** see "Online store" below.
- **Daily summary** (opt-in, Settings → Business): each morning owners and admins get yesterday at a glance: sales and GST against the same day last week, how customers paid (split payments counted by part), best sellers, discounts given, cash drawer differences, what customers owe, what is running low and anything BTS rejected (`src/notify/daily.ts`). Quiet days send nothing.
- **Counter controls** (Settings → Tills): the most a cashier may take off a line, checked by the server on the engine's own amounts; managers and above are not limited. Shift reports show the discounts given.
- **Live status:** a bar at the top of the page appears while BTS is unreachable (with the queue count), when it comes back, and when the device is offline.
- **Spanish:** every screen is in English and Spanish (`web/src/es.ts`). The choice is per device, defaulting to the browser's language. Customer emails go out in English or Spanish, as each business chooses under Templates (built-in text, subjects, dates and the lines the app writes); printed documents keep BTS's English names.
- **Installable:** a web app manifest, icons and a service worker that caches the app shell (never API data), so it installs on phones and desktops and opens fast.
- **Accessibility:** a skip link; focus moves to each new page; dialogs trap focus and give it back; a keyboard-operable combobox; every control labelled; muted text at 5:1 contrast.
- **Sign-in screens:** a white card (floating labels, show or hide the password, keep me signed in, a clear busy, success and error state) beside a living panel: slowly drifting aurora light, a real-time fluid on the GPU (WebGL; velocity, pressure and dye, stirred by the pointer or a finger, a splash on a click) and a faint particle network that moves aside for the pointer (`web/src/scene/`). It scales down on phones and small machines, falls back to the still gradient without WebGL, stands still with reduced motion, and pauses while the tab is hidden.
- **Long lists page:** documents, customers, items, the activity log and the console's staff log show one page at a time (newer and older, the page number), so they stay quick however long they get; changing a filter or search starts again at the first page.
- **Robustness:** each page loads on demand and crashes stay inside one page (with a reload button); an expired session returns to the login page; network errors say so plainly.
- **Design:** "ledger and drafting table".
  - Warm grid paper, cream sheets with hairline edges, aubergine ink.
  - Purple brand, lime for authorized, coral for problems.
  - Inter Tight and Geist Mono (OFL), self-hosted.
  - Original SVG crystals on the sign-in, onboarding and overview screens.
- **Motion:**
  - native view transitions between pages, with the sidebar held in place
  - staggered page entrances and pill buttons with sliding arrow chips
  - animated banners, modals and suggestions
  - drifting crystals
  - all disabled under `prefers-reduced-motion`
- **Security headers:** a strict Content-Security-Policy (`'self'` only, no third-party fonts or scripts), `nosniff`, and `SAMEORIGIN` framing.

### Local demo

```
docker compose up -d db
npm run web:build
npm run demo            # http://localhost:3000
```

- **Business and certificate:** on the start page choose "Create a business", use TIN **123456**, and upload `test/certs/signer-123456.pfx`, password `test-pfx-password`. This is a throwaway test certificate. Then add users under Settings → Users.
- **BTS stand-in:** it authorizes every document.
- **Outage simulation:** create the file `.demo/bts-down` and new documents go into contingency. Delete it, and the worker sends them within about 15 seconds.
- **Emails** (password resets, welcome links, documents, order confirmations) are written to `.demo/outbox` as `.eml` files; open them with any mail program.
- **Platform console:** `http://localhost:3000/admin`; the demo creates a staff account on first start and saves its sign-in in `.demo/platform-admin.txt`.
- **Online store:** add a product under Products, then Settings → Online store → Open the store, and shop at `http://localhost:3000/<your-address>/shop`. Mark the order paid under Orders to issue its receipt.

### Browser tests

```
docker compose up -d db
npm run e2e
```

Builds the web app, starts the demo on port 3100 with a fresh `einvoicing_e2e` database, and drives a real browser through sign-up, onboarding, the catalog, a counter sale, an invoice with a restored draft, emailing, search, reports, adding users (welcome link and temporary password, first sign-in, deactivation, the activity log), password reset, Spanish, accessibility checks, installability, the online store (a product with sizes and a photo, opening the store, a buyer's order, paid becoming a BTS receipt), the platform console moving the business to production, and the phone layout, storefront included. On Windows it uses the installed Microsoft Edge; elsewhere run `npx playwright install chromium` first (or set `PW_CHANNEL`).

## Online store (`src/commerce`)

Every business can open an online store at `app.example.bz/<slug>/shop`. Its defining feature: **a paid order becomes a BTS-authorized document**, a tax receipt, or a tax invoice when the buyer gives a TIN.

- **Products** group items: each **variant** (size, colour) is an item with its own price (before GST), GST category, your code, barcode and optional stock count. Variants also sell at the counter and on invoices. Products have a description, up to 10 photos (JPEG, PNG or WebP; the type is checked from the file's bytes, not its name), a status (draft or on sale), and their own address (`/shop/products/<handle>`).
- **Storefront:** product grid, search, browsing by category (the items' categories, as chips when a store uses more than one; `?category=` on the products list), product pages with option pickers and stock hints ("Only 3 left"), a cart kept on the buyer's device, and checkout. Prices are shown with GST included. Every total comes from the same engine calculation that produces the e-invoice, so the quote, the order and the receipt agree to the cent.
- **Sharing and search:** store pages carry their own title, description, price and picture in the page itself (Open Graph and Twitter tags, canonical link), so a product or store link shared on WhatsApp, Facebook or Instagram shows a proper preview; browser tabs name the store. Each store has a sitemap (`/<slug>/shop/sitemap.xml`, or `/sitemap.xml` on its own domain, which also serves a `robots.txt` pointing to it).
- **Checkout:**
  - delivery to the zones the business sets (each with a fee before GST, which becomes a standard-rated line on the receipt) or pickup
  - payment online (card or PayPal, through the business's own PayPal account; a test gateway in the BTS test environment), by bank transfer (the bank details are shown after ordering, with the order number as reference), cash on delivery, or at pickup. A confirmed online payment marks the order paid and issues and emails the receipt by itself; a declined one can be retried from the order page; a reconciliation run settles payments buyers never came back from. PayPal charges US dollars at the fixed BZ$2 = US$1; the receipt stays in BZ$
  - discount codes (percent, BZ$ off with GST, free delivery; dates, minimum order, use limits), shown on the receipt as an allowance on each line before GST; refunds take each unit's exact share
  - an optional TIN and business name, for a tax invoice
  - stock is reserved in the same database transaction that creates the order, so the last item cannot be sold twice
- **Orders:** numbered per business (#1001 and up). The buyer gets an emailed confirmation and a private order page (an unguessable link) that shows progress and, once paid, the receipt PDF. The business is emailed about each new order.
- **Back in stock:** on a sold-out variant, a buyer can leave their email ("Email me when it is back"; limited per address). When it is in stock again and still for sale, housekeeping emails them once (the "Back in stock" template) with a link to the product. Inventory shows how many buyers are waiting on each item, so the business knows what to restock first.
- **Ready for pickup / out for delivery:** staff mark an order ready from its page; the buyer gets an email (the "Order ready" template, in the business's email language, with the pickup address and instructions or the delivery area) and their order page shows the step (`POST /v1/orders/:id/ready`, `notify: false` to mark it quietly).
- **Staff** see a to-do list (unpaid, to deliver), mark an order **paid** (this issues the BTS document and emails it to the buyer; doing it twice never issues twice, and a rejected document can be issued again), mark it delivered or picked up, or cancel an unpaid order (its stock goes back). A paid order is **refunded** in full or in part (chosen lines and quantities, the delivery fee, optionally back into stock): each refund is a credit note against its receipt, sent to BTS and emailed to the buyer, and never more than was paid (`POST /v1/orders/:id/refund`).
- **Roles:** managers and cashiers handle orders; managers and above manage products; owners and admins configure the store. API keys can sync products and handle orders.

| Method and path | What it does |
|---|---|
| `GET/POST /v1/products`, `GET/PUT/DELETE /v1/products/:id` | Products with their variants (missing variants are archived on `PUT`); `DELETE` archives |
| `POST /v1/products/:id/images`, `POST .../images/:imageId/cover`, `DELETE .../images/:imageId` | Photos (Base64 in JSON, up to 5 MB) |
| `GET/PUT /v1/store-settings` | Open or close the store, delivery zones, pickup, payment methods, notifications |
| `GET /v1/orders`, `GET /v1/orders/:id` | Orders; `view=to_do` (default), `unpaid`, `unfulfilled`, `done`, `cancelled`, `all`; `q` for number, name, phone |
| `POST /v1/orders/:id/paid`, `/fulfilled`, `/cancel` | Payment received (issues the document), delivered or picked up, cancel an unpaid order |
| `GET /v1/store/:slug`, `/products`, `/products/:handle`, `/images/:id` | The public storefront (no sign-in; only while the store is open and for products on sale) |
| `POST /v1/store/:slug/quote`, `POST /v1/store/:slug/orders` | Price a cart; place an order (rate-limited per IP) |
| `GET /v1/store/:slug/orders/:number?t=`, `.../document?t=` | The buyer's order page and receipt PDF (the token from the order link) |
| `POST /v1/store/:slug/orders/:number/pay?t=`, `.../payments/:id/confirm?t=` | Start or retry an online payment; back from the provider, confirm it |
| `GET/POST /v1/discounts`, `PATCH /v1/discounts/:id` | Discount codes |
| `GET /v1/payment-accounts`, `PUT/DELETE /v1/payment-accounts/paypal` | Connect PayPal (credentials checked with PayPal, stored encrypted) |
| `GET/POST /v1/store-domains`, `POST .../:domain/verify`, `DELETE .../:domain` | The store on the business's own domain (CNAME to `STORE_DOMAIN_TARGET` plus a TXT record to verify); `GET /v1/domains/check?domain=` answers an on-demand TLS proxy |

**Next:** a Belizean card gateway alongside PayPal. **Later:** theme editor, search-engine friendly pages, social catalogs, abandoned-cart reminders, customer accounts, one stock count for the counter and the store.

## Getting paid (`src/receivables`, `src/api/receivables.ts`)

Accounts receivable on top of the BTS documents, without touching them:

- **Balances.** An invoice's balance is its amount payable less payments received (`invoice_payments`: never deleted, a mistake is voided with a reason) less credit notes issued against it; below zero is a credit. Only documents with legal value count, in the business's current BTS environment. Tax receipts and online-store orders are paid at the time, so they are never owed. Due dates come from the invoice's payment terms (`documents.due_date`; older invoices are backfilled from the signed XML by housekeeping).
- **Recording payments**: from the invoice page (cash, transfer, cheque, card, other), or `paid` when issuing (`POST /v1/documents` with `paid: { method }`). Permission `payments.record`: owners, admins, managers, cashiers, accountants, API keys. Events `payment.recorded` and `invoice.paid` (when the balance reaches zero) go to webhooks.
- **Getting paid** page: outstanding, overdue, due this week, collected this month; the ageing by customer (current, 1-30, 31-60, 61-90, 90+, also as CSV); open invoices; each customer's statement (on screen, PDF, emailed with a pay link per invoice).
- **Reminders** (housekeeping, opt-in): for each open invoice with a customer email, the latest step reached (days from the due date, e.g. -3, 3, 14, 30) is sent once, with the PDF and a pay link. A step on or before the day of issue is skipped; turning reminders on late sends one reminder per invoice, not a backlog. A reminder can also be sent by hand.
- **Monthly statements** (opt-in, Getting paid → Reminders and paying): in the first week of each month, every customer who owes and has an email gets their statement (the PDF, a pay link per invoice and their account page), once that month.
- **Belize Bank** (`src/commerce/belizebank.ts`, `src/commerce/ekyash.ts`, `src/receivables/billpay.ts`): card payments on the bank's hosted page in BZ$ (no card data reaches us), E-Kyash wallet payments (a QR code on the page, or a deep link on a phone; requests are HS256-signed, callbacks HMAC-checked), and bill payments from Belize Bank online banking: the bank validates the invoice number with us (balance, customer name), posts each payment (recorded once by the bank's reference) and sends a daily reconciliation; anything that matches no single open invoice is listed for the business to apply by hand. Callbacks from providers are never trusted on their own: they only make us ask the provider.
- **Paying online from the link** (`/pay/<token>`, the same 90-day token as the PDF share link): the balance, the PDF, and a choice of the business's connected providers (Belize Bank cards, E-Kyash, PayPal; test payments in the BTS test environment). The payment is recorded on the invoice once (`invoice_payments.online_payment_id` is unique), whether the customer comes back or reconciliation finds it.

## Templates (`src/templates`, `src/api/templates.ts`)

Businesses edit what their customers see the way a Shopify theme is edited: in **Liquid** (`liquidjs`), HTML with `{{ values }}`, `{% if %}`, `{% for %}` and filters.

- **What can be edited:** five emails (documents, payment reminders, statements, quotations, store order confirmations, each with its subject line), four printed documents (invoices and notes on A4, receipts on an 80 mm roll, quotations, statements) and the online store (theme CSS, an announcement bar, a home page section, a footer section). Each has a built-in default (`src/templates/defaults/*.liquid`); a business that never edits anything gets those.
- **The editor** (Business → Templates): the code (CodeMirror, with completion for each template's own variables and Liquid's tags and filters) beside a live preview rendered by the server with sample data and the business's own details: an email as a mail app shows it (desktop or phone), an A4 sheet, a receipt roll at actual size, or the real store in a frame taking the draft as you type. Mistakes show on their line, and the preview keeps the last good version until they are fixed. Saving checks the same way; the last 30 saves are kept and any can be opened again; "Use the default" goes back (and stays in the history). `Ctrl+S` saves; leaving with unsaved changes asks first.
- **Language:** customer emails go out in English or Spanish (Templates → Emails). Each email has a built-in Spanish version (`src/templates/defaults/es`), and dates are written in that language (`{{ date | date: '%-d de %B de %Y' }}` gives 22 de noviembre de 2026). An email a business customized keeps its own wording.
- **Filters** on top of Liquid's own: `money` (BZ$1,234.50), `amount` (1,234.50), `pluralize`, `asset_url` (an uploaded image: `{{ 'banner.png' | asset_url }}`).
- **Printed documents keep BTS's rules:** their data comes only from the signed XML (plus the business's message), and `{% bts %}` (`{% bts 'stacked' %}` on narrow layouts) prints what BTS requires on every copy: the 22 mm QR code with its quiet zone, the ETDUI, the authorization and the legal notices, with styles a template cannot shrink. A template without it cannot be saved.
- **Images and the logo** (Templates → Images): PNG, JPEG, GIF, WebP or SVG up to 2 MB (40 per business; the type is checked from the bytes), each with a name to use in templates. One is the business's **logo** (`{{ business.logo }}`, `{{ store.logo }}`): the default templates print it at the top of receipts, invoices, quotes, statements and emails, the built-in pdfkit layouts print it too (PNG or JPEG), and the till apps print it on receipt printers (dithered to dots on ESC/POS, as a picture on system printers). Images are public by an unguessable address (`/v1/assets/<id>/<name>`), served with a policy under which nothing in them can run; in PDFs they are inlined, since the print browser has no network. An image a saved template uses cannot be deleted.
- **Printing:** with `PDF_RENDERER=chromium`, documents print from their template in a headless Chromium with JavaScript off and the network closed (only `data:` addresses load), one context per print and a time limit. Without it, or if a print fails, the built-in layouts are used, so a document always has its PDF.
- **Safety:** templates cannot read files (`include` and `render` find nothing) or reach prototypes, output is HTML-escaped unless a template says `| raw`, and render time, size and memory are limited. A business's template that breaks at send time falls back to the default, so an email or receipt is never lost to a typo. Store sections are sanitized (no scripts, no event handlers, only safe links) and store CSS loses `@import` and anything that could close its style element, since the store shares the app's address.

## Quotes and recurring invoices (`src/api/quotes.ts`, `src/api/recurring.ts`)

Neither is a tax document: each keeps the `POST /v1/documents` body it will issue (with every catalog price written out, so a later price change does not alter an offer), and issues through the same pipeline (`issueFromBody`: plan limit, credit limit, signing, BTS).

- **Quotes** (`Q-1001`, numbered per business): drafted with the same form as an invoice, emailed with a PDF (`src/render/quote.ts`) and a link (`/q/<token>`, 120 days, stored hashed) where the customer accepts (with their name) or declines (with a reason); the business is emailed either way. Accepted, or marked accepted after a phone call, a quote becomes a tax invoice (due N days later) or receipt in one click, once, and can be emailed with a pay link. Expired quotes (past their valid-until date) cannot be accepted.
- **Recurring invoices**: weekly, monthly or yearly, every 1 to 12 periods, from a start date, forever, for N invoices or until a date. Months keep their day (the 31st falls back to the month's last day). Housekeeping issues what is due: each date is claimed in `recurring_runs` first, so it is issued once whichever process gets there; a failure (BTS rejected it, plan limit, no certificate) is kept on the schedule and retried an hour later. Each invoice is emailed with a pay link (also those BTS answered later). Pausing and resuming skips the dates missed; "Issue it now" issues the next one early.

## Expenses, the GST return and profit and loss (`src/api/expenses.ts`, `src/api/accounting.ts`)

- **Expenses and bills**: what the business pays, with the supplier (saved, or typed as on the receipt), their invoice number, a category, and the total as paid. For standard-rated purchases the GST inside is worked out at 12.5% unless the receipt shows another figure. A bill can be left to pay later (due date, "Bills to pay", mark paid). A photo or PDF of the receipt (up to 5 MB, checked by its first bytes) is kept in the database or object storage and always served through the app, never from a public address. Permission `expenses.manage`: owners, admins, managers, accountants, API keys.
- **GST return worksheet** (Reports → GST return, also CSV and PDF): sales from the authorized e-invoices of the period by GST rate (credit notes subtract), purchases from the recorded expenses by GST treatment; GST paid is claimable only with a tax invoice from a GST-registered supplier (its TIN). It shows output tax, input tax and what to pay or carry forward, with warnings (documents still waiting for BTS, GST without a supplier TIN, claimed GST without a receipt). A working paper for the return filed with BTS, not the return itself.
- **Contract tax** (withheld by the customer): government ministries, statutory bodies and larger companies deduct 6% of a contractor's invoice (before GST) and pay it to BTS. Mark such a customer ("Withholds contract tax") and their tax invoices are ticked by default (also from quotes, recurring invoices and time and jobs); `contractTax: true` on `POST /v1/documents`. The e-invoice keeps its full total and says in its note what is withheld and what is to pay; the withheld amount is stored with the invoice (rate and base at the time) and counts towards its balance, so Getting paid, statements, reminders and pay links ask for the rest, and paying it settles the invoice. The accountant pack lists what was withheld (`contract-tax-withheld.csv`), a credit against business tax.
- **Businesses that sell services** (consultants, repairs, salons, clinics, bookkeepers): each business says what it sells, products, services or both (asked at sign-up, changed in Settings → Business). A services business does without stock, purchase orders and the online store's products: its catalog is **Services** (new ones counted per service; also by the hour, day, week, month or year), and it gets **Time and jobs**.
- **Time and jobs** (`GET/POST/PUT/DELETE /v1/work`, `POST /v1/work/invoice`): log the work done for each customer as it happens (a service from the catalog fills the rate, unit and GST, or any rate of its own; a timer on the page counts the hours to the quarter hour), see what is still to invoice customer by customer, and issue one tax invoice for it (all of it or the entries chosen, due on receipt or in 7 to 60 days, optionally emailed). Each entry becomes a dated line; invoiced work keeps its invoice and can no longer change; if BTS rejects the invoice the work stays to be invoiced, and work being invoiced is claimed so it is never billed twice. The overview shows how much work waits to be invoiced; a customer's page has **Log work**.
- **For your accountant** (Reports → For your accountant (ZIP), for the period chosen): one ZIP with a README (what is in it and the GST return's warnings), the GST return (PDF and CSV), profit and loss (by month and by cost category), the sales register, payments received against invoices (voided ones marked), the expenses and their attached receipts (up to 300, named by date and supplier), who owes what and the stock on hand at average cost (both as of today). The signed e-invoices stay in the document archive.
- **Profit and loss** (Reports → Profit and loss): income is sales before GST; costs are expenses before the GST claimed back (GST that cannot be claimed is a cost); by month and by category.

## Repeating expenses (`src/api/recurring-expenses.ts`)

- Rent, internet, a phone plan… (Expenses → Repeating): a supplier, a category, the amount and its GST treatment, every week, month or year from a first date, optionally until an end date. Each date is recorded once as an expense: a bill due on the day or some days later, or already paid (a standing order) by a chosen method. Housekeeping records what has come due, catching up missed dates (up to a year at a time); a first date today or earlier is recorded straight away. Paused ones wait; deleting one keeps what it recorded. The list shows about what they come to each month.

## Inventory (`src/inventory/stock.ts`, `src/api/inventory.ts`)

- **A ledger**: every change to an item's stock is a movement (`stock_movements`, never changed or deleted) written in the same statement as the new level, with its reason and source: a sale (the tax document), an online order, a refund, stock received (the delivery and its unit cost), a count, damage, loss, a customer return. Each item's history is on its page.
- **Sales take stock off**: tax invoices and receipts issued with catalog items (at the counter, from the form, from quotes and recurring invoices) take their quantities off tracked items. A sale whose document BTS rejects never counts; one later cancelled or rejected is put back once (`reverseVoidedSales`, at once on cancel and in housekeeping). A contingency reissue keeps the original sale. Online orders reserve stock when placed and never take more than there is; cancelled orders and refunds with "put back in stock" return it.
- **Quantities** have up to 3 decimals (sold by the pound or litre). Levels can go below zero: the counter never refuses a sale because a count is off; it shows as out of stock to recount.
- **Receiving stock** from a supplier (Inventory → Receive stock): items, quantities and unit costs before GST; the moving average cost of each item is updated; the supplier's bill can be recorded as an expense in the same step (stock for resale, GST on top for standard-rated, paid or a bill to pay).
- **Purchase orders** (`src/api/purchasing.ts`; Inventory → Orders, or "Order what is running low"): an order to a supplier, numbered PO-1, PO-2…, with items, quantities and unit costs (left empty, the cost of the last delivery). **Suggestions** fill it in: tracked items at or below their low-stock level (counting what is already on order), with a quantity for about four weeks of sales and at least twice the level, and the supplier they last came from. Sent by email with a PDF (the "Purchase order email" template, in the business's email language) or marked as sent another way. Deliveries are received against the order (`purchaseOrderId` on the receipt; what is still to come is filled in): each adds to what the lines have received, and the order becomes part-received, then received. An order can be edited until something arrives; a part-received order can be closed when the rest is not coming. Late orders (past the wanted-by date) are flagged.
- **A page per supplier** (Expenses → Suppliers → the name): spent this year and in all, bills to pay and overdue, open purchase orders, recent deliveries, and the items bought from them with their last cost and stock; new order (with what is low from them) and new expense start with the supplier chosen.
- **Bundles** (an item's form → "A bundle of other items"): a combo or gift basket made of other items, each with its quantity (`PUT /v1/items/:id/components`). Selling a bundle takes its components off the shelf, and its line's cost (for the gross margin) is theirs added up. A bundle cannot hold another bundle, and an item inside a bundle cannot become one.
- **Not selling** (Inventory → Not selling): items held for at least 60 days with nothing sold or ordered in that time, most money tied up first, with when each last sold.
- **Counts and adjustments**: a stock count (one category at a time, or everything) sets the levels typed in (only differences are recorded); single adjustments add, take off or set with a reason. Low-stock levels per item; low and out-of-stock items show on the overview's to-do list. Stock value at average cost; CSV export. Changing a variant's stock in the product editor is recorded as a count.

## Cash registers and shifts (`src/api/shifts.ts`, `src/render/zreport.ts`)

- **Time clock** (`src/api/timeclock.ts`): staff clock in and out from the counter or a till (the button shows since when and the hours today). Owners, admins and managers see the hours each person worked under Reports (by period, with every entry and a CSV for the payroll) and can correct an entry (kept in the activity log). A clock-in left open longer than 16 hours stops counting and is closed at 16 hours the next time that person clocks in.
- **Held sales** are shared by every till of the business (`/v1/held-sales`): a sale held at one (a table's tab) is recalled at any other, once; the list shows who held each. Sales held on a device before this are moved up the first time the counter opens.
- **Shifts**: a cashier opens a shift at the counter with the cash in the drawer (the float). Receipts and invoices they issue, counter orders they mark paid and invoice payments they record attach to their open shift. One open shift per register and per person (unique indexes); the first shift creates a "Main register", and a business with several drawers adds registers (Cash register → Registers) and picks one when opening.
- **Cash in and out**: money put in (change from the bank) or taken out (petty cash, a bank drop) with a reason; permanent, a mistake is corrected with the opposite movement.
- **Closing**: the drawer is counted blind, by notes and coins (which must add up) or as a total. Expected cash = float + cash takings (cash receipts and invoice payments, less cash refunds) + paid in − paid out; the difference (short or over) is kept with the shift. The opener or anyone allowed to adjust documents can close a shift.
- **The report**: sales by document type and GST, takings by payment (from the receipt's payment means), invoice payments, refunds (credit notes against receipts), cancelled documents, the cash drawer and every cash movement. While open it is an X report; once closed, the Z report, printable on the 80 mm receipt printer or as an A4 PDF. Cashiers see their own shifts; managers see everyone's.

## Tills: the iOS, Android and desktop apps (`src/api/pos.ts`, `web/src/pos`, `apps/`)

One till app runs everywhere:
- the desktop app (`apps/desktop`, Electron: Windows, macOS, Linux);
- the mobile app (`apps/mobile`, Capacitor: iPhone, iPad, Android);
- any browser at `/pos`.

All three are the same web code (`web/src/pos`). It reuses the counter and the shift screens.

- **Pairing:**
  - A manager adds a till in Settings → Tills. Each till gets its own cash drawer (register).
  - The manager gets a one-time code (30 minutes) and its QR code, which holds `https://<server>/pos?pair=<code>`.
  - The app scans or types the code and receives its own device token. Only a hash of the token is kept.
  - Pairing again replaces the token. Removing the till stops its token and every session on it.
- **PINs:**
  - People sign in on a till by tapping their name and entering a PIN of 4 to 8 digits. Runs like 1234 and repeats like 1111 are refused.
  - The PIN is set in My account, by a manager in Users, or on the till with the person's password.
  - Five wrong PINs lock that person out of that till for 15 minutes.
  - Changing a PIN signs the person out of every till.
  - The till locks itself after a few idle minutes (set per till).
- **Sessions:**
  - A PIN sign-in opens a session bound to the till, sent as `Authorization: Bearer pos_…`. It lasts 12 hours idle and 24 hours at most.
  - The session is never accepted as a cookie.
  - It has the person's role, limited to what a till does (`TILL_ROUTES`): selling, refunds, the cash drawer, the catalog, online orders and invoice payments. Settings, people, keys and exports stay in the web app.
  - The apps call the API cross-origin from `capacitor://localhost`, `https://localhost` and `app://pos`. No cookies are allowed cross-origin.
- **The till's drawer:**
  - Sales, counter orders and invoice payments made on a till attach to the open shift of the till's register, whoever opened it. Cashiers share the drawer.
  - Anyone signed in on that till may record cash in and out and close the shift.
  - In the web app, a person's own shift stays theirs.
- **Receipts:**
  - Printed from the document as signed (`GET /v1/documents/:id/view`, with the printed copy's authorization and regulatory texts), laid out like the PDF receipt.
  - The QR code is 22 mm, error correction M.
  - Encoded as ESC/POS for thermal printers, or as HTML for installed and browser printers (`web/src/pos/ticket.ts`).
  - Options per printer:
    - 58 or 80 mm paper;
    - accented letters as plain letters, code page 850 or Windows-1252;
    - the QR drawn by the printer or sent as a picture;
    - cut;
    - a cash drawer kicked through the printer.
  - Per till:
    - print automatically;
    - two copies;
    - open the drawer for cash;
    - print the Z report at close;
    - a message at the bottom.
- **Devices** (managers, on the till):
  - Receipt printers:
    - network (port 9100, local addresses only): desktop, Android, iOS;
    - Bluetooth (paired, serial profile): Android;
    - installed (USB) printers, printed without a dialog: desktop;
    - the browser's print dialog: the web till.
  - Cash drawer: open and test.
  - Barcode scanners:
    - USB and Bluetooth scanners that type like a keyboard, read anywhere on the screen as a burst of keys;
    - the camera: ML Kit in the apps, BarcodeDetector in browsers.
  - Customer display: a second screen, desktop.
  - The till reports what it has to the server (`POST /v1/pos/heartbeat`), and Settings → Tills shows it.
- **Online only:**
  - Every sale is signed and sent to BTS through the server.
  - When BTS is out, the server's contingency mode issues and queues documents as usual.
  - When the till has no connection, it says so.
- **Building the apps:** see `apps/desktop/README.md` and `apps/mobile/README.md`. `VITE_TILL_SERVER` pre-fills the server address.
- **Tests:**
  - `test/pos.test.ts`: pairing, PINs, lockout, the shared drawer, the route limits, CORS, removal.
  - `test/till-print.test.ts`: a real receipt as ESC/POS and HTML, the Z report.
  - The e2e till test: pair from the link, PIN, shift, scan, sell, lock.
  - `apps/desktop` `npm run smoke`.

## Platform console (`/admin`)

For the team that runs this service, not for businesses. Staff move a business from the BTS **test** environment to **production** once BTS has approved it; before, that was a manual database step.

- **Staff accounts** are created from the command line, never by sign-up: `npm run platform-admin -- add|reset|disable|enable|list` (uses `DATABASE_URL`; prints a generated password once, or set `PLATFORM_ADMIN_PASSWORD`). Staff sign in at `<PUBLIC_URL>/admin` with their own `etd_admin` cookie (`SameSite=Strict`), separate from business accounts. Failed sign-ins are throttled.
- **Overview** (the console's front page, refreshed every minute): whether the platform is healthy (the background worker reporting in, documents stuck with BTS, offline queues, expired certificates); businesses (total, new this month, in production, active in the last 30 days, new ones per week for 12 weeks, the newest); production documents today and in the last 30 days against the month before; online stores and their orders; monthly revenue, trials and the platform's open invoices; the busiest businesses; and **Needs attention**: each business with an expired or expiring certificate, documents stuck with BTS, an open outage, failing webhooks, an overdue invoice or a trial ending this week, urgent ones first, each linked to the business (`GET /v1/platform/overview`).
- **Businesses:** every business with its TIN, address, environment, users, authorized test documents and certificate expiry; search and filter.
- **Readiness for production**, checked again inside the switch itself:
  - required: an active, valid certificate for the business's TIN
  - required: nothing still on its way to BTS test (no pending or contingency documents, no pending cancellations, no open outage)
  - recommended: at least one authorized document in the test environment
- **Going live** needs the BTS approval reference and the business's TIN typed again. Optionally it retires the current certificate, for when BTS issues a separate production certificate. Then:
  - documents go to BTS production; **numbering starts again at 000000001 with a fresh sequence-hash chain**, because test and production are separate BTS systems. Series and document numbers are now unique per environment, and the ETDUI already carries the environment.
  - the business's document list and reports show only production documents (test ones stay available with `?environment=test`)
  - its owners are emailed, and the change appears in the business's own activity log and in the staff log
- **Going back to test** is allowed only while nothing has been issued in production.
- **Staff log:** every staff sign-in and change, permanent.
- **Suspending a business** (fraud, abuse, a legal order; the TIN typed again and a reason): no one can sign in, existing sessions, tills and API keys are refused, and its online store is closed until staff reactivate it (sessions work again then). Documents already on their way to BTS still finish, and customers' links to their documents keep working. Its owners are emailed the reason, and it appears in the business's own activity log.
- **Documents waiting for BTS:** a business's page shows what is pending (and for how long) or issued offline; **Send now** runs the worker's retry for that business at once (pending documents older than a minute, then the offline queue).
- **Someone locked out:** from the business's People, staff email a person a link to choose a new password (only ever to that person's own address; staff never see the link), or turn off a person's two-step sign-in after a lost phone, with how they confirmed who it is (the person is signed out everywhere and emailed). Both appear in the staff log and the business's activity log.
- **Notices** (Console → Notices): a line at the top of every business's app while it lasts (maintenance, a BTS outage, news), in English and optionally Spanish, information or warning, until an end time or until staff end it; each person can dismiss it.

| Method and path | What it does |
|---|---|
| `POST /v1/platform/auth/login`, `/logout`, `GET /v1/platform/auth/session` | Staff sign-in |
| `GET /v1/platform/overview` | The front page: health, growth, documents, stores, revenue, who needs attention |
| `GET /v1/platform/tenants`, `GET /v1/platform/tenants/:id` | Businesses; one business with its readiness checks and staff history |
| `POST /v1/platform/tenants/:id/go-live` | `{ confirmTin, approvalReference, retireCertificate? }` |
| `POST /v1/platform/tenants/:id/back-to-test` | `{ confirmTin, reason }` |
| `POST /v1/platform/tenants/:id/suspend`, `.../reactivate` | `{ confirmTin, reason }`, `{ reason }` |
| `POST /v1/platform/tenants/:id/retry` | Send the business's documents waiting for BTS now |
| `POST /v1/platform/tenants/:id/users/:userId/reset-link`, `.../two-factor/reset` | Email a password link; turn off two-step sign-in (`{ reason }`) |
| `GET /v1/platform/notices`, `POST /v1/platform/notices`, `POST /v1/platform/notices/:id/end` | Notices to every business (`{ message, messageEs?, level?, endsAt? }`) |
| `GET /v1/platform/audit` | The staff log |

To confirm with BTS: whether production numbering should restart at 1 (what this does) and whether production needs a different certificate (the console lets staff choose).

## Plans and billing (`src/billing`)

The platform charges businesses by plan: **Starter** (free: 30 production documents a month, 2 accounts), **Business** (BZ$49 a month + GST: 1,000 documents, 10 accounts, the online store, API keys) and **Pro** (BZ$129: no limits, webhooks, integrations). Documents in the BTS test environment never count. Prices and limits live in `src/billing/plans.ts`.

- New businesses get a 30-day Business trial. A daily run ends trials, invoices each month in advance (due in 14 days), applies scheduled downgrades, marks unpaid subscriptions past due and, 14 days later, pauses issuing. Credit notes, reading, printing and exporting are never blocked.
- The platform's invoices are real BTS e-invoices, issued by the platform's own business on the platform (`PLATFORM_BILLING_TENANT`) and emailed with the PDF; businesses are reminded when a trial ends, an invoice is overdue or issuing pauses.
- **Settings → Plan** shows the plan, usage, plans to choose from (owners change it), invoices and how to pay (`PLATFORM_PAYMENT_INSTRUCTIONS`). **Console → Billing** shows monthly revenue and open invoices; staff record payments, void invoices, issue missing e-invoices, set plans and give trials.

| Method and path | What it does |
|---|---|
| `GET /v1/billing`, `PUT /v1/billing/plan`, `GET /v1/billing/invoices/:id/pdf` | The business's plan, changing it, an invoice's PDF |
| `GET /v1/platform/billing`, `POST /v1/platform/invoices/:id/paid\|void\|issue`, `PUT /v1/platform/tenants/:id/subscription` | The console's billing |

A plan limit answers **402** with `plan_limit`, `plan_feature` or `billing_suspended`.

## Public API, webhooks and integrations

- **Reference:** `/docs` renders the OpenAPI 3.1 description at `/v1/openapi.json`, built from the routes' own schemas, with guides and curl examples. API keys are limited to 600 requests a minute (`API_RATE_LIMIT_PER_MINUTE`), with `X-RateLimit-*` headers.
- **Webhooks** (Pro): database triggers record every document and order change in an outbox; the dispatcher signs each delivery (`X-EInvoicing-Signature: t=…,v1=<HMAC-SHA256>`), retries for about a day, and switches off an endpoint after 20 failures in a row. Endpoints must be https and public (checked on the address actually used). Events: `document.authorized`, `document.rejected`, `document.cancelled`, `document.issued_offline`, `order.placed`, `order.paid`, `order.fulfilled`, `order.cancelled`, `order.refunded`, `payment.recorded`, `invoice.paid`, `expense.recorded`, `stock.received` (with its lines), `purchase_order.received` (once everything has arrived). Manage them in Settings → Developers or with `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:id`, `.../rotate-secret`, `.../test`, `.../deliveries`.
- **QuickBooks Online** (Pro; `src/integrations/quickbooks.ts`): connect with Intuit OAuth in Settings → Integrations; authorized documents are sent within a minute as Invoices, SalesReceipts and CreditMemos (document number, ETDUI and authorization in the note), cancelled ones are voided, and GST is booked once the business maps its QuickBooks tax codes. Needs the platform's Intuit app: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, and the redirect URI `<PUBLIC_URL>/v1/integrations/quickbooks/callback` registered with Intuit.
- **QuickBooks Desktop and QuickBooks Point of Sale** (Pro; `src/connectors/`): for businesses that keep invoicing in their own QuickBooks and use this service only to send it to BTS. Settings → Integrations makes a connection (a user name, a password shown once, and a `.qwc` file); the business adds it to the free QuickBooks Web Connector on the computer that runs QuickBooks, which checks in every 5 minutes over SOAP (`POST /v1/qbwc`, qbXML 13.0 for Desktop, qbposXML 3.0 for Point of Sale). Each check-in picks up invoices and sales receipts (Desktop) or receipts (Point of Sale) dated from the connection's start day, with their items' types and their customers' TIN (a `TIN` custom field, or a six-digit resale number) and email; they are issued here within seconds as tax invoices and receipts. Discount lines become allowances on the line before; service items are sold by the job; sales tax codes map to GST in Settings (QuickBooks' own `Tax` and `Non` are known), and a document with a code not mapped, a total that doesn't add up, or tax other than 12.5% GST waits under **Needs attention** (Send again, Issue anyway, Skip). On Desktop the next check-in writes the BTS number into the transaction's **Other** field and the details at the end of its memo, or why BTS refused it; an edit made in QuickBooks after it was sent is noted, not sent twice. Point of Sale returns and voids are held for a credit note made here. Needs `PUBLIC_URL` on https (the Web Connector refuses plain http except for localhost). Tested against QuickBooks' documented message formats with a played Web Connector, not yet against a live company file.
- **NetSuite** (Pro; `src/connectors/netsuite.ts`): the same for businesses that invoice in NetSuite. Connecting makes an RSA key (3072 bits, kept encrypted) and a certificate valid just under two years; the business's NetSuite administrator enables REST Web Services and OAuth 2.0, creates an integration record with only the client credentials (machine to machine) grant, a role (Invoice, Cash Sale and Credit Memo to edit; Customers to view; REST Web Services; OAuth 2.0 access tokens; SuiteAnalytics Workbook), a Free-Form Text transaction body field `custbody_bts_number` (optionally `custbody_bts_status`), and uploads the certificate in OAuth 2.0 Client Credentials Setup; then enters the Account ID, Client ID and Certificate ID in Settings → Integrations, which signs in and runs one query to test them. Tokens are asked for with a JWT signed PS256 (no password or refresh token is kept; token-based authentication is not used, as NetSuite stops accepting it for new integrations from 2027.1). Every 5 minutes SuiteQL lists the invoices, cash sales and credit memos changed since the last read (dated from the start day); each is read through the REST record API with its lines and customer (TIN from the tax registration number or a TIN custom field) and issued as a tax invoice, a tax receipt, or a credit note against the invoice it was made from. Discount and markup items act on the line before; the header discount is shared over the lines; shipping and handling become lines; tax codes map to GST as for QuickBooks; documents in another currency, credit memos whose original was not sent here, and totals or tax that don't match wait under **Needs attention**. The BTS number (and status and ETDUI) is written into the custom fields; a re-read is compared by content, so our own write-back is not mistaken for an edit, while an edit or a void after authorization is flagged. Tested against NetSuite's documented REST and OAuth formats with a played account, not yet against a live one.

## Operations (`docs/operations.md`, `docs/staging.md`)

- **Deploying:** `Dockerfile` (server and web app in one image, health check included), `deploy/docker-compose.prod.yml` (app, PostgreSQL, nightly backups) and `deploy/env.example` (every setting, commented). App servers are stateless; run the worker and housekeeping in one of them.
- **CI:** `.github/workflows/ci.yml` runs the typecheck, the server tests (with a real PostgreSQL), the web build, the browser tests and an image build with a smoke test on every push.
- **Monitoring:** worker heartbeats, `/health` (`ok`/`degraded`), `/metrics` (Prometheus), and webhook alerts when the worker stops, documents get stuck, the contingency queue grows or certificates expire, and again when resolved.
- **Notifications:** owners and admins are emailed (once) when BTS rejects a document, when BTS becomes unreachable and when it is back, and 30, 14, 7 and 1 days before their certificate expires.
- **Backups:** managed PostgreSQL point-in-time recovery, plus `npm run backup` nightly dumps kept off-site; a monthly restore drill. The key-encryption key is backed up separately.
- **Keys:** stored secrets name the key that encrypted them; `npm run rotate-keys` moves them to a new key. A cloud KMS plugs in behind the same `KeyProtector` interface.
- **Photos:** S3-compatible object storage behind a CDN (SigV4, no SDK), `npm run move-photos` for existing ones.
- **Security:** `SECURITY.md` (reporting, what protects the service); HSTS and a strict CSP; `npm audit`, Dependabot and CodeQL on GitHub.
- **Public pages:** `/pricing`, `/terms`, `/privacy` (who runs the service from `LEGAL_NAME` and `CONTACT_EMAIL`). Have the terms and privacy policy reviewed by a lawyer before launch.

## Printed copy (`src/render`, manual 3.4 and 3.5)

| Module | Job | Status |
|---|---|---|
| `view.ts` | Read the printed fields back from the signed XML (the manual allows nothing else), the table 3-3 regulatory messages, and the QR lookup URL | Done |
| `pdf.ts` | `renderSheet` (A4/Letter, landscape by default, multi-sheet with "Sheet n of m") and `renderReceipt` (thermal, 56–80 mm, sized to content) | Done |

- **Font sizes:** at least 11 pt for parties, items and numbers; at least 9 pt for everything else.
- **QR code:** 22 mm of code inside a 3 mm quiet zone, error correction M. It encodes `https://portal.prod.bz.efdrciat.org/QRCode?UUID=<ETDUI>`. Tests decode the image back to that URL.
- **Authorization:** a previous-authorization document can't be printed without BTS's authorization protocol, unless `draft: true`, which prints "DRAFT - NOT AUTHORIZED BY BTS".
- **Fonts:** the built-in PDF fonts cover Latin-1, which is enough for English and Spanish names. Other scripts would need an embedded font.

## Settled by the manual

These were placeholders in the spec and are now confirmed against the manual:

- **Check digit:** `(11 - remainder) mod 10`, so 11 gives 1 and 10 gives 0. All 13 example IDs follow this.
- **Sequence hash:** UUID + LineCountNumeric + TaxAmount + LineExtensionAmount, with no separator, each exactly as written in the XML. `ubl.ts` computes it from the strings it writes.
- **EFDR extension:** the two hash elements sit inside `efdr:sequenceInfo`. The contingency elements are `contingencyReason`, `contingencyInitDate` and `contingencyInitTime`, the time with its offset.
- **Operating modes:**
  - 2 means subsequent authorization for 01/03/04 and requires contingency info.
  - 3 means subsequent authorization for Tax Receipts. It is allowed in normal operation too, and contingency info is optional.
- **Series:** 001 to 999, with 001 when unused.
- **Country code:** `BLZ` (table 10-7).
- **District codes:** 1 Belize, 2 Cayo, 3 Corozal, 4 Orange Walk, 5 Stann Creek, 6 Toledo. The name must match the code.
- **TIN position:** `PartyTaxScheme/CompanyID`. It is also written to `PartyLegalEntity/CompanyID`, per 4.6.2.
- **Type codes:**
  - `InvoiceTypeCode` and `CreditNoteTypeCode` carry `listID="UN/ECE 1001 Subset"` and `listAgencyID="UN/CEFACT"`.
  - Defaults are 380 for invoices and receipts, 80 for debit notes, 381 for credit notes.
- **Document references:** carry `IssueDate`, `IssueTime`, `DocumentTypeCode` and `DocumentType` text.
- **Line allowances/charges:** carry `ID`, `BaseAmount` and a `TaxCategory`.
- **Price:** carries `BaseQuantity`.
- **Per-unit taxes (ENV, EXC):** the quantity goes in `TaxableAmount` and the rate in `TaxCategory/PerUnitAmount`, per the fuel example in 4.8.2.
- **Document TaxTotal:** one per tax scheme, GST first. GST is rounded per category on the document total (4.2).
- **No whitespace between tags:** BTS rule C02, code 221.

## Still open: ask BTS or settle on the test server

- **First document in a series:** what `sequenceInfoPreviousETD` should be is not stated. We use the document's own hash. Every manual sample uses `2M9dDwLvAsXLGhUF6gGOWM+npKc=`, which looks like a test-tool constant. BTS validates only `sequenceInfoThisETD` (271), so either should pass.
- **Hash values on larger documents:**
  - For documents with more than one line, the manual cites the line element (CA-006) for LineExtensionAmount. We use the document total, which is identical for one line.
  - For documents with more than one tax scheme (fuel), we use the GST TaxTotal's TaxAmount. A two-line test invoice on the test server will settle both points.
- **Rounding method:** the manual recommends an unusual rule (table 4-16), and its own examples contradict it, e.g. 1.7258 becoming 1.72. We use round-half-up. BTS does not validate total arithmetic.
- **Line allowance TaxTotal:** table 4-24 marks `AllowanceCharge/TaxTotal` as 1-1. It is left out to avoid reporting the GST twice, and the manual's own examples omit it.
- **Prose vs examples:** the manual's prose says one line `TaxTotal` per tax, but its XML example uses one `TaxTotal` with a subtotal per tax. We follow the example.
- **TIN length:** 6 digits everywhere in the syntax. One graphic-representation field mentions a 7-digit GST number.
- **Signature policy hash:**
  - BTS's own signature (7.3.1) uses policy `https://efdrshare.blob.core.windows.net/documentation/bz/sigPolicyv1.pdf` with hash `k2uAJ+0STF8ByHKCAvdesW6J6+OBhVxuc6xJLBIA8es=`. That is our default (`BTS_SIGNATURE_POLICY`).
  - The PDF published at that URL today hashes to `ASZbXZ+3tPmWjkvBqnJ6kdahIFe4PI5rSQsG3HQyEn0=`.
  - The Annex I sample uses a different URL with a placeholder hash, "demo policy digest value".
  - Ask BTS which one they validate.
- **Document Query and System Status JSON shapes:**
  - The manual gives the field names (GetDocument: UUID, ResponseCode, Description, ResultETD; GetStatus: ResponseCode, StatusResponseTime) but not the exact JSON, nor the request field for the ETDUI. We send `{"ETDUI": "..."}`, which can be changed with `documentQueryField`.
  - Replies are read field by field wherever they appear. The first test-server call will confirm the shapes.
- **Verifying BTS's reply signatures:** this needs the BTS root CA certificate. BTS wraps its signature in `sig:UBLDocumentSignatures`, so `verify.ts` will need to accept that placement for replies.
- **Certificate format from the BTS portal:** probably PKCS#12 (.pfx/.p12), since BTS's tooling looks .NET-based. Node cannot read PKCS#12 natively, so onboarding will need a conversion step to PEM.
- **QR lookup URL for the test environment:** the manual gives only the production URL. We assume `https://portal.test.bz.efdrciat.org/QRCode?UUID=`, which can be changed with `qrBaseUrl`.
- **Superseded originals and the hash chain:** when a sale is reissued in contingency, the normal series' hash pointer moves back past the superseded original, on the expectation that BTS never received it. If BTS did authorize it, it gets cancelled, and the next normal document's chain skips a document that existed. That's a gap-analysis question, like the rejection case.
- **Time limits:** for sending contingency documents and for cancellation (event 050), still unknown.
- **Business questions** (from the spec): provider approval, holding taxpayers' keys in a hosted service, rollout dates, and time limits for contingency and cancellation.

## Notes for the next modules

- **Web app, next:**
  - Optional two-step sign-in for owners and admins.
  - Emails in Spanish.
  - Login rate limits and email limits shared across instances (they are per process today).
- **API hardening:**
  - Rate limiting per key.
  - OpenAPI docs for integrators.
  - Certificate-expiry warnings from the worker.
- **Hardening for scale:**
  - PostgreSQL row-level security on `tenant_id`, as defense in depth.
  - A job queue so `resumePending` runs as one worker per tenant.
  - The KEK in a cloud KMS.
- **First run against the BTS test server:** point `BtsClient` at `environment: 'test'` with a real BTS test certificate. Send one single-line and one two-line invoice to settle the open hash questions.
- **QR code (3.5):** `https://portal.prod.bz.efdrciat.org/QRCode?UUID=<ETDUI>`, error correction level M, UTF-8, at least 25 mm × 25 mm including a 3 mm quiet zone.
- **Annex I samples:** not valid against the UBL schema. They omit required elements such as `InvoicedQuantity` and `Price`, and use VAT at 10%. Use them for the signature layout and the hash rule only.
