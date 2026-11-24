-- The developer log: what each business's integrations asked and were answered
-- (requests made with its secret keys on /v1, and with its publishable keys on
-- the store API), so a failing call can be looked up without asking us. Shown
-- in Settings -> Developers -> Logs. See src/api/devlog.ts.
--
-- Only the path is kept, never a query (it can carry an order's link token) or
-- anything from a body. Rows are kept for a week, and no more than the newest
-- 10,000 per business; housekeeping removes the rest. Not a permanent record.

create table api_requests (
  id        bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id),
  key_kind  text not null check (key_kind in ('secret', 'publishable')),
  -- The key's id; 'unknown' for a publishable key the store does not have.
  key_id    text not null,
  at        timestamptz not null default now(),
  method    text not null,
  -- The endpoint as the reference names it ("/v1/store/:slug/orders"), and the address asked for.
  route     text not null,
  path      text not null,
  status    integer not null,
  -- The error's code and message, when it failed.
  code      text,
  message   text,
  ms        integer not null,
  -- The site the page was on, for a call from a browser.
  origin    text
);
-- The newest first, for one business; and the same for what failed only.
create index api_requests_tenant on api_requests (tenant_id, id desc);
create index api_requests_failed on api_requests (tenant_id, id desc) where status >= 400;
-- Removing what is older than a week.
create index api_requests_at on api_requests (at);
