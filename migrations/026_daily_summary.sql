-- A morning email to owners and admins with yesterday at a glance (src/notify/daily.ts). Opt-in.

alter table tenants add column daily_summary boolean not null default false;
