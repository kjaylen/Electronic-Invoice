# Decisions: offline-first tills

Judgment calls, server changes, and what could not be done. Newest at the
bottom of each part.

## How the work is organised

- **Files.** The brief asks for `PLAN.md` and `DECISIONS.md`. The repository's
  root already has those two files for the site builder work, and another
  session is working in the main folder right now, so this work's plan and
  decisions live in `docs/offline-tills/` instead of overwriting theirs.
- **A separate worktree and branch.** Another session ("Refine the external
  site integration") is running in the main checkout. This work is on the
  branch `offline-first-tills` in its own folder, so neither session's
  uncommitted changes get mixed into the other's commits. It is merged into
  `main` at the end.
- **The brief's blanks.** The brief had placeholders. Filled in from the
  project: the stack is one web app (React, TypeScript) bundled into Electron
  (desktop) and Capacitor (Android, iOS); customers are shops in Belize, often
  on unreliable internet; outages are assumed to last minutes to days. Offline
  must cover ringing up sales, cash, printing receipts, looking up products and
  prices, opening and closing the till, cash in and out, and holding sales.
  Acceptable to need a connection: pairing a till, refunds (credit notes), tax
  invoices and sales on account, gift cards, loyalty points, emailing receipts,
  reports, editing the catalog, the time clock. Offline sessions expire after
  7 days.
- **A reversal of an earlier choice.** On 22 Nov 2026 the user had chosen
  online-only tills because every receipt is verified by BTS. This brief
  brings offline back; the BTS manual allows it for Tax Receipts through
  subsequent authorization (operMode 3), which is what this uses.

## The design

- **All three platforms share one engine.** The tills are the same bundled
  web app, so the local store, the local API, the sync engine and the
  sign-in logic are written once in `web/src/pos/offline/` and behave
  identically everywhere. Only secure key storage is per platform.
- **A local API under unchanged screens.** The till already sends every
  request through one transport (`setTillTransport`). That transport now
  answers the till's requests from the device (items, customers, totals,
  sales, print views, held sales, shifts, the business profile) and passes
  the rest to the server. The counter and shift screens, shared with the web
  app, keep working without a rewrite.
- **Every till receipt is local-first, online or not.** The brief says the
  server is never in the critical path of a sale, so a till's Tax Receipt is
  numbered, saved and printed on the device every time, then uploaded
  (within seconds when online). The cost: till receipts print "Pending of BTS
  authorization" (operMode 3) instead of BTS's authorization protocol, even
  when online. The manual allows operMode 3 for Tax Receipts in normal
  operation. The web counter (in the browser) is unchanged and still issues
  with previous authorization.
- **Numbering: a series per install.** Each install of the till (a fresh
  local database) gets its own series (101 to 899) from the server, never
  given to anyone else, and counts serials from 1 on the device. Two tills can
  never produce the same number, and a reinstalled or wiped till cannot reuse
  numbers it may already have printed. The first start after pairing (or after
  the local data is lost) needs a connection to get its series.
- **The ETDUI is made on the device.** It is fully determined by the type, TIN,
  series, serial, date, time, operMode, environment and a random security
  code, so the printed receipt carries its final ETDUI and QR code. The server
  signs the XML with exactly those values when the sale arrives.
- **Uploads use the till's device token, not a person's session.** Sales
  carry the id of the person who sold; the till vouches for it, as it does
  today for everything signed in on it. This lets a till catch up even when
  nobody is signed in, and after a session expired offline.
