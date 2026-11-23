-- Repeating expenses (rent, internet, a phone plan): recorded on their own on schedule, as a bill
-- to pay or as already paid. Each expense they record points back to them.

create table recurring_expenses (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  supplier_id   uuid references suppliers (id),
  supplier_name text not null,
  supplier_tin  text,
  category      text not null,
  description   text,
  gst_treatment text not null check (gst_treatment in ('standard', 'zero', 'exempt', 'none')),
  total_cents   bigint not null check (total_cents > 0),
  frequency     text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  -- The day of the month it falls on (the 31st becomes the month's last day).
  anchor_day    integer not null check (anchor_day between 1 and 31),
  next_date     date not null,
  end_date      date,
  -- A bill due this many days after its date; ignored when paid_by is set (paid on the day).
  due_days      integer not null default 0 check (due_days between 0 and 90),
  paid_by       text check (paid_by is null or paid_by in ('cash', 'cheque', 'bank_transfer', 'card', 'online', 'other')),
  active        boolean not null default true,
  last_run      date,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now()
);
create index recurring_expenses_due on recurring_expenses (next_date) where active;
create index recurring_expenses_tenant on recurring_expenses (tenant_id);

alter table expenses add column recurring_expense_id uuid references recurring_expenses (id);
