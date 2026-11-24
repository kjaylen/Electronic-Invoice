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
- **Ids from the device make every upload idempotent.** A receipt's document
  id is the UUID the till gave the sale; a shift and a cash movement keep the
  till's UUIDs as their primary keys; every event is also written to
  `pos_sync_events` in the same transaction as what it did. Sending an event
  again (a lost answer, a retry after a crash, two uploads at once) returns
  its first result and changes nothing.
- **Stock and points go with the event, not with the document.** The
  document is stored and sent to BTS first (its own transaction, then the BTS
  call, which must not hold a transaction open); its stock movements, loyalty
  points and negative-stock flag are written with the event's
  `pos_sync_events` row in a second transaction. If the server stops between
  the two, the till sends the sale again: the first step finds the document,
  the second runs. Nothing is recorded twice and nothing is lost.
- **Events are applied in order; only what may pass later holds the rest
  back.** A failure the server marks retryable (no certificate yet, the
  database busy) stops the batch, so receipts keep their order in the series'
  hash chain. A failure no retry can fix (the event itself is wrong, a series
  never given to the business, an environment switch) is reported, set aside
  on the till for a manager, and the rest go on. Set-aside events are never
  deleted by the till; the sync screen shows why and can try them again.
- **What changed since a sale was made never refuses it.** A product, a
  customer or a person deleted since, a price changed since: the sale is
  stored exactly as printed, without the missing link, and the reply carries a
  warning shown on the sync screen. Stock may go below zero; when it does the
  activity log gets a `stock.negative` entry and the sync screen says
  "count it".
- **A till removed and added again still sends its old sales.** The series
  check accepts any series given to a till of the same business, not only to
  the device sending it: a manager who removes a till and adds it back gives
  it a new device id, and the sales it made before must still go up. Removing
  a till, or a till finding out it was removed, never deletes unsent sales:
  the app refuses to unpair with anything unsent and shows a "pair again"
  screen instead of wiping.
- **A shift opened offline closes an older one still open on the drawer.**
  The till's drawer belongs to the till. When a till uploads a shift and the
  server still has one open on that drawer (or by that person elsewhere), the
  server closes the old one at the new one's opening time, uncounted, with a
  note saying why, and the reply warns. A shift a till opened before this
  version (already open on the server) is carried on: the snapshot includes
  it, and the till's report adds what it sells to the server's report at that
  moment.
- **A shift's number comes from the server.** Shift numbers are per business,
  so a till cannot make one up offline; until the server has the shift the
  screens say "New shift", then show its number.
- **Time: the server's clock.** Receipts are dated with the device's clock
  corrected by the server's (from the snapshot and the `Date` header of every
  reply), so a till with a wrong clock prints the right time. Differences
  under 90 seconds are ignored (the header has whole seconds).
- **Signing in offline.** A person who signs in on a till while it is online
  can sign in there with the same PIN for 7 days without a connection. The
  till keeps a PBKDF2-SHA256 verifier of the PIN (210,000 iterations, random
  salt), encrypted, never the PIN. Five wrong PINs lock that person out of the
  till for 15 minutes (counted on the till). A PIN changed on the server, a
  person removed, or one whose PIN was cleared is forgotten at the next
  snapshot. Someone signed in offline cannot use what needs the server until
  the server has checked their PIN: the till does that in the background as
  soon as it is back (the PIN is held in memory only, while signed in), and
  locks the till if the PIN was changed meanwhile.
- **What works offline, and what needs the server.** Offline: selling Tax
  Receipts paid by cash, card on a separate terminal, or transfer (or split
  between them), customer lookup and TINs on receipts, discounts within the
  cashier limit, printing and reprinting the till's receipts, the cash drawer,
  shifts (open, cash in and out, close, X and Z reports), holding and
  recalling sales, the sales list. Needs the server, refused offline with the
  reason on screen: gift cards (the balance is on the server), loyalty points
  (the balance), sales on account (credit check and invoice numbering),
  refunds (a credit note goes to BTS first), cancelling, emailing a receipt,
  the time clock. When the server is back, these work again without a restart.
- **Card payments.** The till records card payments taken on a separate card
  terminal; it does not authorize cards itself. Recording one needs no
  connection, so it works offline (the terminal may need its own).
- **Plan limits are not checked on offline uploads.** A completed sale must
  never be refused, so a business over its plan's monthly limit still gets
  its till's receipts stored; the limit applies when it next issues online.
- **Unsynced sales and updates.** The local database (IndexedDB) and its key
  survive app updates on all three platforms. On Windows the installer keeps
  the app's data when it is uninstalled, so a reinstall still has unsent
  sales. On Android and iOS uninstalling an app deletes its data; that cannot
  be prevented, so the till refuses to unpair with unsent sales and the
  indicator always shows how many are waiting.
- **Local data is encrypted.** Every record with business data (the catalog,
  customers, sales, shifts, held sales, remembered PINs, the outbox) is
  sealed with AES-256-GCM. The key is made once per install and kept in the
  platform's secure storage: Electron safeStorage on desktop (DPAPI on
  Windows), the Android Keystore, the iOS Keychain (this device only). The
  till's own token moves to the same secure storage. A browser at /pos has no
  secure storage; there the key is a non-extractable Web Crypto key.
- **The snapshot is fetched with the till's token.** Items, prices and
  customers reach the device without a person signed in, so the till can sell
  right after starting offline. The same data is kept on the device anyway
  (encrypted), and a manager can remove the till (and its token) at any time.
- **Receipt status on the till.** A receipt the server has not seen yet shows
  "Saved on the till, not sent yet" (`on_till`, a status only the till uses);
  once sent it shows the server's status (normally "Authorized").
- **No new dependencies.** IndexedDB, Web Crypto and Web Locks are built into
  every platform's web view. The engine tests run in a real browser
  (Playwright, already used) instead of adding an IndexedDB stand-in for
  Node.

## Found while testing

- **A restored cart could bring back an old sale's key (fixed).** The
  counter keeps the sale in progress on the device, under the business and
  the person. Before either was known it saved it under no one, and after a
  restart it restored that copy, with the idempotency key of the first sale
  ever made there. The next sale was then answered with that old receipt and
  never made: a lost sale. Now the counter keeps nothing until it knows who
  is selling, the till shows the counter only once it does, and the till's
  duplicate check matches a repeat by its key *and* its contents (a hash of
  the sale), so a different sale under an old key is a new sale. The web
  counter shares the fix.
- **The browser till opens without the server.** The desktop and mobile apps
  carry the till inside them. A till in a browser at /pos is a page from the
  server, so it now registers the service worker, which keeps the till's page
  and files (apart from the main app's) and serves them when the server
  cannot be reached.
- **Retries at most 2 minutes apart.** When the server itself is down (the
  network is fine, so the device never says it went offline and back), the
  till only finds out the server is back at its next try. Backoff tops out at
  2 minutes (with ±20% randomness), not 5.
- **The browser tests' database is per run.** The e2e server drops and
  recreates its database at the start of a run; another checkout's run did
  that to this one's halfway through. `E2E_DB` (with `E2E_PORT` and
  `E2E_BTS_PORT`) gives a run its own database and ports.

## Server changes (all backward compatible)

- Migration `054_offline_tills.sql`: the series purpose `offline`; the table
  `pos_offline_series` (which series each install of a till got); the table
  `pos_sync_events` (every event a till uploaded and its first result).
- `GET /v1/pos/snapshot?install=` and `POST /v1/pos/sync`, with the till's
  device token (`src/api/pos-sync.ts`).
- `issueOfflineReceipt` in the pipeline: stores a till's receipt with its own
  id, series, serial, time and ETDUI (operMode 3) and sends it to BTS, or
  queues it for subsequent authorization.
- The series' next serial never goes back (`greatest`), so a late upload
  cannot rewind it.
- The engine's security code uses Web Crypto, and the printed-copy types and
  texts moved to `src/engine/print-view.ts`, so the till builds the same
  printed copy as the server (a test checks they are equal field by field).
- Nothing else changes for existing clients: the web app, the API, and older
  till versions keep working as before.

## Could not be done here

- **iOS was not built or run.** Building an iOS app needs macOS and Xcode;
  this machine runs Windows. The Keychain methods (`secretGet`, `secretSet`,
  `secretRemove` in `ios/App/App/TillHardwarePlugin.swift`) are written
  against the same plugin interface as Android's and use only the standard
  Security framework calls, but they have not been compiled. Everything else
  on iOS is the same web code that was tested in the desktop app, Android
  and a browser.
