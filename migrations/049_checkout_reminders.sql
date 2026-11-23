-- Checkout reminders: a buyer who gave their email at checkout and left gets
-- an email with a link back to their cart (an hour later by default, and
-- once more a day after). Ordering, on any device, ends it.

create table store_checkouts (
  -- Made by the buyer's browser, so the same checkout is updated as they go.
  id                uuid primary key,
  tenant_id         uuid not null references tenants (id),
  email             text not null,
  name              text,
  -- What is in the cart: [{ variantId, quantity }], and the choices so far.
  lines             jsonb not null,
  fulfillment       text check (fulfillment in ('delivery', 'pickup')),
  zone              text,
  discount_code     text,
  -- As last priced, with GST (for the list and the summary).
  total_cents       bigint,
  -- The links in each reminder (restore the cart, unsubscribe), hashed. One per reminder sent.
  token_hashes      text[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'ordered', 'expired')),
  reminders_sent    integer not null default 0,
  last_reminded_at  timestamptz,
  order_id          uuid references orders (id),
  -- Ordered after a reminder was sent.
  recovered         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index store_checkouts_tenant on store_checkouts (tenant_id, updated_at desc);
create index store_checkouts_open on store_checkouts (updated_at) where status = 'open';
create index store_checkouts_email on store_checkouts (tenant_id, lower(email)) where status = 'open';

-- Buyers who asked a store not to send them reminders.
create table store_email_optouts (
  tenant_id  uuid not null references tenants (id),
  email      text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, email)
);
