# Belize E-Invoicing

A multi-tenant service that turns invoices into signed UBL 2.1 Electronic Tax Documents (ETDs), submits them to the Belize Tax Service (BTS / VERTX-BZ) for authorization, and stores the legal record. The invoicing app, POS, public API and accounting connectors (QuickBooks, NetSuite, and others) all sit on top of the core engine.

The reference is the **BTS Orientation Manual for Issuers of Electronic Tax Documents, v1.30 (May 2026)**. Section numbers below refer to it.

## Requirements

- Node.js 22.18 or later. TypeScript runs directly, with no build step.

## Commands

```
npm install
npm test          # unit tests
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

- **API and invoicing app:**
  - An HTTP API with accounts and login, and endpoints for customers, items, issuing, cancelling, and fetching statuses and PDFs.
  - A web app on top, including onboarding with `.pfx`-to-PEM certificate conversion.
- **Workers:** schedule `resumePending`, `catchUpContingency` and certificate-expiry warnings per business.
- **Hardening for scale:**
  - PostgreSQL row-level security on `tenant_id`, as defense in depth.
  - A job queue so `resumePending` runs as one worker per tenant.
  - The KEK in a cloud KMS.
- **First run against the BTS test server:** point `BtsClient` at `environment: 'test'` with a real BTS test certificate. Send one single-line and one two-line invoice to settle the open hash questions.
- **QR code (3.5):** `https://portal.prod.bz.efdrciat.org/QRCode?UUID=<ETDUI>`, error correction level M, UTF-8, at least 25 mm × 25 mm including a 3 mm quiet zone.
- **Annex I samples:** not valid against the UBL schema. They omit required elements such as `InvoicedQuantity` and `Price`, and use VAT at 10%. Use them for the signature layout and the hash rule only.
