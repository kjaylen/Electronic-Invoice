# Which electronic tax document, and when

Written before the code, from the BTS Orientation Manual v1.30 as this
repository already applies it (README, "Settled by the manual"): type 01 tax
invoice, 02 tax receipt, 03 debit note, 04 credit note; a credit note names
the document it corrects; a document, once authorized, is never edited.
Test documents go to the BTS tests environment only.

| Event | Document | When | Notes |
|---|---|---|---|
| A table bill, paid | 02 tax receipt (01 tax invoice when the guest gives a TIN and asks for one) | at payment | lines are the items as served, modifiers priced into their line; the service charge is a charge on each line |
| Each part of a split bill | one 02 per part | when that part is paid | by seat or by item: the part's own lines. An item shared by N guests: a line of quantity 1/N (6 decimals); the last sharer's line takes the odd cent, so the parts add up to the bill exactly. An even split: one receipt for the whole bill with several tenders, because equal slices of every line cannot be made to add up line by line (**to confirm**: whether BTS expects a document per payer) |
| A bar tab | 02 | when the tab is closed and paid; a part-payment of chosen rounds is a split part | nothing is issued while the tab runs |
| A comped item | on the receipt at full price with a 100% allowance, reason "Complimentary" | with the bill it belongs to | cautious: the supply is shown, at zero. A bill that is entirely comps issues nothing and is kept in the comp log (**to confirm**: whether a zero-value document is wanted) |
| A void before payment | none | — | the item never reached a document; the void is in the audit log |
| A void or refund after payment | 04 credit note against the receipt | at once | the existing refund flow |
| A deposit for a table booking | 02 tax receipt for "Deposit for a table …", GST standard-rated, the amount handed over being GST-inclusive | when the deposit is taken | cautious: money received for a taxable supply is documented when received. When the party eats, the deposit's amount before GST comes off their bill as an allowance spread over its standard-rated lines ("Deposit paid"), so the bill carries GST only on the rest and nothing is taxed twice (**to confirm** with BTS: deposit at receipt vs at supply) |
| A deposit for a hotel stay | 02 tax receipt for "Deposit for booking H-…", with the room's own GST treatment (exempt) | when taken | at check-out the deposit's receipt is credited (04, "Deposit used on the final bill", no money given back) and the amount is recorded as a payment on the stay's invoices. Two documents rather than an allowance, because a stay's invoices are on account and take payments |
| A deposit returned | 04 credit note against the deposit's receipt | when returned | |
| A deposit kept after a no-show or a late cancellation | none further | — | the receipt stands |
| A restaurant or bar charge posted to a room | 01 tax invoice on account, to the guest, terms "Charged to room N, due at check-out" | when posted (the supply) | cautious: the supply is documented when made, not days later at check-out. It is paid when the folio is settled |
| Room nights | 01 tax invoice on account for the nights of the stay, one line per rate, hotel tax as a named charge | at check-out (or at night audit on the last day of a month, so each month's nights are in that month's return) | not one document per night: the stay is one supply billed at its end, with the month-end cut as the cautious limit (**to confirm**) |
| A hotel final bill | not a new tax document: the folio statement lists the invoices above, the deposit, and the payments | at check-out | it says "Statement of account: the tax documents are listed". Payments are recorded against the invoices |
| A pre-bill ("guest check") | none | — | printed with "NOT A TAX DOCUMENT. Your receipt follows payment." top and bottom, no BTS QR, no document number |
| Tips | none | — | not a supply by the venue |
| An order ticket | none | — | internal |

## Open for BTS confirmation

1. A deposit: receipt when taken (as built) or only at the supply.
2. An even split: one receipt with several tenders (as built) or one per payer.
3. A fully comped bill: no document (as built) or a zero-value receipt.
4. Room nights: one invoice per stay with a month-end cut (as built) or one per night.
5. Hotel tax shown as a charge, since the document has no scheme for it.
