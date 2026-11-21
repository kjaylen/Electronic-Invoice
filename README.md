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
| `PUBLIC_URL` | Public address of the web app, e.g. `https://app.example.bz`. Links in emails and share links are built from it, never from the request's Host header. Without it, password reset, invitation links and share links are off |
| `SMTP_URL`, `MAIL_FROM` | Outgoing mail (password resets, invitations, documents), e.g. `smtps://user:pass@smtp.example.com:465` |
| `MAIL_OUTBOX_DIR` | Instead of SMTP, write each email as an `.eml` file here (development and the demo) |

**Conventions:**
- **Authentication:** `Authorization: Bearer <key>`. Tenant routes take an API key (`etd_<prefix>_<secret>`); admin routes take the admin token. The business is always taken from the key, never from the URL or the body.
- **Money and quantities:** decimal strings (`"24.99"`); JSON numbers are refused.
- **Errors:** always `{ "error": { "code", "message", "details"? } }`. A malformed request is 400. A document BTS would refuse is 422, with the rule and BTS code in the message. A wrong state is 409, a missing record is 404, and a bad or missing key is 401.
- **Issuing:** `POST /v1/documents` answers **201 whenever a document was created**, whatever BTS decided. Check `status`: `authorized`, `authorized_with_alert`, `rejected` (with `conditions`), `contingency_pending` or `pending`.
- **Idempotency:** send an `Idempotency-Key` header, unique per sale. A retry returns the original response (`Idempotent-Replayed: true`) and never issues twice. Reusing a key for a different request is refused (422), and a request that failed validation releases its key.

| Method and path | What it does |
|---|---|
| `GET /health` | Liveness and database check |
| `POST /v1/admin/tenants` | Create a business |
| `POST /v1/admin/tenants/:id/certificate` | Upload its BTS certificate and key (PEM) |
| `POST /v1/admin/tenants/:id/api-keys` | Create an API key; the secret is shown once |
| `DELETE /v1/admin/tenants/:id/api-keys/:keyId` | Revoke a key |
| `GET /v1/me` | The business, its certificate (days left) and contingency state |
| `PUT /v1/certificate` | Renew the business's own certificate |
| `POST/GET /v1/customers`, `GET/PUT/DELETE /v1/customers/:id` | Saved customers; list supports `q` (name, TIN, phone, email), `limit`, `cursor`. `PUT` replaces every field; `DELETE` archives |
| `POST/GET /v1/items`, `GET/PUT/DELETE /v1/items/:id` | Catalog items, with optional `barcode` and `favorite`. List supports `q`, `favorite=true`, and `code` (exact barcode or your own code). `DELETE` archives and frees the barcode |
| `POST /v1/documents` | Issue a document (see the body below) |
| `GET /v1/documents` | List; filters `status`, `type`, `from`/`to` (issue date), `customerId`, and `q` (number like `12` or `001-000000012`, ETDUI, or customer name or TIN); cursor pagination |
| `GET /v1/documents/:id` | Status, totals, lines, conditions, protocol number, contingency links |
| `GET /v1/documents/:id/xml` | The signed XML exactly as sent to BTS |
| `GET /v1/documents/:id/pdf` | Printed copy. Query options: `format=sheet\|receipt`, `paper=A4\|LETTER`, `orientation`, `widthMm`, `draft=true` |
| `POST /v1/documents/:id/cancel` | Cancel an authorized document (event 050). Returns 200 when registered or rejected, 202 when BTS couldn't be reached |
| `POST /v1/documents/:id/email` | Email the printed copy (PDF) and the signed XML to one address, replies going to the business. Recorded; at most 200 emails per business per hour |
| `GET /v1/documents/:id/messages` | Emails sent for a document |
| `POST /v1/documents/:id/share` | A link (`/d/<token>`) that opens the PDF without logging in, valid 90 days. It stops working if the document is cancelled. For WhatsApp, SMS or anywhere else |
| `GET /v1/reports/summary` | `from`, `to`: totals, GST by rate, by type and by day. Credit notes subtract; only documents with legal value count |
| `GET /v1/reports/customers`, `/v1/reports/items` | Sales by customer and by item |
| `GET /v1/reports/documents` | The document register as CSV, every status included |

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
- **Credit and debit notes:** add `"reference": { "documentId": "…", "reason": "…" }`.

Authentication also accepts the web app's session cookie (see "Web app"). The routes for owners are `POST /v1/certificate/pfx`, which installs a `.pfx` certificate, and `GET/POST/DELETE /v1/api-keys`, which manage the business's own API keys. `POST /v1/documents/preview` returns totals without issuing anything.

Web app only (session cookie): `GET /v1/team`, `POST/DELETE /v1/team/invitations`, `PATCH/DELETE /v1/team/members/:userId`, and under `/v1/auth`: `password/change`, `password/forgot` (always 204, so it cannot reveal who has an account), `password/reset`, `invitations/:token` and `invitations/accept`.

**Not built yet:** rate limiting per API key, and OpenAPI docs.

## Web app (`web/`)

A React + TypeScript app (Vite) served by the API server from `web/dist`. It's built for business owners and staff, not developers.

- **Accounts:**
  - Email and password. Passwords are hashed with scrypt; only a hash of each session token is stored.
  - Sessions live in httpOnly, SameSite=Lax cookies. Every change sent with a cookie also needs `X-Requested-With: etd-web`, which blocks CSRF.
  - Logins are rate-limited per email and IP, and unknown emails take as long as wrong passwords.
  - Roles per business: **owner** (certificate, API keys, team) and **member** (issuing, sending, catalog). A business always keeps at least one owner.
  - **Teammates:** owners invite by email. The link works once, for 7 days, and only for that email address; the owner also gets the link to share another way (WhatsApp, in person). New people create their account from the link, even when self-service sign-up is closed.
  - **Passwords:** forgotten passwords are reset by an emailed one-time link (one hour). Changing or resetting a password signs out every other session.
- **Onboarding:**
  1. Account.
  2. Business. Self-service businesses start in the BTS **test** environment; moving to production is an admin step.
  3. The BTS certificate, uploaded as a `.pfx`/`.p12` file with its password and converted to PEM on the server with node-forge.
- **Screens:**
  - **Overview:** today's sales (credit notes subtracted), documents needing attention, certificate warnings. It refreshes while documents are still waiting for BTS.
  - **Counter** (tax receipts at speed):
    - scan a barcode or type a code and press Enter; `3*code` adds three
    - star items in the catalog to make them quick buttons
    - `+` / `−` change the last line, `Del` removes it, `F2` or `Ctrl+Enter` issues
    - cash received and change, card or transfer, optional customer TIN
    - "repeat last sale", free-text items
    - optional automatic printing on an 80 mm receipt printer (the browser remembers the printer)
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
  - **Customers and items:** add, edit, archive; customers link to their documents.
  - **Reports:** this month, last month, quarter, year or custom; sales and GST collected, sales per day, GST by rate for the GST return, top customers and items; CSV for each.
  - **Settings:** business, language, password, certificate, team, API keys.
- **Live status:** a bar under the top menu appears while BTS is unreachable (with the queue count), when it comes back, and when the device is offline.
- **Spanish:** every screen is in English and Spanish (`web/src/es.ts`). The choice is per device, defaulting to the browser's language. Emails are in English for now.
- **Installable:** a web app manifest, icons and a service worker that caches the app shell (never API data), so it installs on phones and desktops and opens fast.
- **Accessibility:** a skip link; focus moves to each new page; dialogs trap focus and give it back; a keyboard-operable combobox; every control labelled; muted text at 5:1 contrast.
- **Robustness:** each page loads on demand and crashes stay inside one page (with a reload button); an expired session returns to the login page; network errors say so plainly.
- **Design:** "ledger and drafting table".
  - Warm grid paper, cream sheets with hairline edges, aubergine ink.
  - Purple brand, lime for authorized, coral for problems.
  - Inter Tight and Geist Mono (OFL), self-hosted.
  - Original SVG crystals on the sign-in, onboarding and overview screens.
- **Motion:**
  - native view transitions between pages, with the top bar held in place
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

- **Business and certificate:** register the business with TIN **123456** and upload `test/certs/signer-123456.pfx`, password `test-pfx-password`. This is a throwaway test certificate.
- **BTS stand-in:** it authorizes every document.
- **Outage simulation:** create the file `.demo/bts-down` and new documents go into contingency. Delete it, and the worker sends them within about 15 seconds.
- **Emails** (password resets, invitations, documents) are written to `.demo/outbox` as `.eml` files; open them with any mail program.

### Browser tests

```
docker compose up -d db
npm run e2e
```

Builds the web app, starts the demo on port 3100 with a fresh `einvoicing_e2e` database, and drives a real browser through sign-up, onboarding, the catalog, a counter sale, an invoice with a restored draft, emailing, search, reports, inviting a teammate, password reset, Spanish, accessibility checks, installability and the phone layout. On Windows it uses the installed Microsoft Edge; elsewhere run `npx playwright install chromium` first (or set `PW_CHANNEL`).

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
  - An admin console for moving businesses to production.
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
