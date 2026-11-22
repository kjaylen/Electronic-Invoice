-- Point-of-sale tills: the iOS, Android and desktop apps. A manager adds a
-- till in the web app and gets a one-time pairing code; the app exchanges it
-- for its own device token. Cashiers then sign in on the till with a PIN.
-- Each till sells into its own cash drawer (register).

create table pos_devices (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  name          text not null,
  register_id   uuid not null references registers (id),
  -- Only a hash of the device token; null until the app has paired.
  token_hash    text unique,
  platform      text,
  app_version   text,
  -- What the till last reported: its printers, scanners and cash drawer.
  hardware      jsonb,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  paired_at     timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references users (id)
);
create index pos_devices_tenant on pos_devices (tenant_id, created_at desc);
create unique index pos_devices_name on pos_devices (tenant_id, lower(name)) where revoked_at is null;

-- A one-time code to pair a till: hashed, short-lived, used once.
create table pos_pairing_codes (
  code_hash  text primary key,
  device_id  uuid not null references pos_devices (id),
  tenant_id  uuid not null references tenants (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index pos_pairing_codes_device on pos_pairing_codes (device_id);

-- A cashier's PIN for signing in on tills (hashed like a password).
alter table users add column pos_pin_hash text;
alter table users add column pos_pin_set_at timestamptz;

-- A cashier's session on a till: bound to it, ended when the till is removed.
alter table sessions add column device_id uuid references pos_devices (id);
create index sessions_device on sessions (device_id) where device_id is not null;

-- What was done on which till.
alter table documents add column device_id uuid references pos_devices (id);
alter table register_shifts add column device_id uuid references pos_devices (id);
