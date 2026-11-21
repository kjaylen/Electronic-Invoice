-- Web app features: editable catalog, password reset, teammates, sending documents.

-- Customers and items can be edited and archived. Issued documents keep their
-- own snapshot of the customer and lines, so edits never change them.
alter table customers add column archived_at timestamptz;
alter table items add column archived_at timestamptz;
alter table items add column barcode text;
alter table items add column favorite boolean not null default false;
create unique index items_barcode on items (tenant_id, barcode) where barcode is not null and archived_at is null;
create index documents_tenant_issue_date on documents (tenant_id, issue_date);
create index documents_tenant_customer on documents (tenant_id, customer_id);

-- Password reset: one-time tokens, stored hashed, valid for an hour.
create table password_resets (
  id         uuid primary key,
  user_id    uuid not null references users (id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index password_resets_user on password_resets (user_id);

-- Invitations to join a business, stored hashed, valid for 7 days.
create table invitations (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  email       text not null,
  role        text not null check (role in ('owner', 'member')),
  token_hash  text not null unique,
  invited_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create index invitations_tenant on invitations (tenant_id);

-- Links customers can open to get the printed copy of one document.
create table share_links (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  document_id uuid not null references documents (id),
  token_hash  text not null unique,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index share_links_document on share_links (document_id);

-- Documents sent to customers by email.
create table document_messages (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  document_id uuid not null references documents (id),
  channel     text not null check (channel in ('email')),
  recipient   text not null,
  status      text not null check (status in ('sent', 'failed')),
  error       text,
  sent_by     uuid references users (id),
  created_at  timestamptz not null default now()
);
create index document_messages_document on document_messages (document_id);
