-- Contract tax: some customers (government, statutory bodies, larger companies)
-- withhold part of what they pay a contractor and pay it to BTS for them. The
-- invoice keeps its full total; the customer pays the rest.

-- Customers who withhold it: their invoices are marked so by default.
alter table customers add column withholds_contract_tax boolean not null default false;

-- What was withheld on an invoice: the rate and base at the time, so a later
-- change of rate never changes an old invoice. Counts towards its balance like
-- a payment, and the business claims it against its business tax.
create table document_withholdings (
  document_id  uuid primary key references documents (id),
  tenant_id    uuid not null references tenants (id),
  kind         text not null default 'contract_tax' check (kind in ('contract_tax')),
  percent      numeric(5, 2) not null check (percent > 0 and percent < 100),
  base_cents   bigint not null check (base_cents >= 0),
  amount_cents bigint not null check (amount_cents >= 0),
  created_at   timestamptz not null default now()
);
create index document_withholdings_tenant on document_withholdings (tenant_id, created_at);
