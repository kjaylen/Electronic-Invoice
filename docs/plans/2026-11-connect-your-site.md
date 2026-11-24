# Plan: connect your own site to Floreo

Who this is for: small businesses in Belize, and the developers and agencies
who build sites for them. They make a site with whatever tools they like
(plain HTML and JavaScript first, React second) and connect it to Floreo for
the catalogue, cart, checkout, payments, orders, stock and the BTS tax receipt
every paid order gets. The target: from sign-up to a working product page and a
test checkout in under 30 minutes.

Status marks: `[ ]` to do, `[x]` done, `[-]` skipped (the reason is in DECISIONS.md).

The plan before this one (the site builder and the polish pass) is finished and
kept in `docs/plans/2026-11-site-builder.md`.

## What exists (read end to end, 24 Nov 2026)

- **A public store API** (`src/api/storefront.ts`, `/v1/store/:slug/...`): store
  details, products, collections, a product, photos, pricing a cart, placing an
  order, the buyer's order page and receipt, starting and confirming an online
  payment, gift cards, checkout reminders, buyer accounts (cookie). No sign-in;
  rate limits per IP on the routes that write.
- **Secret API keys** (`src/db/apikeys.ts`, `etd_<prefix>_<secret>`): one kind,
  made by owners in Settings → Developers, 600 requests a minute, act as the
  whole business. Needs the Business plan (a new business's trial has it).
- **Webhooks** (`src/webhooks/webhooks.ts`, Pro plan): fourteen events from
  database triggers, signed, retried six times over about a day, the last 50
  deliveries per endpoint listed, a test ping, secret rotation.
- **Reference** (`/docs`, from `/v1/openapi.json`): the key-authenticated API
  only. The store API is described nowhere but the README.
- **Test and live**: a business is in the BTS test environment or in
  production, as a whole. Test documents have no fiscal value and there is a
  pretend card page for payments.

## What an outside site hits today

Found by acting as a customer: a business signed up on a private server, three
products, the store opened, an API key made, and a static site on another
origin (`http://localhost:3140`) calling the API with what the README says.

1. **Nothing works from a browser.** The store API sends no CORS headers, so
   `fetch` from any other site fails ("blocked by CORS policy") on the first
   call, and every POST fails its preflight with 404. The only way in today is
   a proxy on the customer's own server, which a non-developer cannot build.
2. **Nothing says how to start.** Settings → Developers talks about issuing
   documents from a POS. `/docs` has no store endpoints. There is no quick
   start, no snippet, nothing to copy.
3. **The only key is a secret one** that acts as the whole business. It must
   not go into a page, and there is nothing that may.
4. **Answers point inside Floreo.** A product has `imageId`, not an address;
   an order answers with a `path` and a `redirectUrl` relative to Floreo; I
   had to guess the photo address from the README.
5. **Paying online never comes back.** The provider returns the buyer to
   Floreo's own order page. The pretend card page finds its way back from the
   browser's storage on Floreo's origin, so an order placed from another site
   ends on the store's home page with nothing said.
6. **No drop-in pieces.** No script, no buy button, no cart; everything is
   to be built by hand against the API.
7. **Errors are the validator's own words**: `querystring/limit must match
   pattern "^\d{1,3}$"`, `body must have required property 'fulfillment'`.
   Correct, but not what to do about it.
8. **Lists differ.** Documents and customers page with `limit` and `cursor`;
   store products take `limit` only and say nothing about more; orders stop at
   300.
9. **`Idempotency-Key` on store orders is ignored** (the hosted checkout sends
   one): a retry after a dropped connection places a second order.
10. **Test and live look the same** from outside: one boolean in the store's
    details; keys carry no mark.
11. **Webhooks**: nothing about a product or its stock changing, or a payment
    failing; the delivery log shows no payload and no answer body; endpoints
    must be public https, so nothing can be tried on a laptop without a tunnel
    (and the docs do not say so).
12. **Nothing to debug with.** No request log, no error log, no usage; a key
    shows only when it was last used.
13. **Buyer accounts and the store's own design** (`site`, `theme` in the
    store's details) are tied to Floreo's own pages; an outside site gets a
    large answer it has no use for.

## The plan, most helpful to a customer first

### A. A first integration that works

- [x] 1. **Publishable keys.** `pk_test_…` / `pk_live_…`, safe in a page: they
  open only the public store API, only for the sites on their list (any
  `localhost` for a test key). Made, listed, changed and revoked by owners
  (`/v1/publishable-keys`); kept in the store's settings, no schema change.
- [x] 2. **The store API answers other sites.** CORS for requests that carry a
  publishable key from an allowed site, never with cookies; a refusal says
  what is wrong and where to fix it, and is readable from the page. Requests
  with no `Origin` (servers, the hosted store) work as before.
- [x] 3. **Answers an outside site can use.** Full addresses beside the old
  fields (`imageUrl`, `url`, `orderUrl`, `payment.url`), `GET
  /v1/store/:slug/info` (the store without its hosted design), `returnUrl` on
  orders and payments so the buyer comes back to the site they bought on, and
  the pretend card page returning there too.
- [x] 4. **The embed script.** One tag (`/embed.js`): `<floreo-products>`,
  `<floreo-product>`, `<floreo-buy-button>`, `<floreo-cart>`,
  `<floreo-checkout>`, styled with CSS variables and `::part`, English and
  Spanish, a test-mode mark, and `window.Floreo` for developers. Served from a
  fixed address with a short cache.
- [x] 5. **"Connect your site" in Settings → Developers.** Numbered steps, the
  key made in place, the snippet to copy with the store and key filled in, and
  a check that the site has called.
- [x] 6. **Docs that match.** The store API in the OpenAPI description and on
  `/docs`; a quick start; the components' reference; worked examples for plain
  HTML/JS and React, each one run.

### B. A predictable API

- [x] 7. **Errors that say what to do.** Validation errors in plain words with
  the field named; one list of codes in the docs; unknown routes point at the
  reference. The `{ error: { code, message, details } }` shape stays.
- [x] 8. **One way to page.** `limit` + `cursor` → `nextCursor` on store
  products and on `/v1/orders`, as documents and customers already do.
- [x] 9. **`Idempotency-Key` on store orders.** A retry returns the first
  answer and never orders twice.

### C. Events

- [x] 10. **More events.** `product.created`, `product.updated`,
  `product.deleted`, `stock.changed`, `order.payment_failed`, written by the
  code that makes the change (no new triggers).
- [x] 11. **A delivery log that explains.** One delivery with its payload and
  the endpoint's answer; a test delivery of any event type with a sample
  payload. The answer shown is the last attempt's: a history of every attempt
  needs a table (DECISIONS.md).

### D. A safe sandbox

- [x] 12. **Test and live kept apart.** Keys named for the environment they
  work in, a test key refused on a live store (and the reverse) with the
  reason, `test: true` on what a test store answers, test cards that come back
  to the site. Documented as it is: a business is in test or live as a whole.

### E. Security

- [x] 13. **Limits and rules.** Requests per minute per publishable key and
  visitor; exact-match origins, `Vary: Origin`, no credentials; a secret key
  sent from a web page to the store API is refused and says why (to the rest
  of the API a browser on another site never gets as far as sending one);
  replacing a key without downtime in the dashboard.

### F. A dashboard to debug with

- [x] 14. **Usage and errors per key.** Requests and failures by day, by
  endpoint and error code (counters in the existing rate-limit table), and
  the most recent requests with their answers (`/v1/developer/...`). The list
  of recent requests is kept in the server's memory; the table that would
  make it durable is written up in DECISIONS.md.
- [x] 15. **Settings → Developers as a dashboard.** Connect your site, keys
  (publishable and secret), webhooks, logs and usage, in tabs.

### G. Proof

- [x] 16. **The test site again, from the docs alone.** A fresh business, a
  fresh folder, only what `/docs` and the dashboard say; browse to checkout to
  a paid test order with its receipt.
- [x] 17. **README, DECISIONS, the full check and the browser tests.**

## How it ended

Every item is done; none was skipped. Three stop short of what was first
written, each for the same reason (no schema changes), and say so above:
item 11 (the last attempt's answer, not every attempt's), item 13 (where a
secret key from a page is refused) and item 14 (the latest requests are kept
in memory). What was deliberately left for later, and what was found and not
fixed, is in DECISIONS.md under "Connect your own site".

The proof (item 16) was run on a fresh database: a new business, a key made
in Settings → Developers → Connect your site, the lines it gives pasted into
a new page on another origin, then products → a product → the cart → the
checkout → the test card → back on the site, paid, with its receipt PDF; the
guide's check and the Logs page showed the ten requests it took.

Checks at the end (item 17), run here rather than by GitHub Actions:
`npm run check` (types, and 374 of 375 unit tests passing with one skipped as
before) and the whole browser suite, 49 of 49, the older specs included
(run on a web build in a scratch folder with `WEB_ROOT`, so the demo's
`web/dist` was left alone).

## Afterwards: the two things the no-schema rule held back

Built on 24 Nov 2026 once the go-ahead was given for the schema changes. They
finish items 13 and 14 above (and DECISIONS.md's "A durable request log" and
"Scoped secret keys").

- [x] 18. **The request log in the database** (migration 055, `api_requests`).
  It survives a restart and is the same on every server process; kept a week
  and at most the newest 10,000 per business; written in batches so no request
  waits on it; paged in the API and on the Logs page; erased with the
  business.
- [x] 19. **Secret keys that may do less** (migration 056: `access`, `areas`,
  `expires_at` on `api_keys`). Read-only keys, keys for some parts of the
  API, keys that end on a day; checked in one place by the route's address;
  existing keys unchanged. Set in the dashboard, shown in the reference.

Still not done, and why, is in DECISIONS.md: a history of every attempt of a
webhook delivery, test data inside a live business, a test or live mark in a
secret key's own text.

Checked the same way as before: `npm run check` (types, 383 of 384 unit tests
passing, one skipped as before) and the whole browser suite, 49 of 49.
