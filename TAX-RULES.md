# Tax rules used by the hospitality module

Every value here is configuration with a start date (`src/venue/tax-rules.ts`,
overridable per business under Settings → Venue → Taxes and charges). Nothing
is hard-coded in a calculation. Looked up on 25 Nov 2026.

| Rule | Value | From | Status | Source |
|---|---|---|---|---|
| GST standard rate | 12.5% | long-standing | verified | Belize Tax Service, "What is GST" (bts.gov.bz/wp-content/uploads/2019/10/WHAT-IS-GST.pdf); BELTRAIDE, "Taxes in Belize" (beltraide.bz) |
| Hotel and tourist accommodation tax | 9% of accommodation charges | long-standing | verified for 25 Nov 2026 | Belize Tourism Board, Hotels page (belizetourismboard.org/hotels/): hotels "are required to collect this 9% tax from each guest" |
| Proposed rise of the hotel tax to 12.5% | not in force as far as could be found | proposed Oct 2025 | **unverified** | San Pedro Sun, 15 Oct 2025 and 28 Aug 2026 (still "proposed"). A 2022 amendment lets the Minister change the rate by regulation: check for a new SI before going live |
| What the hotel tax is charged on | the room charge only: not food, drinks, tours, the service charge or GST | — | **unverified** (the Act's "accommodation charges"; the BTB page does not spell out the base) | Hotels and Tourist Accommodation Act, Cap. 285 |
| GST on hotel accommodation | exempt: a room night carries no GST, only the hotel tax | — | **unverified** at the level of the Act (secondary source) | Belize Chamber of Commerce and Industry, "Tax regime" (belize.org/trade-investment-zone/investment-regime/tax-regime): hotel rooms listed among exempt supplies. The Schedule of the GST Act was not read. `accommodationGst` can be set to `standard` |
| Exemption reason code on a room night | `HOTEL` (a placeholder) | — | **unverified** | BTS has to say which code an exempt room night carries on the e-invoice |
| GST on a service charge | charged (the service charge is part of what is paid for the supply) | — | **unverified** | BTS has a public ruling, "Treatment of tax for service charge for the hospitality industry" (bts.gov.bz/category/tax-ruling/). Its page would not load on 25 Nov 2026. Read it and set `serviceChargeGst` accordingly |
| Exemption reason code on a service charge without GST | `SERVICE` (a placeholder, used only when `serviceChargeGst` is `no`) | — | **unverified** | BTS has to say which code it carries |
| Hotel tax on a service charge | not charged, and not a setting: no service charge is put on a room night, and the restaurant's service charge is not accommodation | — | **unverified** | as above |
| Usual service charge | 10%, a venue's own setting | — | custom, not law | travel and trade guides |
| US dollar rate | BZ$2.00 to US$1.00 | fixed peg | verified | Central Bank of Belize peg; the venue can change its own rate |
| Tips | not part of the sale, no tax document | — | follows the earlier POS decision | DECISIONS.md |
| Returns | GST by the 15th of the next month to BTS; hotel tax monthly to the BTB (day not confirmed) | — | hotel tax day **unverified** | bts.gov.bz; BTB Hotels page ("paid to the BTB") |

## How each is applied

- **Food, drinks, anything sold at a table or bar**: GST by the item's own
  category (standard, zero, exempt), as in the shop.
- **Service charge**: with `serviceChargeGst` on (the default, the cautious
  reading) it is a charge on each line and carries the line's GST. With it
  off, the charge is the same amount but goes on the receipt as one line of
  its own, exempt, with the reason code in `serviceChargeExemptionCode`:
  a charge on a line shares the line's GST, so it cannot stay there.
- **A room night**: a line at the nightly rate, exempt from GST (with the
  exemption reason code), and the hotel tax as a charge on that line, so it
  carries no GST either. The BTS document has only the GST, environmental
  and excise schemes, so the hotel tax cannot be a tax of its own on it: it
  is shown as a named charge, "Hotel tax 9%", and reported separately for the
  BTB return. With `accommodationGst` set to `standard` the line is
  standard-rated and the charge on it then carries GST too.
- **The counter's own service charge** (a shop's setting, from the POS work)
  is always a charge on each line with GST; only the hospitality module's
  follows `serviceChargeGst`.
- **Unverified values** are marked so in the settings screen and repeated in
  the final summary. Changing one is a new dated row; documents already issued
  are never touched.
