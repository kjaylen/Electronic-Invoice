# Plan: the hospitality module (restaurants, bars, hotels)

Started 25 Nov 2026 on branch `hospitality` (cut from `pos-platform`, not yet
merged), in the worktree `../eInvoicing-pos`. The earlier plan is in
`docs/plans/2026-11-pos-platform.md`. Choices are logged in DECISIONS.md;
tax values in TAX-RULES.md; which tax document when in ETD-MAPPING.md.

## What was found in the code (the brief's blanks)

- **Stack**: Fastify + PostgreSQL (`src/`, TypeScript run by Node), React +
  Vite (`web/`). The desktop (Electron), Android and iOS (Capacitor) apps all
  run the same web till, `web/src/pos`. One screen built in `web/` is the
  same screen on all three.
- **Already there** from the POS work: tables as named held sales, order
  tickets per station by category, split by item, service charge per line,
  tips beside the sale, US$ cash at 2:1, wallet, layaway, locations, recipes
  in the shape of bundles (`item_components`, decimals allowed).
- **Offline**: the till is offline-first: it issues receipts itself and
  syncs (`web/src/pos/offline/local.ts` answers `/v1/...` calls locally).
- **Manual**: BTS Orientation Manual v1.30; it is not in the repository
  (the README's "Settled by the manual" is the working copy of its rules).
- **Customers / other tenders**: taken as restaurants, bars and small hotels
  serving tourists; the local tender is the mobile wallet.

## Architecture (read this first after a break)

- **Switch**: `tenants.venue jsonb` = `{ restaurant, bar, hotel, ...settings }`
  (`src/venue/settings.ts`). `GET /v1/me` carries `venue`. Nothing below
  shows or runs for a business with all three off.
- **A check is an operation log.** `src/venue/check.ts` is a pure reducer
  shared by the server and the web app: `apply(check, op)`. Ops have a
  client-made id; applying one twice does nothing. The server stores ops in
  `venue_ops` (a sequence per business) and the folded check in
  `venue_checks.state`. Devices apply ops locally at once, queue them, post
  them (`POST /v1/venue/ops`) and read everyone else's
  (`GET /v1/venue/changes?since=`), every two seconds.
- **The concurrency rule**: items have their own ids, so two people adding
  never collide; every op is per item; an item goes to the kitchen once (the
  first `fire` that reaches the log sends it; later ones skip it); the server's
  answer says what each op really did, and tickets print from that.
- **Paying** hands the chosen items to the existing sale (the counter's
  cart), so every tender, US$, tips, the receipt, BTS and the offline till
  work as they do for a shop. When the receipt is issued an op marks the
  items paid.
- **Kitchen**: `venue_tickets` is the print queue and the kitchen screen's
  source: one row per station per send, printed by the device that hosts the
  station's printer, shown failed to the server who sent it, retried,
  re-routed to the fallback.
- **Hotel** is server-side and online: rooms, bookings, folios, housekeeping,
  night audit (`src/venue/hotel.ts`).
- **Web**: `web/src/venue/*` (Floor, Order, FloorEditor, MenuSetup, Kitchen,
  Reservations, Tabs, Hotel*, VenueReports). Spanish in `es.ts`, Chinese for
  the service screens in `zh.ts`.

## Where it stands (update as you go)

- **Server: done and tested** for every section (A to J). Files: `src/venue/`
  (`check.ts` reducer, `bill.ts` splits, `pricing.ts`, `settings.ts`,
  `service.ts` ops + tickets, `tax-rules.ts`, `room-charge.ts`), `src/api/`
  (`venue.ts` setup + ops, `venue-floor.ts` reservations, waitlist, guests,
  day close, checkout, tips, reports, tax rules; `hotel.ts`). Migrations 063
  to 066. Tests: `test/venue-check.test.ts` (pure), `venue-api.test.ts`,
  `venue-floor.test.ts` (scenarios 1 and 2), `hotel.test.ts` (scenario 3),
  helpers in `test/venue-helpers.ts`.
- **Web: to build** in `web/src/venue/` (the same screens run in the web
  app and in the till app on desktop, Android and iOS): the store (local-first
  ops queue), Floor, Order, Pay hand-off to the counter, FloorEditor, MenuSetup,
  Kitchen, Reservations, Hotel, VenueReports, Settings; Spanish; browser tests.

## Build order

### 0. Groundwork
- [ ] 0.1 PLAN.md, TAX-RULES.md, ETD-MAPPING.md
- [ ] 0.2 `tenants.venue`, the switch in Settings, roles and permissions (A4)

### A. Venue setup
- [ ] A1 Areas and floor plans, drag and drop, alternative layouts
- [ ] A2 Service periods and menus (hours, prices, automatic, override)
- [ ] A3 Stations and routing (printer, screen, fallback)
- [ ] A4 Roles, PIN switching, sections

### B. Menu
- [ ] B5 Modifier groups and rules; combos; notes
- [ ] B6 Allergens and dietary tags
- [ ] B7 Sold out ("86") with a countdown
- [ ] B8 Recipes by measure; waste and spillage

### C. Table service
- [ ] C9 Live floor view
- [ ] C10 Seating, seats
- [ ] C11 Ordering: modifiers, courses, hold and fire, repeat round
- [ ] C12 Move, merge, split, transfer
- [ ] C13 Voids, comps, discounts with supervisor PIN and reasons
- [ ] C14 Pre-bill; split evenly, by seat, by item, shared items

### D. Bar
- [ ] D15 Tabs by name, seat or room; list with age; shift-end warning
- [ ] D16 Quick sale
- [ ] D17 Happy hour, two-for-one, bundles

### E. Kitchen and bar production
- [ ] E18 Tickets, follow-ups for changes and voids
- [ ] E19 Kitchen display: cards, ageing, bump, recall, all-day, expediter
- [ ] E20 Ready back to the floor

### F. Reservations and waitlist
- [ ] F21 Reservations, timeline, clashes, deposit, confirmations, no-shows
- [ ] F22 Waitlist
- [ ] F23 Guest records

### G. Payments and closing
- [ ] G24 Tenders: US$, charge to room, house account, mixed
- [ ] G25 Service charge rules; tips per server; pooling report
- [ ] G26 Server checkout report
- [ ] G27 End of day and the business date

### H. Hotel
- [ ] H28 Room types, rooms, rate plans
- [ ] H29 Reservations and the availability calendar
- [ ] H30 Front desk
- [ ] H31 Guest folio
- [ ] H32 Housekeeping
- [ ] H33 Night audit

### I. Tax
- [ ] I34 Dated tax configuration; TAX-RULES.md
- [ ] I35 ETD mapping implemented as written

### J. Reports
- [ ] J36 Hospitality reports

### Proof
- [ ] P1 Automated tests the brief lists
- [ ] P2 Scenario 1 (restaurant), 2 (bar), 3 (hotel), end to end
- [ ] P3 Full unit and browser suites; README, DECISIONS, summary
