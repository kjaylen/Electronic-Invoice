-- Connectors: businesses that keep their own accounting or POS (QuickBooks
-- Desktop, QuickBooks Point of Sale, later NetSuite) and use this service only
-- to send its invoices and receipts to BTS. Their documents are picked up,
-- issued here, and (where the system allows) the BTS number written back.

-- One connected system: a QuickBooks company file reached through the Web
-- Connector (its user name and password), or another source.
create table connector_links (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  kind          text not null check (kind in ('qbd', 'qbpos')),
  name          text not null check (length(name) between 1 and 100),
  -- What the Web Connector signs in with.
  username      text not null unique,
  password_hash text not null,
  -- The .qwc file's OwnerID and FileID.
  owner_id      uuid not null,
  file_id       uuid not null,
  status        text not null default 'active' check (status in ('active', 'paused')),
  -- { taxCodes: { "Tax": "S", "Non": "Z", ... }, exemptions: { code: reason }, pull: { invoices, salesReceipts }, issueOnTaxMismatch }
  settings      jsonb not null default '{}'::jsonb,
  -- Documents dated from this day on are picked up.
  sync_from     date not null,
  -- Where the last pull ended, per kind of document (QuickBooks modified times).
  cursor        jsonb not null default '{}'::jsonb,
  company_name  text,
  last_seen_at  timestamptz,
  last_error    text,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  removed_at    timestamptz
);
create index connector_links_tenant on connector_links (tenant_id) where removed_at is null;

-- A document picked up from a connected system: what was read, what became of
-- it here, and whether its BTS details were written back.
create table connector_imports (
  id              uuid primary key,
  tenant_id       uuid not null references tenants (id),
  link_id         uuid not null references connector_links (id),
  source_type     text not null check (source_type in ('invoice', 'sales_receipt', 'credit_memo', 'pos_receipt')),
  -- The source system's own id (QuickBooks TxnID) and the number people see.
  source_id       text not null,
  source_ref      text,
  -- QuickBooks' EditSequence when read (and after our own write-back), to tell its edits from ours.
  edit_sequence   text,
  source_date     date,
  customer_name   text,
  total_cents     bigint,
  payload         jsonb not null,
  status          text not null default 'new' check (status in ('staged', 'new', 'issuing', 'issued', 'rejected', 'attention', 'skipped')),
  document_id     uuid references documents (id),
  problem         text,
  writeback       text not null default 'none' check (writeback in ('none', 'pending', 'done', 'failed')),
  writeback_error text,
  -- The document status last written back (so a later authorization is written too).
  written_status  text,
  attempts        integer not null default 0,
  -- "Issue anyway": a difference between their tax and our GST is accepted.
  force           boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (link_id, source_type, source_id)
);
create index connector_imports_status on connector_imports (tenant_id, status, created_at desc);
create index connector_imports_todo on connector_imports (status) where status = 'new';
create index connector_imports_writeback on connector_imports (link_id) where writeback = 'pending';

-- A Web Connector session: its ticket and where it is in the exchange.
create table connector_sessions (
  ticket_hash text primary key,
  link_id     uuid not null references connector_links (id),
  state       jsonb not null default '{}'::jsonb,
  last_error  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
