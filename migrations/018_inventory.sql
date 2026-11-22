-- Inventory: every change to an item's stock is a movement (a sale, an
-- online order, stock received, a count, damage...), and the item's level
-- follows. Quantities can have decimals (sold by the pound or litre), and a
-- level can go below zero (a sale at the counter is never refused because
-- the count is off; the online store still never sells what is not there).

alter table items drop constraint items_stock_quantity_check;
alter table items alter column stock_quantity type numeric(18, 3);
-- Warn when stock falls to this level or below.
alter table items add column low_stock numeric(18, 3) check (low_stock is null or low_stock >= 0);
-- Average cost of one unit before GST (from stock received).
alter table items add column average_cost numeric(24, 6) check (average_cost is null or average_cost >= 0);

-- Stock received from a supplier (one delivery), optionally with its bill recorded as an expense.
create table stock_receipts (
  id               uuid primary key,
  tenant_id        uuid not null references tenants (id),
  supplier_id      uuid references suppliers (id),
  supplier_name    text,
  reference        text,
  received_on      date not null,
  total_cost_cents bigint not null default 0,
  expense_id       uuid references expenses (id),
  note             text,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now()
);
create index stock_receipts_tenant on stock_receipts (tenant_id, received_on desc);

create table stock_movements (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  item_id       uuid not null references items (id),
  change        numeric(18, 3) not null,
  balance_after numeric(18, 3) not null,
  reason        text not null check (reason in ('initial', 'sale', 'sale_reversed', 'order', 'order_cancelled', 'refund', 'receive', 'count', 'damaged', 'lost', 'returned', 'other')),
  -- What it came from.
  document_id   uuid references documents (id),
  order_id      uuid references orders (id),
  receipt_id    uuid references stock_receipts (id),
  -- A sale put back (the document was rejected or cancelled): the sale it reverses, once.
  reverses_id   uuid unique references stock_movements (id),
  unit_cost     numeric(24, 6),
  note          text,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now()
);
create index stock_movements_item on stock_movements (item_id, created_at desc);
create index stock_movements_sales on stock_movements (document_id) where reason = 'sale';

create trigger stock_movements_no_delete before update or delete on stock_movements
  for each row execute function forbid_change();

-- The stock there is today becomes the opening movement of each item.
insert into stock_movements (id, tenant_id, item_id, change, balance_after, reason, note)
select gen_random_uuid(), tenant_id, id, stock_quantity, stock_quantity, 'initial', 'Stock when inventory history began'
from items where stock_quantity is not null and stock_quantity <> 0;
