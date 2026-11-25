# The till design system

The till apps (desktop, Android, iOS and `/pos` in a browser) all run `web/src/pos`. This is the
system their screens are built from. It lives in `web/src/pos/design/`. Everything is scoped to
`body.till-body`, so the web app keeps its own look.

| File | What it holds |
|---|---|
| `tokens.css` | Colour, type, spacing, sizes, radii, elevation, focus and motion, in light and dark |
| `components.css`, `components.tsx` | The components and all their states |
| `icons.tsx` | One icon set, drawn for Floreo (20×20, 1.75 stroke). No third-party icons. |
| `table.tsx`, `floor.css` | Tables on the floor plan, the floor screen |
| `sell.css` | The sale screen and payment |
| `screens.css` | Lists, sheets, forms, settings, the choices dialog |
| `order.css` | A table's order screen |
| `theme.ts` | Light, dark or the device's own, kept per device (`till.theme`) |
| `feedback.ts` | Vibration and an optional soft click on key taps, chosen per device |
| `Gallery.tsx` | Every component in every state (development only: `npm run web:dev`, then `/pos.html?gallery`) |

Screenshots of the gallery: `docs/design/gallery-light.jpg`, `docs/design/gallery-dark.jpg`
(`node scripts/pos-gallery-shots.mjs` with the dev server on :5181).

## Rules

- **No styling outside the system.** Screens use tokens (`var(--pos-…)`) and components. A colour,
  size or duration written by hand in a screen is a bug.
- **Colour is never the only signal.** Every state has a word and an icon too: table states,
  badges, banners, the connection pill, sold out (struck through and labelled), required choices.
- **Targets:** 48px for anything tappable, 64px for selling actions (Pay, Send, product tiles are
  88px), 8px between targets (`--pos-gap-target`).
- **Feedback within 100ms:** every button has a pressed state that shows in the next frame
  (`:active`, a 97% scale within 60ms). Key actions also vibrate where the device can.
- **Motion:** 150–250ms (`--pos-quick` 150ms, `--pos-move` 220ms), and none at all under
  `prefers-reduced-motion`.
- **One typeface:** Inter (SIL Open Font License, already bundled), with tabular numerals for every
  amount (`font-variant-numeric: tabular-nums`, class `num`).
- **Text sizes:** 16px body, never under 14px (`--pos-text-xs`) anywhere, the floor included.
- **8-point grid:** spacing `--pos-1` to `--pos-8` is 4, 8, 12, 16, 24, 32, 48, 64px.
- **Money:** `BZ$` with two decimals (`bz()`); dates day-month-year (`dmy()`); English and Spanish
  (`web/src/es.ts`).

## Tokens

| Group | Tokens |
|---|---|
| Brand | `--pos-brand` (#6d2d93 light, #8c55c4 dark), `-pressed`, `-soft`, `-line`, `-text`, `--pos-on-brand` |
| Neutrals | `--pos-bg`, `--pos-surface`, `--pos-surface-2`, `--pos-surface-3`, `--pos-border`, `--pos-border-strong`, `--pos-text`, `--pos-text-2`, `--pos-text-muted` |
| Status | `--pos-success`, `--pos-warning`, `--pos-danger`, `--pos-info`, each with `-soft`, `-line` and `-text` |
| Status bar | `--pos-bar`, `--pos-on-bar`, `--pos-on-bar-muted` |
| Tables | `--pos-t-<state>`, `-ink` and `-edge` for each of the eight states; `--pos-plan`, `--pos-plan-grid`, `--pos-plan-wall`, `--pos-plan-fixture` |
| Type | `--pos-font`; `--pos-text-xs` 14px, `-sm` 15, `-md` 16, `-lg` 18, `-xl` 22, `-2xl` 28, `-3xl` 36, `-4xl` 56; weights regular, medium, bold |
| Space and size | `--pos-1`…`--pos-8`; `--pos-target` 48px; `--pos-target-lg` 64px; `--pos-gap-target` 8px |
| Shape and depth | `--pos-radius-sm`, `--pos-radius`, `--pos-radius-lg`, `--pos-radius-pill`; `--pos-elev-0`…`--pos-elev-3`; `--pos-focus` |
| Motion | `--pos-press`, `--pos-quick`, `--pos-move`, `--pos-ease` |

The shared tokens the counter and dialogs use (`--paper`, `--sheet`, `--ink`, `--brand`…) are mapped
onto these inside the till, so shared screens follow the theme.

### Contrast (WCAG AA)

Checked by `node scripts/pos-contrast.mjs`, which reads `tokens.css`. Every pair passes in both
themes:

| Pair | Needs | Light | Dark |
|---|---|---|---|
| Body text on panels | 4.5:1 | 18.4:1 | 15.7:1 |
| Secondary text on panels | 4.5:1 | 11.2:1 | 11.5:1 |
| Muted text on panels / background / insets | 4.5:1 | 6.7 / 5.9 / 6.3 | 6.9 / 7.7 / 6.4 |
| Primary button text | 4.5:1 | 8.6:1 | 5.0:1 |
| Brand text (links, quiet buttons) | 4.5:1 | 10.6:1 | 8.8:1 |
| Status bar text / secondary | 4.5:1 | 16.6 / 9.4 | 17.9 / 8.9 |
| Field edges | 3:1 | 3.2:1 | 3.8:1 |
| Focus ring | 3:1 | 8.6:1 | 3.5:1 |
| Success, warning, danger, info text on their soft backgrounds | 4.5:1 | 6.5–7.0 | 8.5–10.5 |
| Status icons on panels | 3:1 | 4.2–6.1 | 5.8–8.1 |
| Table text on each state's fill | 4.5:1 | 8.0–12.4 | 9.2–11.1 |
| Table edges on the plan | 3:1 | 3.0–5.5 | 3.9–6.5 |

## Components

Each has default, pressed, focus (a 3px ring), disabled, and where it applies selected, loading
and error states. All are in the gallery.

| Component | Use |
|---|---|
| `Button` | primary, secondary, quiet, danger; `md` (48px) or `lg` (64px); with an icon, loading spinner, selected, error |
| `ProductTile` / `button.quick` | name, price, a colour stripe by category, low stock, sold out (struck through, labelled) |
| `CategoryTabs` | sections and areas |
| `ListRow` | 64px rows: lead icon, title, meta, amount, badge |
| `NumPad`, `typeAmount()` | digits, point and delete; quick amounts |
| `Stepper` | quantities |
| `SearchField` | search with an icon, the search keyboard |
| `Toggle` | settings switches |
| `Chip` | filters and single choices |
| `Badge`, `Banner` | states and messages in plain words, with an icon by tone |
| `EmptyState`, `Skeleton` | nothing yet; loading |
| `Sheet` | dialogs from the bottom (phone) or the side (tablet, till) |
| Status bar | where, screens, connection, printer, time, who is selling |
| `TableShape` | a table in its real shape with its seats and state |

## Floor and tables

Eight states come from the data (`src/venue/check.ts`): free, reserved, seated, ordered, food
sent, mains served, bill requested, and paid. "Paid" is shown as **needs cleaning** (a sparkle
icon and dashed edge), since that is what it asks of staff. Two flags go on top of any state:
**no activity for 20 minutes** (a clock, an amber ring) and **food is ready** (a bell, a red
ring). Each state has a colour, an icon and a word. The legend is one tap from the floor.

A table shows, as its size on screen allows (container queries): the state, its name large,
guests, server, minutes seated and the running total. Small on screen, it shows the name first.
Tables are drawn to scale on a 16:10 room, with walls, doors and fixtures.

Gestures: tap to open; hold (or right-click, or Shift+F10) for actions; hold and drag onto another
table to move or join, confirmed first; pinch, the wheel or the buttons to zoom; drag the floor to
pan; Fit (or `0`) to see it all. The list view (the default on a phone) has the same actions from
a button on each row.

## Keyboard and screen readers

- Every control is a real button or field with a name. Icons are hidden from screen readers; the
  word next to them is read.
- Focus is always visible (a 3px ring).
- Shortcuts are shown only where there is a keyboard and a mouse (`hover: hover`): F2 issues,
  Enter adds, + and − change the last line's quantity.
- On the floor: Tab through tables, Enter opens, Shift+F10 opens the actions, + − 0 zoom.
- Text sizes are in rem, so the device's font size scales the text; touch targets stay at least 48px.
