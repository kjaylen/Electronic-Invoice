-- Refunds, shared rate limits, two-step sign-in, notifications, monitoring,
-- and photos in object storage.

-- ---------- refunds of online orders (each one a credit note) ----------
create table order_refunds (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  order_id     uuid not null references orders (id),
  document_id  uuid not null references documents (id),
  amount_cents bigint not null check (amount_cents > 0),
  -- [{ "lineNumber": 1, "quantity": 2 }, ...] and whether delivery was refunded
  lines        jsonb not null,
  delivery     boolean not null default false,
  reason       text not null,
  restocked    boolean not null default false,
  created_by   uuid references users (id),
  created_at   timestamptz not null default now()
);
create index order_refunds_order on order_refunds (order_id);
alter table orders add column refunded_cents bigint not null default 0;

-- ---------- rate limits shared by every server process ----------
create table rate_limits (
  key      text primary key,
  count    integer not null,
  reset_at timestamptz not null
);
create index rate_limits_reset on rate_limits (reset_at);

-- ---------- two-step sign-in (authenticator app codes) ----------
-- owner_kind: 'user' (a business account) or 'staff' (platform console).
create table two_factor (
  owner_kind       text not null check (owner_kind in ('user', 'staff')),
  owner_id         uuid not null,
  secret_encrypted text not null,
  confirmed_at     timestamptz,
  -- The last 30-second step used, so a code cannot be replayed.
  last_step        bigint,
  created_at       timestamptz not null default now(),
  primary key (owner_kind, owner_id)
);
create table recovery_codes (
  id         uuid primary key,
  owner_kind text not null check (owner_kind in ('user', 'staff')),
  owner_id   uuid not null,
  code_hash  text not null,
  used_at    timestamptz
);
create index recovery_codes_owner on recovery_codes (owner_kind, owner_id);
-- After the password, before the code: a short-lived, single-purpose token.
create table login_challenges (
  token_hash text primary key,
  owner_kind text not null check (owner_kind in ('user', 'staff')),
  owner_id   uuid not null,
  expires_at timestamptz not null,
  attempts   integer not null default 0
);
-- A business can require two-step sign-in for its owners and admins.
alter table tenants add column require_two_factor boolean not null default false;

-- ---------- notifications sent (each one once) ----------
create table notifications_sent (
  key       text primary key,
  tenant_id uuid references tenants (id),
  sent_at   timestamptz not null default now()
);

-- ---------- monitoring ----------
create table worker_heartbeats (
  name    text primary key,
  at      timestamptz not null,
  details jsonb
);

-- ---------- product photos in object storage (S3-compatible) ----------
alter table product_images alter column data drop not null;
alter table product_images add column storage_key text;
alter table product_images add constraint product_images_stored check (data is not null or storage_key is not null);

-- Staff two-step sign-in is mandatory from now on: sessions opened with a password alone end.
delete from platform_sessions;
