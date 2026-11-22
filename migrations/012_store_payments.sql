-- Online store, phase 2: discount codes, paying online, custom domains.

-- ---------- discount codes ----------
create table discount_codes (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  code          text not null,
  -- percent: value is the percent off items; amount: value is BZ$ off items (with GST); free_delivery: value unused.
  kind          text not null check (kind in ('percent', 'amount', 'free_delivery')),
  value         numeric(24, 6) not null default 0,
  min_subtotal  numeric(24, 6),
  starts_at     timestamptz,
  ends_at       timestamptz,
  max_uses      integer,
  uses          integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
alter table orders add column discount_code_id uuid references discount_codes (id);
alter table orders add column discount_code text;
-- Net (before GST) discount on the items.
alter table orders add column discount_cents bigint not null default 0;
alter table order_lines add column discount_cents bigint not null default 0;

-- ---------- paying online ----------
alter table orders drop constraint orders_payment_method_check;
alter table orders add constraint orders_payment_method_check check (payment_method in ('bank_transfer', 'cash_on_delivery', 'pay_at_pickup', 'online'));

-- A business's account with a payment provider (credentials encrypted like certificate keys).
create table payment_accounts (
  tenant_id             uuid not null references tenants (id),
  provider              text not null check (provider in ('paypal', 'test')),
  public_id             text,
  credentials_encrypted text,
  mode                  text not null default 'sandbox' check (mode in ('sandbox', 'live')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (tenant_id, provider)
);

create table order_payments (
  id             uuid primary key,
  tenant_id      uuid not null references tenants (id),
  order_id       uuid not null references orders (id),
  provider       text not null,
  -- The provider's id for the checkout (e.g. the PayPal order id).
  reference      text,
  status         text not null check (status in ('pending', 'paid', 'failed', 'cancelled')),
  amount_cents   bigint not null,
  currency       text not null,
  charged_amount text,
  transaction_id text,
  detail         jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index order_payments_order on order_payments (order_id);
create index order_payments_pending on order_payments (status, created_at) where status = 'pending';

-- ---------- custom domains for storefronts ----------
create table store_domains (
  domain             text primary key,
  tenant_id          uuid not null references tenants (id),
  verification_token text not null,
  verified_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index store_domains_tenant on store_domains (tenant_id);
