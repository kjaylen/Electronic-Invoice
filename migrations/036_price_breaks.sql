-- Quantity prices: buying at least min_quantity of an item, each costs unit_price (before GST)
-- instead of its usual price ("12 or more: BZ$2.50 each").

create table item_price_breaks (
  item_id      uuid not null references items (id),
  min_quantity numeric(18, 3) not null check (min_quantity > 1),
  unit_price   numeric(24, 6) not null check (unit_price >= 0),
  primary key (item_id, min_quantity)
);
