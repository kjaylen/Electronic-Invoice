-- Layaway: goods put aside for a customer who pays over time (src/api/layaways.ts).
--
-- A layaway is a tax invoice on the customer's account whose goods stay in the
-- shop until it is paid: the invoice takes the goods off the shelf, payments
-- are recorded against it like any invoice's, and the customer collects when
-- nothing is owed. Cancelling it is a credit note for the whole invoice: the
-- goods go back on the shelf and what was paid is given back.
create table layaways (
  -- The invoice.
  document_id        uuid primary key references documents (id),
  tenant_id          uuid not null references tenants (id),
  customer_id        uuid references customers (id),
  -- The goods are kept until this day.
  hold_until         date not null,
  status             text not null default 'open' check (status in ('open', 'collected', 'cancelled')),
  -- The sale's lines as they were sold, so a cancellation credits exactly them.
  lines              jsonb not null,
  note               text,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  collected_at       timestamptz,
  collected_by       uuid references users (id),
  cancelled_at       timestamptz,
  cancelled_by       uuid references users (id),
  -- The credit note that cancelled it, and what was given back to the customer.
  credit_document_id uuid references documents (id),
  refund_cents       bigint
);
create index layaways_tenant on layaways (tenant_id, status, hold_until);
