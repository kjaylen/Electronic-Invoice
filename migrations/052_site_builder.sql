-- The site builder: a store's look and pages, edited as a draft and published
-- when ready (customers only ever see the published site), with earlier
-- published versions kept to go back to. Collections group products for
-- pages, menus and sections. Products get a "was" price, a badge and tags.

create table store_sites (
  tenant_id        uuid primary key references tenants (id),
  -- The whole site (theme, header, footer, pages and their sections) as one document; see src/commerce/site.ts.
  draft            jsonb not null,
  draft_updated_at timestamptz not null default now(),
  draft_updated_by uuid references users (id),
  published        jsonb,
  published_at     timestamptz,
  published_by     uuid references users (id)
);

create table store_site_versions (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  content      jsonb not null,
  note         text,
  published_by uuid references users (id),
  created_at   timestamptz not null default now()
);
create index store_site_versions_tenant on store_site_versions (tenant_id, created_at desc);

-- A collection is a page of products: picked by hand, or every product matching its rules.
create table store_collections (
  id              uuid primary key,
  tenant_id       uuid not null references tenants (id),
  handle          text not null check (handle ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title           text not null,
  description     text not null default '',
  -- An image reference as the site builder stores it ("a:<asset id>" or "p:<product photo id>").
  image           text,
  -- Null: picked by hand. Otherwise { match: 'all' | 'any', conditions: [{ field, op, value }] }.
  rules           jsonb,
  sort            text not null default 'manual' check (sort in ('manual', 'newest', 'price_asc', 'price_desc', 'title', 'best_selling')),
  published       boolean not null default true,
  seo_title       text,
  seo_description text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, handle)
);

create table store_collection_products (
  collection_id uuid not null references store_collections (id) on delete cascade,
  product_id    uuid not null references products (id),
  position      integer not null default 0,
  primary key (collection_id, product_id)
);
create index store_collection_products_product on store_collection_products (product_id);

-- "Was" price (before GST, like the price): shown crossed out while higher than the price.
alter table items add column compare_at_price numeric(24, 6) check (compare_at_price is null or compare_at_price > 0);
-- A label on the product's picture ("New", "Limited", "Best seller").
alter table products add column badge text;
-- Words to group products by (collection rules).
alter table products add column tags text[] not null default '{}';
