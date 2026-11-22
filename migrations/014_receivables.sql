-- Getting paid: payments against invoices, due dates, reminders, and paying
-- an invoice online.

-- When an invoice is due (from its payment terms); null on older documents until backfilled.
alter table documents add column due_date date;
create index documents_receivable on documents (tenant_id, etd_type, status) where etd_type in ('01', '03');

-- Payments received against tax invoices and debit notes. Never deleted:
-- a mistake is voided, with who and why. A refund paid back to the customer
-- (an online order refunded) is a negative amount.
create table invoice_payments (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  document_id  uuid not null references documents (id),
  amount_cents bigint not null check (amount_cents <> 0),
  method       text not null check (method in ('cash', 'cheque', 'bank_transfer', 'card', 'online', 'refund', 'other')),
  reference    text,
  paid_on      date not null,
  note         text,
  created_by   uuid references users (id),
  -- Paid online from the invoice's link: the online payment, so it is recorded once.
  online_payment_id uuid unique references order_payments (id),
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid references users (id),
  void_reason  text
);
create index invoice_payments_document on invoice_payments (document_id) where voided_at is null;
create index invoice_payments_tenant on invoice_payments (tenant_id, paid_on);

create trigger invoice_payments_no_delete before delete on invoice_payments
  for each row execute function forbid_change();

-- Payment recorded → webhooks.
create function outbox_payments() returns trigger language plpgsql as $$
begin
  insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'payment.recorded', new.id);
  return new;
end $$;
create trigger invoice_payments_outbox after insert on invoice_payments
  for each row execute function outbox_payments();

-- Reminders and statements: { reminders: { enabled, offsets: [-3, 3, 14, 30] } }
alter table tenants add column receivable_settings jsonb not null default '{}'::jsonb;

-- Paying an invoice online reuses the online payment records.
alter table order_payments alter column order_id drop not null;
alter table order_payments add column document_id uuid references documents (id);
alter table order_payments add constraint order_payments_target check (order_id is not null or document_id is not null);
create index order_payments_document on order_payments (document_id) where document_id is not null;
