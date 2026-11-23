-- Loyalty points: saved customers earn points on what they buy and use them as a reward (a
-- discount on a later sale). Every change is an entry; a customer's balance is the sum.

alter table tenants add column loyalty jsonb;

create table loyalty_entries (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  customer_id uuid not null references customers (id),
  points      integer not null check (points <> 0),
  reason      text not null check (reason in ('earned', 'redeemed', 'reversed', 'adjusted')),
  document_id uuid references documents (id),
  -- An entry undone because its document was rejected or cancelled: the entry it undoes, once.
  reverses_id uuid unique references loyalty_entries (id),
  note        text,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now()
);
create index loyalty_entries_customer on loyalty_entries (customer_id, created_at desc);
create index loyalty_entries_document on loyalty_entries (document_id) where document_id is not null;
