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
```

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
| `sign.ts` | XAdES-EPES signature (chapter 8) | Next |
| `transport.ts` | Mutual-TLS submission to BTS (chapter 7) | Not started |

Engine modules are pure and stateless. Everything tenant-specific (TIN, environment, series, tax rates, certificate) is passed in, so any number of businesses can be processed in parallel.

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
- **Business questions** (from the spec): provider approval, holding taxpayers' keys in a hosted service, rollout dates, and time limits for contingency and cancellation.

## Notes for the next modules

- **Signature (8.3):**
  - XMLDSig enveloped, XAdES-EPES, RSA-SHA256, SHA-256 digests, C14N 1.0.
  - The enveloped-signature transform comes first, then C14N.
  - The signature goes in a second `UBLExtension`.
  - The Annex I sample uses signature policy `https://www.ciat.org/ciatdat/sigpolicy/sigPolicyv1.pdf`.
- **QR code (3.5):** `https://portal.prod.bz.efdrciat.org/QRCode?UUID=<ETDUI>`, error correction level M, UTF-8, at least 25 mm × 25 mm including a 3 mm quiet zone.
- **Annex I samples:** not valid against the UBL schema. They omit required elements such as `InvoicedQuantity` and `Price`, and use VAT at 10%. Use them for the signature layout and the hash rule only.
