-- A customer's account page: one link (a year) where they see what they owe, pay it, and get their
-- invoices and statement. The token is stored hashed; links can be revoked.

create table customer_links (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  customer_id uuid not null references customers (id),
  token_hash  text not null unique,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  last_seen   timestamptz
);
create index customer_links_customer on customer_links (customer_id);
