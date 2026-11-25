-- Checks (a party's order at a table, a bar tab, a quick sale), the log of
-- operations they are folded from, and the tickets that go to the kitchen
-- and the bar (the print queue, and what a kitchen screen shows).

-- Counts up with every change, so a device can ask for what is new.
alter table tenants add column venue_seq bigint not null default 0;
alter table tenants add column next_check_number integer not null default 1;

create table venue_checks (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  number        integer not null,
  kind          text not null check (kind in ('table', 'tab', 'quick')),
  status        text not null check (status in ('open', 'paid', 'closed', 'merged')),
  table_id      text,
  server_id     uuid references users (id),
  business_date date not null,
  opened_at     timestamptz not null,
  closed_at     timestamptz,
  -- The check as folded (src/venue/check.ts).
  state         jsonb not null,
  seq           bigint not null
);
create index venue_checks_open on venue_checks (tenant_id) where status in ('open', 'paid');
create index venue_checks_seq on venue_checks (tenant_id, seq);
create index venue_checks_day on venue_checks (tenant_id, business_date);
-- One party at a table at a time.
create unique index venue_checks_table on venue_checks (tenant_id, table_id) where status in ('open', 'paid') and table_id is not null;

-- Every operation, kept for good: who did what to which check, and when.
create table venue_ops (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  check_id   uuid not null,
  type       text not null,
  payload    jsonb not null,
  user_id    uuid references users (id),
  device_id  uuid references pos_devices (id),
  -- When it was done on the device, and when it reached the server.
  at         timestamptz not null,
  received_at timestamptz not null default now(),
  ok         boolean not null,
  reason     text
);
create index venue_ops_check on venue_ops (check_id, received_at);
create index venue_ops_tenant on venue_ops (tenant_id, received_at desc);

create table venue_tickets (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  check_id    uuid not null references venue_checks (id),
  station_id  uuid not null references venue_stations (id),
  -- order: something new to make; void: stop making it; change: made differently.
  kind        text not null check (kind in ('order', 'void', 'change')),
  body        jsonb not null,
  -- queued: waiting for its printer; printed; failed: the printer said no; screen: on a kitchen screen only.
  status      text not null check (status in ('queued', 'printed', 'failed', 'screen')),
  attempts    integer not null default 0,
  error       text,
  -- The till that sent the order (it prints the ticket when the station has no printer of its own).
  origin_device_id uuid references pos_devices (id),
  sent_by     uuid references users (id),
  created_at  timestamptz not null default now(),
  printed_at  timestamptz,
  -- The kitchen screen: done, and brought back.
  bumped_at   timestamptz,
  bumped_by   uuid references users (id),
  seq         bigint not null
);
create index venue_tickets_live on venue_tickets (tenant_id, station_id) where bumped_at is null;
create index venue_tickets_seq on venue_tickets (tenant_id, seq);

-- Sections: the tables each server looks after, for a business day.
create table venue_sections (
  tenant_id     uuid not null references tenants (id),
  business_date date not null,
  user_id       uuid not null references users (id),
  table_ids     text[] not null default '{}',
  primary key (tenant_id, business_date, user_id)
);
