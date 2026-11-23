-- Buyer accounts for the online store. A buyer signs in with a six-digit code
-- sent to their email (no password); the first sign-in makes the account.
-- Signed in, they see their orders at the store, keep addresses and their
-- business's TIN, and check out with those filled in. An account belongs to
-- one store. Guests can still check out without one.

create table store_buyers (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  -- Lowercased. The account is this address: to use another, sign in with it.
  email         text not null,
  name          text,
  phone         text,
  -- For a tax invoice instead of a receipt: the buyer's business.
  business_tin  char(6),
  business_name text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (tenant_id, email)
);

create table store_buyer_addresses (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  buyer_id      uuid not null references store_buyers (id) on delete cascade,
  street        text not null,
  city          text not null,
  district_code char(1) not null check (district_code between '1' and '6'),
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);
create index store_buyer_addresses_buyer on store_buyer_addresses (buyer_id);

-- A sign-in code: 6 digits, 10 minutes, 5 tries. Tied to the browser that asked
-- for it by a challenge only that browser holds; both are stored hashed.
create table store_buyer_codes (
  challenge_hash text primary key,
  tenant_id      uuid not null references tenants (id),
  email          text not null,
  code_hash      text not null,
  attempts       integer not null default 0,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);
create index store_buyer_codes_expires on store_buyer_codes (expires_at);

-- Signed in (90 days); only a hash of the cookie's token is stored.
create table store_buyer_sessions (
  token_hash   text primary key,
  tenant_id    uuid not null references tenants (id),
  buyer_id     uuid not null references store_buyers (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index store_buyer_sessions_buyer on store_buyer_sessions (buyer_id);
create index store_buyer_sessions_expires on store_buyer_sessions (expires_at);

-- Orders placed signed in. A buyer also sees orders placed as a guest with their email.
alter table orders add column buyer_id uuid references store_buyers (id) on delete set null;
create index orders_buyer on orders (buyer_id, created_at desc) where buyer_id is not null;
create index orders_tenant_email on orders (tenant_id, customer_email, created_at desc) where customer_email is not null;
