-- Purchase orders: what a business orders from a supplier, sent as a PDF, then received in one or
-- more deliveries (each a stock receipt). Numbered per business: PO-1, PO-2…

alter table tenants add column next_po_number integer not null default 1;

create table purchase_orders (
  id               uuid primary key,
  tenant_id        uuid not null references tenants (id),
  number           integer not null,
  supplier_id      uuid references suppliers (id),
  supplier_name    text not null check (length(supplier_name) between 1 and 200),
  supplier_email   text,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'received', 'cancelled')),
  expected_on      date,
  note             text,
  total_cost_cents bigint not null default 0,
  sent_at          timestamptz,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, number)
);
create index purchase_orders_tenant on purchase_orders (tenant_id, created_at desc);
create index purchase_orders_open on purchase_orders (tenant_id, status) where status in ('draft', 'sent', 'partial');

create table purchase_order_lines (
  purchase_order_id uuid not null references purchase_orders (id) on delete cascade,
  line_number       integer not null,
  item_id           uuid not null references items (id),
  description       text not null,
  quantity          numeric(18, 3) not null check (quantity > 0),
  received          numeric(18, 3) not null default 0 check (received >= 0),
  unit_cost         numeric(24, 6) not null check (unit_cost >= 0),
  primary key (purchase_order_id, line_number)
);

alter table stock_receipts add column purchase_order_id uuid references purchase_orders (id);
create index stock_receipts_po on stock_receipts (purchase_order_id) where purchase_order_id is not null;
