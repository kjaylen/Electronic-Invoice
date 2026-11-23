-- "Email me when it's back": buyers waiting for a sold-out variant, told once when it returns.

create table stock_alerts (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  item_id     uuid not null references items (id),
  email       text not null,
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);
create unique index stock_alerts_waiting on stock_alerts (item_id, lower(email)) where notified_at is null;
create index stock_alerts_pending on stock_alerts (created_at) where notified_at is null;
