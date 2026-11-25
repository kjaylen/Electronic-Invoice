# Till redesign: decisions and blockers

| Decision | Why |
|---|---|
| Restyle the shared counter, dialogs and order screen inside the till (scoped CSS) instead of rewriting them | They hold the selling, tax, offline and table logic. Appearance only was asked for; keeping their markup kept every test and behaviour. Small additions (a `touch` prop on the counter and the floor) switch on till-only parts. |
| Scope everything to `body.till-body` | The web app keeps its look. One system, one place. |
| Light by default, dark as a per-device choice (Devices → Appearance) | A till in a bright shop reads best light; a bar at night best dark. Per device, because tills differ. |
| A light order panel, not the dark purple "ticket" | The dark panel's secondary text failed contrast; light (or dark, by theme) on tokens passes AA. |
| Pay pinned at the bottom of the order, with the amount on it | A three-item sale with no scrolling at every size; the total is never out of sight. |
| Undo after removing a line (6 s), instead of a confirmation | Removing is common and quick; undo costs no tap when it was meant. |
| The cash keypad opens when the field is tapped | The device's keyboard covers half the screen and is slower; quick amounts stay for the usual case. |
| "Paid" shown as "Needs cleaning" | It is what the state asks of staff; the data still says paid. |
| Eight states and two flags, not nine states | The data model has eight (`src/venue/check.ts`). "No activity for 20 minutes" and "food is ready" can be true in several states at once, so they are flags on top (icon and ring), making nine signals in all. |
| Idle after 20 minutes without activity | A server's usual round; long enough not to cry wolf. Only seated, ordered, sent and mains count. |
| Table positions computed in screen pixels, not a CSS scale | Each table's text then adapts to its size on screen (container queries) when zoomed. |
| Hold-then-drag to move a table | A plain drag pans the floor, which is what a finger expects; holding first makes moving a party deliberate. It is confirmed before anything happens. |
| Phone floor defaults to the list | Tables are too small to read on a phone's plan. The choice is remembered. |
| The web app's floor is unchanged | The touch floor is for tills; the web floor is used with a mouse on desks. Both use the same data and actions. |
| The layout editor stays in the web app (Settings → Venue) | Layouts are a manager's setup task; it works by touch and by mouse. |
| No new dependencies | Inter (SIL OFL) was already bundled; the icons are drawn for Floreo. No commercial till's look was copied. |

## Blockers and what could not be redesigned

| Item | Why |
|---|---|
| iOS app | It can't be built here (no Mac). It runs the same `web/src/pos` code as Android and desktop, so it gets the redesign when it is next built on a Mac. |
| Booth-shaped tables | The floor plan stores round, square and rectangle only. A booth needs a new shape in the API and database, which is out of scope (appearance only). |
| The kitchen screen, tabs dialog, seat dialog, shift dialogs, printer editor | They pick up the tokens (light and dark, sizes, fonts) through the shared styles, but keep their layout. They are shared with the web app. |
| The customer display | It is a second screen for the customer, with its own large-type look; left as it was. |
| Chinese | The till's new strings are in Simplified Chinese too; the layout editor (web app) falls back to English there, as the web app does. |
