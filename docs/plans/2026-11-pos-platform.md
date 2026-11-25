# Plan: what a Belize shop, bar or restaurant still needs at the till

Who this is for: the owner of a small Belizean business who sells over a
counter: a grocery, a hardware or clothes shop, a bar, a restaurant, a shop
with a second branch. The till is the product. Everything here either
happens at the till or is what the owner does with the till's numbers at the
end of the month.

Payroll is out of scope, by decision: no pay runs, no Social Security
contributions, no payslips. The time clock keeps exporting hours.

Status marks: `[ ]` to do, `[x]` done, `[-]` skipped (the reason is in DECISIONS.md).

The plan before this one (email) is finished and kept in `docs/plans/2026-11-email.md`.

## What exists (read 24 Nov 2026)

The till is already strong: one app for desktop, Android, iPhone and any
browser, selling offline first; barcode scanners and the camera; receipt
printers and cash drawers; shifts with X and Z reports; discounts with a
cashier limit; split payments; US$ cash taken at 2 to 1; held sales shared
between tills; gift cards; loyalty points; wholesale and quantity prices;
sales on account with credit limits; bundles; items sold by weight; stock
with a ledger, purchase orders and counts; a GST return worksheet.

## What is missing, found by asking what a typical Belize business does

Facts about Belize used below were looked up on 24 Nov 2026 and are written
down in DECISIONS.md with where they came from. Rates are settings, never
constants in the code, because they change and because sources disagree.

### A. At the counter, every day

- [x] A1. **Mobile wallets as a way to pay** (DigiWallet, E-Kyash by hand):
  a "Wallet" button beside Cash, Card and Transfer, with the reference typed
  in; counted on its own line in the shift report and the Z report.
- [x] A2. **Prices in US dollars too.** A setting: the receipt, the customer
  display and price labels show the total in US$ beside BZ$ (2 to 1), for
  shops that sell to visitors.
- [x] A3. **Service charge.** A setting (off, or a percentage, usually 10%):
  added to a sale with one tap, on by default for sales opened on a table,
  shown as its own line on the receipt, with GST as the business has set it.
- [x] A4. **Tips.** When a customer adds a tip on a card or wallet payment,
  the till records it with the sale; it is not part of the receipt or the
  sales figures, and the shift report says how much is owed to staff.
- [x] A5. **Layaway.** Goods put aside for a customer who pays over time: a
  deposit now, payments later, collected when paid in full; a list of
  layaways with what is still owed and when each runs out; cancelling gives
  back the goods and says what to refund.

### B. Bars and restaurants

- [x] B1. **Tables and tabs.** A business says it serves at tables and names
  them (Table 1 to 12, Bar, Patio). The till shows them: free, open (for how
  long, how much), and opens a tab with a tap. A tab is added to over the
  evening from any till, and paid like any sale.
- [x] B2. **Order tickets for the kitchen and the bar.** Items are marked as
  kitchen, bar or neither. Sending a tab prints only what is new, on the
  printer for that station, with the table, the time, who took it, and a note
  per item ("no onions").
- [x] B3. **Splitting a bill.** Pay part of a tab by item; each part gets
  its own receipt and the rest stays on the table. (Equal parts are not
  separate receipts: a tax receipt lists goods, and a third of a plate does
  not add up to the cent. Friends who split evenly pay one receipt with the
  Split payment.)

### C. More than one shop

- [x] C1. **Locations.** A business with a second shop adds it; stock is
  kept per location; a till belongs to a location and sells from its stock;
  receiving and counting are done per location; the stock report shows each
  and the total.
- [x] C2. **Transfers** between locations: sent from one, received at the
  other, with what is on the way.

### D. Buying stock from abroad

- [x] D1. **Landed cost.** When stock is received, freight, duty, brokerage
  and other costs of bringing it in are entered once and spread over the
  items by value, so the cost per item (and the margin the till shows) is
  what the goods really cost.

### E. The end of the month

- [x] E1. **Business tax worksheet** (Reports → Business tax): the month's
  receipts by kind, the rate for each (the business chooses its kinds in
  Settings; 1.75% for trade and 6% for professions are filled in), less the
  contract tax customers withheld; CSV and PDF; in the accountant's pack.
- [x] E2. **What is due and when.** The overview and a monthly email say what
  is coming up: the GST return and the business tax return (the 15th), and
  dates the owner adds (trade licence, Social Security, insurance).

### F. Reaching customers and shopkeepers

- [x] F1. **Reminders by WhatsApp.** Getting paid lists who to remind today;
  each has a WhatsApp button that opens the chat with the message and the
  pay link written, for customers who do not read email.
- [x] F2. **The till in Chinese.** The counter, the till app and its receipts
  screens in Simplified Chinese, chosen per person like Spanish.

### G. Looked at, and not built here

- [-] G1. Payroll and Social Security: out of scope by decision.
- [-] G2. Hotel tax and room or tour bookings.
- [-] G3. Bank reconciliation and a balance sheet.
- [-] G4. DigiWallet and E-Kyash taking the payment themselves at the till.
- [-] G5. WhatsApp sending by itself.

### H. Proof

- [x] H1. Unit tests for each item; the browser tests drive each new screen.
- [x] H2. The offline till still passes its own tests after every change to the counter.
- [x] H3. README, DECISIONS.md, and a summary of what changed for each kind of business.
