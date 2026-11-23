-- Sales put on hold at the counter, shared by every till of the business (they used to stay on
-- the device that held them). The sale is kept as the counter sent it.

create table held_sales (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  label       text not null default '',
  total_cents bigint not null default 0,
  item_count  integer not null default 0,
  sale        jsonb not null,
  held_by     uuid references users (id),
  device_id   uuid references pos_devices (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index held_sales_tenant on held_sales (tenant_id, created_at desc);
