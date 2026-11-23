-- Tools for the people who run the platform.

-- A business can be suspended by staff (abuse, fraud, a legal order): its people,
-- tills and API keys are refused and its store is closed until it is reactivated.
-- Documents already on their way to BTS still finish.
alter table tenants add column suspended_at timestamptz;
alter table tenants add column suspended_reason text;

-- Notices from the platform to every business (maintenance, a BTS outage, news),
-- shown in the app while they last. Optionally in Spanish too.
create table platform_notices (
  id         uuid primary key,
  message    text not null check (length(message) between 1 and 500),
  message_es text check (message_es is null or length(message_es) between 1 and 500),
  level      text not null default 'info' check (level in ('info', 'warning')),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  created_by uuid references platform_admins (id),
  created_at timestamptz not null default now()
);
create index platform_notices_open on platform_notices (starts_at) where ends_at is null;
