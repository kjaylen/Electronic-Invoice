-- The time clock: when each person clocked in and out. One open entry per person.

create table time_entries (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  user_id    uuid not null references users (id),
  clock_in   timestamptz not null,
  clock_out  timestamptz check (clock_out is null or clock_out > clock_in),
  device_id  uuid references pos_devices (id) on delete set null,
  note       text,
  -- Corrected by a manager (or closed automatically after a forgotten clock-out).
  edited     boolean not null default false,
  created_at timestamptz not null default now()
);
create index time_entries_tenant on time_entries (tenant_id, clock_in desc);
create unique index time_entries_open on time_entries (user_id) where clock_out is null;
