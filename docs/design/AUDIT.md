# Till audit: before and after

Screenshots of every till screen, at four sizes, made by `node scripts/pos-shots.mjs` against the
browser tests' business:

| Size | Viewport | Before | After (light / dark) |
|---|---|---|---|
| Phone | 390×844, touch | `before/phone/` | `after/light/phone/`, `after/dark/phone/` |
| 8-inch tablet | 800×1280, touch | `before/tablet-8in/` | `after/light/tablet-8in/`, `after/dark/tablet-8in/` |
| 10–15-inch till | 1366×768, touch | `before/till-15in/` | `after/light/till-15in/`, `after/dark/till-15in/` |
| Desktop | 1440×900, mouse | `before/desktop/` | `after/light/desktop/`, `after/dark/desktop/` |

Files are numbered in the same order in each folder (00 pairing … 24 sync), so a before and its
after sit side by side.

## What was wrong (before)

| Screen | Problem |
|---|---|
| Everywhere | Button sizes mixed (32 to 56px); text down to 11px; four typefaces (Inter, Inter Tight, Geist Mono, system); colours written by hand; keyboard hints shown on touch screens; no dark theme. |
| Status bar | Tabs as small text; the connection as a dot and words only on wide screens; no printer, no time; "Lock" in words only. |
| Sign-in | Small staff buttons; the PIN pad's keys 56px, a "←" and "✓" as text. |
| Sale | The order on a dark purple panel: Subtotal, GST and US$ labels nearly invisible (rgba white at 60–78%). The lines limited to 46% of the height, the Pay button below the fold at 1366×768. Tiles without stock. Quantity buttons 30px. |
| Sale, phone | The page scrolled sideways; Pay far down; quantity buttons wrapped away. |
| Payment | Cash received a small field; change in body-size text; quick amounts 28px. |
| Success | A small card at the bottom of the products column. |
| Sales | 48px rows, dates as year-month-day, no filters. |
| Refund | A table with 5rem quantity fields; the reason always typed; a select for how it is paid back. |
| Floor | The plan overflowed at 1366×768; the legend off-screen; table text 10–12px; no seats, no icons (colour alone told the states apart); no zoom; no list view; no way to move a party but More → Move → pick. |
| Choices | Options as small chips; nothing said a group was required until Add was refused; no price as chosen. |
| Settings | Checkboxes; no way to choose a theme or feedback. |

## Tap counts (five main flows)

Counted from the sale screen (or the floor, for tables), signed in.

| Flow | Before | After | Notes |
|---|---|---|---|
| 1. Three-item cash sale, exact money | 3 tiles + Issue = **4**, and a scroll to Issue at 1366×768 and on phones | 3 tiles + Pay = **4**, no scrolling | Pay is pinned at every size and shows the amount. With a quick cash amount: 5 before (plus the scroll), 5 after. |
| 2. Card sale, one item | tile + Card + Issue = **3** | tile + Card + Pay = **3** | |
| 3. Switch user | Lock + name + 4 digits + ✓ = **7** | Switch user + name + 4 digits + ✓ = **7** | One button in the status bar, with the person's initials. |
| 4. Table order with a required choice | table + Open + item + choice + Add + item + Send = **7** | the same **7** | The required group is marked before Add; Add shows the price. |
| 5. Refund a sale | Sales + sale + Refund + type a reason (3+ keys) + Issue = **4 taps and 3+ keystrokes** | Sales + sale + Refund + a reason + Issue = **5 taps, no typing** | Typing is still there for another reason. |
| (6.) Close the shift | Shift + Close shift + count + Close = 3 and typing | the same | The shift bar on the sale screen also has Close shift. |
| Move a party to another table | table + More + Move + table = **4** | hold and drag + Move = **2** | The old way is still there too. |

No flow takes more taps or keystrokes than before.

## How each screen is checked

- Unit tests: `npm test`.
- Browser tests: `npm run e2e` (the till: `app.spec.ts`, `offline.spec.ts`, `venue.spec.ts`, including the floor's legend, actions, drag to move, filters and list, and the layout editor).
- Screenshots: `node scripts/pos-shots.mjs --phase after --theme light|dark` against `node e2e/view.ts`.
- Contrast: `node scripts/pos-contrast.mjs`.
- On the real apps: `node scripts/till-flows.mjs --app desktop` (the packaged app) and `--app android` (the installed debug app on an emulator or phone) pair a new till and do a three-item cash sale (checking Pay is on screen without scrolling), a refund with a one-tap reason, a table order for two seats paid seat by seat, and closing the shift. Both pass. On Android, screenshots come from the device itself (`adb screencap`); the app is started on the built-in screen, since an emulator can have a second display.
