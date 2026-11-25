-- How a business sells at the counter (src/commerce/counter.ts), and what a
-- sale carries besides its goods: a service charge and a tip.

-- Totals shown in US dollars too, a service charge, whether tips are taken.
alter table tenants add column counter_settings jsonb not null default '{}'::jsonb;

-- What a line carries on top of quantity x price, before GST: every charge
-- (a service charge, freight), and how much of it is the service charge. Kept
-- with the line so a shift can say what was discounted and what service
-- charge was collected without reading each document again.
alter table document_lines add column charge_cents bigint not null default 0;
alter table document_lines add column service_cents bigint not null default 0;

-- A tip a customer added when paying by card or wallet. It is not part of the
-- sale: not on the tax document, not in the sales figures. The business holds
-- it for its staff; the shift report says how much.
create table sale_tips (
  document_id  uuid primary key references documents (id),
  tenant_id    uuid not null references tenants (id),
  shift_id     uuid references register_shifts (id),
  user_id      uuid references users (id),
  -- How it was paid: the same payment means codes as the sale (48 card, 68 wallet, 10 cash).
  means        text not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at   timestamptz not null default now()
);
create index sale_tips_shift on sale_tips (tenant_id, shift_id);
