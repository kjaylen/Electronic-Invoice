# Belize E-Invoicing

A multi-tenant service that turns invoices into signed UBL 2.1 Electronic Tax Documents (ETDs), submits them to the Belize Tax Service (BTS / VERTX-BZ) for authorization, and stores the legal record. The invoicing app, POS, public API and accounting connectors (QuickBooks, NetSuite, and others) all sit on top of the core engine.

## Requirements

- Node.js 22.18 or later. TypeScript runs directly, with no build step.

## Commands

```
npm install
npm test          # unit tests
npm run typecheck # tsc --noEmit
npm run check     # both
```

## Core engine (`src/engine`)

| Module | Job | Status |
|---|---|---|
| `decimal.ts` | Exact decimal and cents arithmetic (BigInt, never floating point) | Done |
| `time.ts` | Belize local time (UTC-6, no DST) | Done |
| `etdui.ts` | 44-digit ETDUI, modulus 11 check digit, security code | Done, matches the manual's example |
| `calc.ts` | Line and document totals, GST, other taxes, rounding | Done, matches the manual's diesel example |
| `sequence.ts` | Per-series SHA-1 hash chain | Done; options to settle against the BTS test server |
| `ubl.ts` | UBL 2.1 XML per document type | Next |
| `sign.ts` | XAdES-EPES signature | Not started |
| `transport.ts` | Mutual-TLS submission to BTS | Not started |

Engine modules are pure and stateless. Everything tenant-specific (TIN, environment, series, tax rates, certificate) is passed in, so any number of businesses can be processed in parallel.

## Waiting on BTS

These are coded as configurable placeholders until BTS answers or the test server settles them:

- **Check digit:** the digit when 11 minus the remainder is 10 or 11 (`CHECK_DIGIT_WHEN_10_OR_11`, currently 1).
- **Sequence hash:** the separator, the amount format, and the first-in-series value (`DEFAULT_SEQUENCE_OPTIONS`).
- **TIN length:** 6 digits or 7.

Unit tests cover the manual's one worked ETDUI. The spec mentions five more example IDs in the manual; add them to `test/etdui.test.ts`.
