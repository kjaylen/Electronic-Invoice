-- Templates a business has edited (emails, printed documents, its online store), in Liquid.
-- A template with no row here uses the built-in default. Every save is kept as a version.

create table templates (
  tenant_id  uuid not null references tenants (id),
  key        text not null,
  source     text not null,
  subject    text,
  updated_by uuid references users (id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create table template_versions (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  key        text not null,
  source     text not null,
  subject    text,
  -- Saving a version, or going back to the default (source empty).
  action     text not null check (action in ('saved', 'reverted')),
  saved_by   uuid references users (id),
  saved_at   timestamptz not null default now()
);
create index template_versions_key on template_versions (tenant_id, key, saved_at desc);
