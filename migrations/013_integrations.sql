-- Accounting integrations (QuickBooks Online first): the connection, and what
-- has been sent.

create table integration_connections (
  tenant_id         uuid not null references tenants (id),
  provider          text not null check (provider in ('quickbooks')),
  status            text not null check (status in ('connected', 'needs_reconnect')),
  -- The QuickBooks company (realm) and its name.
  account_id        text not null,
  account_name      text,
  tokens_encrypted  text not null,
  access_expires_at timestamptz not null,
  -- { taxCodes: { S, Z, E }, itemId, gstItemId } — set on first sync or by the business.
  settings          jsonb not null default '{}'::jsonb,
  -- Documents issued from this day on are sent.
  sync_from         date not null,
  connected_by      uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, provider)
);

-- The OAuth "state" between sending the person to the provider and their return.
create table integration_oauth_states (
  state_hash text primary key,
  tenant_id  uuid not null references tenants (id),
  provider   text not null,
  user_id    uuid references users (id),
  expires_at timestamptz not null
);

create table integration_syncs (
  tenant_id       uuid not null references tenants (id),
  provider        text not null,
  document_id     uuid not null references documents (id),
  status          text not null check (status in ('pending', 'synced', 'failed', 'skipped')),
  remote_type     text,
  remote_id       text,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error           text,
  synced_at       timestamptz,
  -- Set when the document was cancelled with BTS and the accounting copy voided too.
  voided_at       timestamptz,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, provider, document_id)
);
create index integration_syncs_due on integration_syncs (next_attempt_at) where status = 'pending';

-- Customers already matched in the accounting system (by our customer, or by name and TIN).
create table integration_customer_refs (
  tenant_id  uuid not null references tenants (id),
  provider   text not null,
  local_key  text not null,
  remote_id  text not null,
  primary key (tenant_id, provider, local_key)
);
