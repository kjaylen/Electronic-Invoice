-- Online store, phase 1: products with variants and photos, a storefront per
-- business, checkout with offline payments, and orders that become BTS
-- documents when paid.

-- Store settings (enabled, delivery zones, pickup, payment methods) and order numbers per business.
alter table tenants add column store_settings jsonb not null default '{}'::jsonb;
alter table tenants add column next_order_number integer not null default 1001;

-- A product groups items: each item is one variant (size, colour...). Items without a
-- product still work at the counter and on invoices; they are just not in the store.
create table products (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  title        text not null,
  handle       text not null check (handle ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$|^[a-z0-9]$'),
  description  text not null default '',
  status       text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  option1_name text,
  option2_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, handle)
);
create index products_tenant_status on products (tenant_id, status);

alter table items add column product_id uuid references products (id);
alter table items add column option1 text;
alter table items add column option2 text;
-- Null: stock not tracked (always available).
alter table items add column stock_quantity integer check (stock_quantity is null or stock_quantity >= 0);
alter table items add column position integer not null default 0;
create index items_product on items (product_id);

-- Photos, stored in the database for now (move to object storage when volume calls for it).
create table product_images (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  product_id   uuid not null references products (id),
  position     integer not null default 0,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        integer not null,
  data         bytea not null,
  created_at   timestamptz not null default now()
);
create index product_images_product on product_images (product_id, position);

-- ---------- orders ----------
create table orders (
  id                 uuid primary key,
  tenant_id          uuid not null references tenants (id),
  number             integer not null,
  -- The buyer's link to the order page carries a token; only its hash is stored.
  token_hash         text not null,
  status             text not null default 'open' check (status in ('open', 'cancelled')),
  payment_status     text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  fulfillment_status text not null default 'unfulfilled' check (fulfillment_status in ('unfulfilled', 'fulfilled')),
  payment_method     text not null check (payment_method in ('bank_transfer', 'cash_on_delivery', 'pay_at_pickup')),
  fulfillment        text not null check (fulfillment in ('delivery', 'pickup')),
  delivery_zone      text,
  delivery_fee       numeric(24, 6) not null default 0,
  customer_name      text not null,
  customer_email     text,
  customer_phone     text not null,
  street             text,
  city               text,
  district_code      char(1) check (district_code between '1' and '6'),
  -- A buyer who gives a TIN (and business name) gets a tax invoice instead of a receipt.
  buyer_tin          char(6),
  buyer_name         text,
  note               text,
  line_extension_cents bigint not null,
  gst_cents          bigint not null,
  total_cents        bigint not null,
  document_id        uuid references documents (id),
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  paid_by            uuid references users (id),
  fulfilled_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  unique (tenant_id, number)
);
create index orders_tenant_created on orders (tenant_id, created_at desc);
create index orders_tenant_open on orders (tenant_id, status, payment_status, fulfillment_status);

create table order_lines (
  order_id              uuid not null references orders (id),
  tenant_id             uuid not null references tenants (id),
  line_number           integer not null,
  item_id               uuid references items (id),
  product_title         text not null,
  variant_title         text,
  seller_code           text,
  quantity              numeric(24, 6) not null check (quantity > 0),
  unit_code             text not null,
  unit_price            numeric(24, 6) not null,
  gst_category          char(1) not null,
  exemption_reason_code text,
  total_cents           bigint not null,
  primary key (order_id, line_number)
);
