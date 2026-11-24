# Plan: offline-first tills

The tills (desktop: Electron, `apps/desktop`; Android and iOS: Capacitor,
`apps/mobile`) all run the same bundled web app (`web/src/pos`, built into
`web/dist/pos.html`). Today every screen asks the server for its data and
every sale goes through `POST /v1/documents`, which numbers, signs and sends
the receipt to BTS before the cashier can print it; without a connection the
till shows "Cannot reach the server". This plan makes the till sell through
an outage and catch up afterwards.

Status marks: `[ ]` to do, `[x]` done, `[-]` skipped (reason in DECISIONS.md).
Decisions and judgment calls: [DECISIONS.md](DECISIONS.md).

## Where the till depends on the server today (read end to end, 24 Nov 2026)

| Area | Today | Offline plan |
|---|---|---|
| Screens and layouts | Bundled in each app already (`web/dist` copied into Electron and Capacitor). | Nothing to change. |
| Pairing | `POST /v1/pos/pair` with a code; device token kept in Electron's encrypted store or Capacitor Preferences (plain). | Still needs a connection (one-time). Token moves to the platform's secure storage. |
| Till info and people | `GET /v1/pos/till` on every start; failure shows "Cannot reach the server". | Cached; the lock screen works from the cache. |
| Sign-in | `POST /v1/pos/sign-in` with a PIN. | Online as today, which also stores a local PIN verifier; offline sign-in for people who signed in here before (7 days). |
| Business profile (`/v1/me`) | Fetched every 30 s; the counter needs it (certificate, discount limit, loyalty). | Cached copy. |
| Catalog, categories, quick buttons, customers | `/v1/items`, `/v1/items/categories`, `/v1/customers`. | Local catalog, refreshed in the background. |
| Totals preview | `POST /v1/documents/preview` (server tax engine). | The same engine (`src/engine/calc.ts`) runs on the device. |
| Selling a receipt | `POST /v1/documents`: server numbers, signs, sends to BTS. | Written on the device first (own series and serial, operMode 3), printed, queued, uploaded. |
| Printing | `GET /v1/documents/:id/view`, then ESC/POS or the system printer. | The device builds the same view for its own sales; the logo is cached. |
| Held sales | `/v1/held-sales` on the server. | On the device. |
| Shifts (open, cash in/out, close, report) | `/v1/shifts/*`. | On the device first, events queued and uploaded. |
| Sales list, reprint, email, refunds | `/v1/documents*`. | Local sales listed and reprinted offline; email and refunds need a connection. |
| Gift cards, loyalty points, sales on account (invoices) | Checked or issued on the server. | Need a connection; disabled with an explanation when offline. |
| Time clock | `/v1/timeclock`. | Needs a connection; explained when offline. |
| Heartbeat | Every 5 minutes. | Unchanged (skipped while offline). |

## Work, top to bottom

### 1. Server: what sync needs (backward compatible)
- [x] Migration: a series purpose `offline`; a table of series given to tills (one per install, never reused).
- [x] `GET /v1/pos/snapshot?install=<id>` (device token): business, receipt header, tax settings, items, categories, customers, people, the till's register, its offline series and next serial, the QR address, the logo.
- [x] `POST /v1/pos/sync` (device token): ordered events (sale, shift open, cash in/out, shift close), each with a device-made UUID. Applying one twice returns the first result. Sales keep the device's number, time, ETDUI and prices, and are sent to BTS under subsequent authorization (operMode 3); a completed sale is never refused for price, product, customer or stock changes.
- [x] Negative stock after an offline sale is flagged (activity log and in the sync reply).
- [x] Server tests for both endpoints.

### 2. Device: local store and catalog (shared web code)
- [x] IndexedDB store with AES-GCM encryption; the key kept in the platform's secure storage (desktop: Electron safeStorage; Android: Keystore; iOS: Keychain; browser: a non-extractable key).
- [x] Device token moved to secure storage.
- [x] Catalog sync: the snapshot on start, every few minutes while online, and after each upload.

### 3. Device: local-first selling
- [x] Shared engine in the browser: `calc.ts`, `decimal.ts`, `etdui.ts` (Web Crypto for the security code).
- [x] A local API for the till's screens: items, customers, preview, sale, sale list and detail, print view, held sales, shifts, `/v1/me`; everything else goes to the server when online and says plainly when it needs a connection.
- [x] A sale is one atomic, durable write: the sale, its outbox entry and the next serial. Printing happens after it is saved.
- [x] Receipt numbering: the till's own series (one per install) and a local serial; never collides across devices.
- [x] Payments: cash, card (on the separate terminal), transfer and split work offline; gift cards, points and on-account invoices are disabled offline with a reason.

### 4. Device: sync engine
- [x] Uploads the outbox oldest first, in batches, with exponential backoff and jitter; one uploader at a time (Web Locks); resumes after restarts and crashes.
- [x] Never uploads the same sale twice in effect: device UUIDs plus idempotent server endpoints; a sale is marked synced only from the server's reply.
- [x] Permanent failures are kept (never dropped), shown with the reason, and retried by a manager.

### 5. Device: sign-in, status, sync screen
- [x] Offline sign-in with a local PIN verifier (PBKDF2) for people who signed in on this till before; expires after 7 days without an online sign-in; five wrong PINs lock that person for 15 minutes.
- [x] Status indicator: online, offline or syncing, and unsynced sales; replaces the "Cannot reach the server" screen and the "no connection" banner.
- [x] Sync screen for managers: pending, failed and why, synced recently; retry now.
- [x] Unpairing with unsynced sales is refused while they exist (locking or signing out keeps them: they are on the device and go up with the till's own token).

### 6. Tests
- [x] Sync engine: offline sale then reconnect; connection dropping mid-upload; app killed mid-sale; duplicate uploads; two devices selling the same item offline; a long offline period with many sales. (`e2e/offline.spec.ts`, in a real browser against the server; duplicates also in `test/pos-sync.test.ts`.)
- [x] Server: idempotency, ordering, conflicts (price changed, product deleted, stock run out, customer deleted).

### 7. Platforms and the end-to-end check
- [x] Desktop: build, then offline: sign in, several sales, restart, reconnect, every sale on the server exactly once. (`apps/desktop/scripts/offline-check.mjs` with the server really stopped; passed on the source and on the packaged app, `Floreo-Till-Setup-1.0.0.exe`.)
- [x] Android: secure storage in the plugin (Keystore), build, the same check where it can be run. (`apps/mobile/scripts/offline-check.mjs` on an emulator, Android API 37, the debug APK; passed.)
- [x] iOS: secure storage in the plugin (Keychain).
- [-] iOS: build and check. No Mac or Xcode here (see DECISIONS.md).
- [x] README, Spanish, commits.
