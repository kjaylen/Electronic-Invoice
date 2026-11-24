-- Offline-first tills. A till numbers its Tax Receipts on the device, in a
-- series of its own (operMode 3, subsequent authorization), prints them, and
-- uploads them later with its shifts and cash movements.
--
-- Each install of a till (a fresh local database on the device) gets a series
-- no one else ever gets, even after the till is removed: two tills can never
-- print the same number, and a reinstalled till never reuses one it may have
-- printed before losing its data.

alter table series drop constraint series_purpose_check;
alter table series add constraint series_purpose_check check (purpose in ('normal', 'contingency', 'offline'));

create table pos_offline_series (
  tenant_id     uuid not null references tenants (id),
  environment   text not null,
  series_number integer not null check (series_number between 101 and 899),
  device_id     uuid not null references pos_devices (id),
  -- The install's own id (made by the app with its local database).
  install_id    uuid not null,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, environment, series_number),
  unique (device_id, install_id, environment)
);

-- What tills uploaded: one row per event (a sale, a shift opened or closed, cash paid in or out),
-- written in the same transaction as what the event did. The id is the till's own, so an event
-- sent twice (a lost reply, a retry after a crash) is done once and answered with its first result.
create table pos_sync_events (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  device_id   uuid not null references pos_devices (id),
  kind        text not null check (kind in ('sale', 'shift_open', 'cash', 'shift_close')),
  -- When it happened on the till (its clock).
  happened_at timestamptz not null,
  document_id uuid references documents (id),
  result      jsonb not null default '{}',
  received_at timestamptz not null default now()
);
create index pos_sync_events_device on pos_sync_events (device_id, received_at desc);
