-- Quotes (estimates) and recurring invoices. Neither is a tax document:
-- they hold what will be issued (the same body as POST /v1/documents), and
-- become tax invoices through the normal issuing pipeline.

-- ---------- quotes ----------
alter table tenants add column next_quote_number integer not null default 1001;

create table quotes (
  id                uuid primary key,
  tenant_id         uuid not null references tenants (id),
  number            integer not null,
  status            text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'invoiced', 'cancelled')),
  -- What will be issued: the POST /v1/documents body, with every line's price written out.
  body              jsonb not null,
  customer_id       uuid references customers (id),
  customer_snapshot jsonb,
  subtotal_cents    bigint not null,
  gst_cents         bigint not null,
  total_cents       bigint not null,
  valid_until       date not null,
  -- When invoiced: the payment is due this many days after the invoice.
  due_days          integer not null default 30 check (due_days between 0 and 365),
  sent_at           timestamptz,
  accepted_at       timestamptz,
  accepted_by       text,
  declined_at       timestamptz,
  decline_reason    text,
  document_id       uuid references documents (id),
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, number)
);
create index quotes_tenant on quotes (tenant_id, created_at desc);

-- Links the customer opens to see, accept or decline a quote (the token is kept hashed).
create table quote_links (
  token_hash  text primary key,
  tenant_id   uuid not null references tenants (id),
  quote_id    uuid not null references quotes (id),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index quote_links_quote on quote_links (quote_id);

-- ---------- recurring invoices ----------
create table recurring_invoices (
  id                uuid primary key,
  tenant_id         uuid not null references tenants (id),
  name              text not null,
  body              jsonb not null,
  customer_id       uuid references customers (id),
  customer_snapshot jsonb,
  total_cents       bigint not null,
  frequency         text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  interval_count    integer not null default 1 check (interval_count between 1 and 12),
  -- The day of the month (or of the year's month) the schedule keeps to: a 31st falls back to the month's last day.
  anchor_day        integer not null check (anchor_day between 1 and 31),
  next_date         date not null,
  end_date          date,
  remaining         integer check (remaining is null or remaining >= 0),
  due_days          integer not null default 30 check (due_days between 0 and 365),
  auto_send         boolean not null default true,
  status            text not null default 'active' check (status in ('active', 'paused', 'finished')),
  last_document_id  uuid references documents (id),
  last_error        text,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index recurring_due on recurring_invoices (next_date) where status = 'active';

-- Each scheduled date is issued once, whichever process gets there first.
create table recurring_runs (
  recurring_id  uuid not null references recurring_invoices (id),
  run_date      date not null,
  status        text not null check (status in ('claimed', 'issued', 'failed')),
  document_id   uuid references documents (id),
  error         text,
  -- Emailed to the customer (once).
  emailed_at    timestamptz,
  created_at    timestamptz not null default now(),
  primary key (recurring_id, run_date)
);
