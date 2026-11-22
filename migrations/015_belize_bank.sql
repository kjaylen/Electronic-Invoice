-- Belize Bank: card payments (hosted payment page) and E-Kyash as payment
-- providers, and bill payments made in Belize Bank's online banking applied
-- to invoices.

alter table payment_accounts drop constraint payment_accounts_provider_check;
alter table payment_accounts add constraint payment_accounts_provider_check check (provider in ('paypal', 'test', 'belizebank', 'ekyash'));

-- A payment that came from outside (a bank's own reference): recorded once.
alter table invoice_payments add column external_id text;
create unique index invoice_payments_external on invoice_payments (tenant_id, external_id) where external_id is not null;

-- Bill payments: the business is a payee in Belize Bank's online and mobile
-- banking; the bank checks the invoice number with us before taking the
-- payment, then tells us it was paid. The bank authenticates with a bearer
-- token we generate (kept as a hash).
create table bill_payment_accounts (
  tenant_id       uuid primary key references tenants (id),
  token_hash      text not null,
  -- The name of the field (agreed with the bank) that carries the invoice number.
  reference_field text not null default 'referenceNumber',
  enabled         boolean not null default true,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- What the bank sent that could not be applied to an invoice (for the business to sort out).
create table bill_payment_events (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  kind          text not null check (kind in ('validate', 'post', 'reconcile')),
  bank_reference text,
  reference     text,
  amount_cents  bigint,
  outcome       text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index bill_payment_events_tenant on bill_payment_events (tenant_id, created_at desc);
