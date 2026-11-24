-- More than one shop. A business that adds a second location gets its first
-- one named too (the main one). items.stock_quantity stays the total the
-- business owns, so everything that reads it (the online store, low-stock
-- warnings, reports, other systems) keeps working. What is at each other
-- location is kept here; what is at the main one is what is left: the total,
-- less the other locations, less what is on the way between two of them.

create table locations (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  is_main     boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index locations_name on locations (tenant_id, lower(name)) where archived_at is null;
create unique index locations_main on locations (tenant_id) where is_main;

create table location_stock (
  location_id uuid not null references locations (id),
  item_id     uuid not null references items (id),
  tenant_id   uuid not null references tenants (id),
  quantity    numeric(18, 3) not null default 0,
  primary key (location_id, item_id)
);
create index location_stock_item on location_stock (item_id);

-- A till's drawer belongs to a location and sells from its stock (none: the main one).
alter table registers add column location_id uuid references locations (id);
-- Where a movement happened (none: the main location, or a business with one shop).
alter table stock_movements add column location_id uuid references locations (id);
alter table stock_receipts add column location_id uuid references locations (id);

alter table stock_movements drop constraint stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check check (reason in
  ('initial', 'sale', 'sale_reversed', 'order', 'order_cancelled', 'refund', 'receive', 'count', 'damaged', 'lost', 'returned', 'other', 'transfer_out', 'transfer_in'));

-- Stock sent from one location to another: off the first when sent, on the
-- second when received, on the way in between.
alter table tenants add column next_transfer_number integer not null default 1;
create table stock_transfers (
  id               uuid primary key,
  tenant_id        uuid not null references tenants (id),
  number           integer not null,
  from_location_id uuid not null references locations (id),
  to_location_id   uuid not null references locations (id),
  status           text not null default 'sent' check (status in ('sent', 'received', 'cancelled')),
  note             text,
  sent_by          uuid references users (id),
  sent_at          timestamptz not null default now(),
  received_by      uuid references users (id),
  received_at      timestamptz,
  cancelled_by     uuid references users (id),
  cancelled_at     timestamptz,
  check (from_location_id <> to_location_id)
);
create index stock_transfers_tenant on stock_transfers (tenant_id, sent_at desc);
create table stock_transfer_lines (
  transfer_id uuid not null references stock_transfers (id),
  item_id     uuid not null references items (id),
  quantity    numeric(18, 3) not null check (quantity > 0),
  primary key (transfer_id, item_id)
);
create index stock_transfer_lines_item on stock_transfer_lines (item_id);

-- Landed cost: what it cost to bring a delivery in (freight, duty, brokerage),
-- spread over its items by value.
alter table stock_receipts add column landed_cost_cents bigint not null default 0;
alter table stock_receipts add column landed jsonb;
