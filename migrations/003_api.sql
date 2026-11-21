-- HTTP API: per-tenant API keys and idempotency keys for issuing.

-- API keys for software clients (POS, accounting connectors, the web app's backend).
-- Only a SHA-256 hash of the secret is stored; the prefix identifies the key without revealing it.
create table api_keys (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  name         text not null,
  prefix       text not null unique,
  key_hash     text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_tenant on api_keys (tenant_id);

-- Idempotency-Key header on POST /v1/documents: a retried request returns the
-- original response instead of issuing a second document for the same sale.
create table idempotency_keys (
  tenant_id     uuid not null references tenants (id),
  key           text not null,
  request_hash  text not null,
  status        text not null check (status in ('in_progress', 'completed')),
  response_code integer,
  response_body jsonb,
  document_id   uuid references documents (id),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  primary key (tenant_id, key)
);
