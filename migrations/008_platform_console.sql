-- The platform console: our own staff, who move businesses from the BTS test
-- environment to production once BTS approves them.

-- ---------- numbering per environment ----------
-- Test and production are separate BTS systems. A business that goes live
-- starts production numbering at serial 1 with a fresh sequence-hash chain;
-- its test documents keep theirs. (The ETDUI already carries the environment.)
alter table series add column environment text;
update series s set environment = t.environment from tenants t where t.id = s.tenant_id;
alter table series alter column environment set not null;
alter table series add constraint series_environment check (environment in ('test', 'production'));
alter table series drop constraint series_tenant_id_etd_type_series_number_key;
alter table series add constraint series_number_per_environment unique (tenant_id, environment, etd_type, series_number);

alter table documents drop constraint documents_tenant_id_etd_type_series_number_serial_key;
alter table documents add constraint documents_number_per_environment unique (tenant_id, reception_env, etd_type, series_number, serial);

alter table events drop constraint events_tenant_id_event_code_serial_key;
create unique index events_number_per_environment on events (tenant_id, event_code, serial, substring(etdui from 33 for 2));

-- When and on what approval a business went live.
alter table tenants add column production_since timestamptz;
alter table tenants add column bts_approval_reference text;

-- ---------- platform staff ----------
create table platform_admins (
  id            uuid primary key,
  email         text not null,
  name          text not null,
  password_hash text not null,
  status        text not null default 'active' check (status in ('active', 'disabled')),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index platform_admins_email on platform_admins (lower(email));

create table platform_sessions (
  id           uuid primary key,
  token_hash   text not null unique,
  admin_id     uuid not null references platform_admins (id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index platform_sessions_admin on platform_sessions (admin_id);

-- What platform staff did, permanently.
create table platform_audit (
  id         bigint generated always as identity primary key,
  admin_id   uuid references platform_admins (id),
  tenant_id  uuid references tenants (id),
  action     text not null,
  details    jsonb,
  ip         text,
  at         timestamptz not null default now()
);
create index platform_audit_tenant on platform_audit (tenant_id, id desc);
create trigger platform_audit_permanent before update or delete on platform_audit
  for each row execute function forbid_change();
