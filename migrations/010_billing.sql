-- Billing for the platform itself: each business's plan, and the invoices the
-- platform sends them (issued as BTS e-invoices by the platform's own business).

create table subscriptions (
  tenant_id            uuid primary key references tenants (id),
  plan                 text not null check (plan in ('starter', 'business', 'pro')),
  status               text not null check (status in ('trialing', 'active', 'past_due', 'suspended')),
  trial_ends_at        timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  -- A change that waits for the end of the period (a downgrade, or 'starter' to cancel).
  next_plan            text check (next_plan in ('starter', 'business', 'pro')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table billing_invoices (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  plan          text not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  net_cents     bigint not null,
  gst_cents     bigint not null,
  total_cents   bigint not null,
  status        text not null check (status in ('open', 'paid', 'void')),
  due_at        timestamptz not null,
  -- The platform business's document for this invoice (null when no billing business is set up).
  document_id   uuid references documents (id),
  paid_at       timestamptz,
  paid_reference text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, period_start)
);
create index billing_invoices_open on billing_invoices (status, due_at);

-- Businesses that exist today start a 30-day trial of the Business plan.
insert into subscriptions (tenant_id, plan, status, trial_ends_at)
select id, 'business', 'trialing', now() + interval '30 days' from tenants;
