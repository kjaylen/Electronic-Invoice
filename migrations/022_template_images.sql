-- Images a business uploads for its templates (its logo, a banner, a signature), used in Liquid
-- with {{ 'logo.png' | asset_url }}. One of them can be the business's logo ({{ business.logo }}),
-- which the default templates and the built-in layouts print.

create table template_assets (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  name         text not null,
  content_type text not null,
  bytes        integer not null,
  width        integer,
  height       integer,
  data         bytea not null,
  created_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table tenants add column logo_asset_id uuid references template_assets (id) on delete set null;
