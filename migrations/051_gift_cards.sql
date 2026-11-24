-- Gift cards. A card holds money a customer paid in advance (or that the
-- business gave): sold or given in the app, used to pay at the counter, on
-- a till or in the online store, partly or in full.
--
-- Selling a card is not a taxed sale: GST is charged when the card is used,
-- on that sale's own receipt, where the card is how part of it was paid.
-- So a card sale has no BTS document; it is recorded here (and, paid in
-- cash, counted in the shift's drawer).

create table gift_cards (
  id              uuid primary key,
  tenant_id       uuid not null references tenants (id),
  -- The code is a bearer secret: a hash finds it, the code itself is kept encrypted
  -- (to email it again); staff see the last four characters.
  code_hash       text not null,
  code_encrypted  text not null,
  last4           char(4) not null,
  initial_cents   bigint not null check (initial_cents > 0),
  balance_cents   bigint not null check (balance_cents >= 0),
  status          text not null default 'active' check (status in ('active', 'disabled')),
  expires_on      date,
  -- Sold (paid for) or given by the business (store credit, a prize, a goodwill gesture).
  source          text not null check (source in ('sold', 'given')),
  paid_by         text check (paid_by in ('cash', 'card', 'bank_transfer')),
  recipient_name  text,
  recipient_email text,
  message         text,
  note            text,
  created_by      uuid references users (id),
  device_id       uuid,
  -- Sold for cash at a till or counter: in that drawer's shift.
  shift_id        uuid references register_shifts (id),
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  unique (tenant_id, code_hash),
  check ((source = 'sold') = (paid_by is not null))
);
create index gift_cards_tenant on gift_cards (tenant_id, created_at desc);
create index gift_cards_shift on gift_cards (shift_id) where shift_id is not null;

-- Everything that changed a card's balance, with what it was for.
create table gift_card_activity (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  gift_card_id  uuid not null references gift_cards (id),
  kind          text not null check (kind in ('issued', 'used', 'returned', 'adjusted', 'disabled', 'enabled')),
  -- Signed: used is negative; returned and issued positive.
  amount_cents  bigint not null default 0,
  balance_after bigint not null,
  document_id   uuid references documents (id),
  order_id      uuid references orders (id),
  user_id       uuid references users (id),
  note          text,
  -- A use given back because its sale was rejected or cancelled (once).
  reverses_id   uuid unique references gift_card_activity (id),
  created_at    timestamptz not null default now()
);
create index gift_card_activity_card on gift_card_activity (gift_card_id, created_at);
create index gift_card_activity_document on gift_card_activity (document_id) where document_id is not null;

-- An online order paid (partly or fully) with a gift card.
alter table orders add column gift_card_id uuid references gift_cards (id);
alter table orders add column gift_card_cents bigint not null default 0 check (gift_card_cents >= 0);
alter table orders drop constraint orders_payment_method_check;
alter table orders add constraint orders_payment_method_check check (payment_method in ('bank_transfer', 'cash_on_delivery', 'pay_at_pickup', 'online', 'gift_card'));
