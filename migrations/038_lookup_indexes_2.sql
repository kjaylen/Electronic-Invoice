-- Lookups added with purchasing, suppliers and the time clock, kept quick as history grows:
--   stock moves of a delivery (a supplier's items, reorder suggestions' last supplier);
--   a supplier's deliveries, bills and purchase orders (the supplier page);
--   a person's time entries (the time clock).

create index if not exists stock_movements_receipt on stock_movements (receipt_id) where receipt_id is not null;
create index if not exists stock_receipts_supplier on stock_receipts (supplier_id) where supplier_id is not null;
create index if not exists expenses_supplier on expenses (supplier_id) where supplier_id is not null;
create index if not exists purchase_orders_supplier on purchase_orders (supplier_id) where supplier_id is not null;
create index if not exists time_entries_user on time_entries (user_id, clock_in desc);
