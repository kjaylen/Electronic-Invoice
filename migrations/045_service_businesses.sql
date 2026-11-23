-- Businesses that sell services, not (only) goods.

-- What the business sells: the app leaves out what does not apply (stock,
-- the online store's products) and speaks of services where it fits.
alter table tenants add column sells text not null default 'both' check (sells in ('products', 'services', 'both'));

-- Billable work: time or jobs done for a customer, invoiced together later.
-- Once on an invoice it keeps the document it went on and cannot change.
create table work_entries (
  id                    uuid primary key,
  tenant_id             uuid not null references tenants (id),
  customer_id           uuid not null references customers (id),
  user_id               uuid references users (id),
  item_id               uuid references items (id),
  work_date             date not null,
  description           text not null check (length(description) between 1 and 300),
  quantity              numeric(12, 2) not null check (quantity > 0),
  unit_code             text not null default 'HUR' check (unit_code ~ '^[A-Z0-9]{1,3}$'),
  -- Before GST, like an item's price.
  unit_price            numeric(24, 6) not null check (unit_price >= 0),
  gst_category          text not null default 'S' check (gst_category in ('S', 'Z', 'E')),
  exemption_reason_code text,
  document_id           uuid references documents (id),
  billed_at             timestamptz,
  -- Claimed while its invoice is being issued, so two people cannot bill it twice.
  invoicing_at          timestamptz,
  created_at            timestamptz not null default now(),
  check ((document_id is null) = (billed_at is null))
);
create index work_entries_unbilled on work_entries (tenant_id, customer_id) where document_id is null;
create index work_entries_tenant_date on work_entries (tenant_id, work_date desc);
