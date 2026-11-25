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

## Where it stands

Every item below is done. What was left out, and why, is in DECISIONS.md
("Restaurants, bars and hotels": Skipped, Blockers).

- **Server**: `src/venue/` (`check.ts` reducer, `bill.ts` splits,
  `pricing.ts`, `settings.ts`, `service.ts` operations and tickets,
  `station-tickets.ts`, `tax-rules.ts`, `room-charge.ts`), `src/api/`
  (`venue.ts` setup and operations; `venue-floor.ts` reservations, waitlist,
  guests, day close, checkout, tips, reports, tax rules; `hotel.ts`).
  Migrations 063 to 066.
- **Screens**: `web/src/venue/` (`store.ts` the device's queue of operations,
  `Floor.tsx`, `Order.tsx`, `Kitchen.tsx`, `Host.tsx`, `Hotel.tsx`,
  `Reports.tsx`, `Setup.tsx` under Settings → Venue, `handoff.ts` to the
  counter, `tickets.ts`). The till app has Floor and Kitchen tabs. Spanish
  for all of it; Chinese for the floor, the order and the kitchen.
- **Tests**: `test/venue-check.test.ts` (the reducer, splits, concurrency),
  `venue-api.test.ts`, `venue-floor.test.ts` (scenarios 1 and 2),
  `hotel.test.ts` (scenario 3); in a browser `e2e/venue.spec.ts` (table
  service, no connection, the bar) and `e2e/hotel.spec.ts` (the stay, the
  host stand).
- **Not merged, not pushed.** The branch sits on top of `pos-platform`.

## Build order

### 0. Groundwork
- [x] 0.1 PLAN.md, TAX-RULES.md, ETD-MAPPING.md
- [x] 0.2 `tenants.venue`, the switch in Settings, roles and permissions (A4)

### A. Venue setup
- [x] A1 Areas and floor plans, drag and drop, alternative layouts
- [x] A2 Service periods and menus (hours, prices, automatic, override)
- [x] A3 Stations and routing (printer, screen, fallback)
- [x] A4 Roles, PIN switching, sections

### B. Menu
- [x] B5 Modifier groups and rules; combos; notes
- [x] B6 Allergens and dietary tags
- [x] B7 Sold out ("86") with a countdown
- [x] B8 Recipes by measure; waste and spillage

### C. Table service
- [x] C9 Live floor view
- [x] C10 Seating, seats
- [x] C11 Ordering: modifiers, courses, hold and fire, repeat round
- [x] C12 Move, merge, split, transfer
- [x] C13 Voids, comps, discounts with supervisor PIN and reasons
- [x] C14 Pre-bill; split evenly, by seat, by item, shared items

### D. Bar
- [x] D15 Tabs by name, seat or room; list with age; shift-end warning
- [x] D16 Quick sale
- [x] D17 Happy hour, two-for-one, bundles

### E. Kitchen and bar production
- [x] E18 Tickets, follow-ups for changes and voids
- [x] E19 Kitchen display: cards, ageing, bump, recall, all-day, expediter
- [x] E20 Ready back to the floor

### F. Reservations and waitlist
- [x] F21 Reservations, timeline, clashes, deposit, confirmations, no-shows
- [x] F22 Waitlist
- [x] F23 Guest records

### G. Payments and closing
- [x] G24 Tenders: US$, charge to room, house account, mixed
- [x] G25 Service charge rules; tips per server; pooling report
- [x] G26 Server checkout report
- [x] G27 End of day and the business date

### H. Hotel
- [x] H28 Room types, rooms, rate plans
- [x] H29 Reservations and the availability calendar
- [x] H30 Front desk
- [x] H31 Guest folio
- [x] H32 Housekeeping
- [x] H33 Night audit

### I. Tax
- [x] I34 Dated tax configuration; TAX-RULES.md
- [x] I35 ETD mapping implemented as written

### J. Reports
- [x] J36 Hospitality reports

### Proof
- [x] P1 Automated tests the brief lists
- [x] P2 Scenario 1 (restaurant), 2 (bar), 3 (hotel), end to end
- [x] P3 Full unit and browser suites; README, DECISIONS, summary
