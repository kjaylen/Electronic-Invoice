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
| GST on hotel accommodation | charged, at the standard rate, on the room charge | — | **unverified** | No exemption was found; Act No. 34 of 2024 excludes "hotel or holiday accommodation" from the residential exemption (nationalassembly.gov.bz). Secondary sources say hotel tax is on top of GST, not instead of it |
| GST on the hotel tax itself | not charged (the hotel tax is not part of the price for GST) | — | **unverified** | none found |
| GST on a service charge | charged (the service charge is part of what is paid for the supply) | — | **unverified** | BTS has a public ruling, "Treatment of tax for service charge for the hospitality industry" (bts.gov.bz/category/tax-ruling/). Its page would not load on 25 Nov 2026. Read it and set `serviceChargeGst` accordingly |
| Hotel tax on a service charge | not charged | — | **unverified** | as above |
| Usual service charge | 10%, a venue's own setting | — | custom, not law | travel and trade guides |
| US dollar rate | BZ$2.00 to US$1.00 | fixed peg | verified | Central Bank of Belize peg; the venue can change its own rate |
| Tips | not part of the sale, no tax document | — | follows the earlier POS decision | DECISIONS.md |
| Returns | GST by the 15th of the next month to BTS; hotel tax monthly to the BTB (day not confirmed) | — | hotel tax day **unverified** | bts.gov.bz; BTB Hotels page ("paid to the BTB") |

## How each is applied

- **Food, drinks, anything sold at a table or bar**: GST by the item's own
  category (standard, zero, exempt), as in the shop.
- **Service charge**: a charge on each line. With `serviceChargeGst` on (the
  default, the cautious reading) it carries the line's GST.
- **A room night**: a line at the nightly rate, GST standard-rated, with the
  hotel tax as a charge on that line that carries no GST (`hotelTaxGst` off).
  The BTS document has only the GST, environmental and excise schemes, so the
  hotel tax cannot be a tax of its own on it: it is shown as a named charge,
  "Hotel tax 9%", and reported separately for the BTB return.
- **Unverified values** are marked so in the settings screen and repeated in
  the final summary. Changing one is a new dated row; documents already issued
  are never touched.
