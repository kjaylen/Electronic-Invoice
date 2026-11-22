-- Cash registers and shifts: a shift opens a drawer with a float; the sales,
-- invoice payments and refunds made by whoever opened it attach to it; cash
-- paid in and out is recorded; closing counts the drawer against what should
-- be there. The end-of-day (Z) report comes from all of it.

-- The payment means on each document (10 cash, 48 card, 30 transfer, 20 cheque...), from now on.
alter table documents add column payment_means text;

create table registers (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index registers_name on registers (tenant_id, lower(name)) where archived_at is null;

alter table tenants add column next_shift_number integer not null default 1;

create table register_shifts (
  id                  uuid primary key,
  tenant_id           uuid not null references tenants (id),
  register_id         uuid not null references registers (id),
  number              integer not null,
  opened_by           uuid not null references users (id),
  opened_at           timestamptz not null default now(),
  opening_float_cents bigint not null check (opening_float_cents >= 0),
  closed_by           uuid references users (id),
  closed_at           timestamptz,
  expected_cash_cents bigint,
  counted_cash_cents  bigint check (counted_cash_cents is null or counted_cash_cents >= 0),
  -- Notes and coins counted: { "100": 3, "0.25": 12, ... }
  counted_detail      jsonb,
  close_note          text,
  unique (tenant_id, number)
);
-- One open shift per drawer, and per person.
create unique index register_shifts_open_register on register_shifts (register_id) where closed_at is null;
create unique index register_shifts_open_user on register_shifts (tenant_id, opened_by) where closed_at is null;
create index register_shifts_tenant on register_shifts (tenant_id, opened_at desc);

alter table documents add column shift_id uuid references register_shifts (id);
create index documents_shift on documents (shift_id) where shift_id is not null;
alter table invoice_payments add column shift_id uuid references register_shifts (id);

-- Cash put into or taken out of the drawer during a shift (change from the bank, petty cash, a bank drop).
-- Permanent: a mistake is corrected with the opposite movement.
create table cash_movements (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  shift_id     uuid not null references register_shifts (id),
  kind         text not null check (kind in ('pay_in', 'pay_out')),
  amount_cents bigint not null check (amount_cents > 0),
  reason       text not null,
  created_by   uuid references users (id),
  created_at   timestamptz not null default now()
);
create index cash_movements_shift on cash_movements (shift_id);
create trigger cash_movements_permanent before update or delete on cash_movements
  for each row execute function forbid_change();
