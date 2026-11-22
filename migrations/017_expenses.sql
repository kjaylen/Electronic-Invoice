-- Money out: suppliers, expenses and bills (with a photo or PDF of the
-- receipt), for bills to pay, the GST return (GST paid on purchases against
-- GST charged on sales) and profit and loss.

create table suppliers (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  tin         text check (tin is null or tin ~ '^[0-9]{6}$'),
  email       text,
  telephone   text,
  address     text,
  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index suppliers_tenant on suppliers (tenant_id, lower(name));

create table expenses (
  id                    uuid primary key,
  tenant_id             uuid not null references tenants (id),
  supplier_id           uuid references suppliers (id),
  -- As on the receipt (kept even if the supplier is renamed or there is none saved).
  supplier_name         text not null,
  supplier_tin          text check (supplier_tin is null or supplier_tin ~ '^[0-9]{6}$'),
  -- The supplier's invoice or receipt number.
  reference             text,
  expense_date          date not null,
  -- A bill still to pay: when it is due.
  due_date              date,
  category              text not null,
  description           text,
  -- standard: GST charged at the standard rate; zero: zero-rated; exempt: exempt supply; none: no GST charged (supplier not registered).
  gst_treatment         text not null check (gst_treatment in ('standard', 'zero', 'exempt', 'none')),
  net_cents             bigint not null check (net_cents >= 0),
  gst_cents             bigint not null check (gst_cents >= 0),
  total_cents           bigint not null check (total_cents = net_cents + gst_cents),
  -- The GST can be claimed back (a tax invoice from a GST-registered supplier).
  claim_gst             boolean not null default true,
  paid_on               date,
  payment_method        text check (payment_method is null or payment_method in ('cash', 'cheque', 'bank_transfer', 'card', 'online', 'other')),
  receipt_content_type  text check (receipt_content_type is null or receipt_content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  receipt_bytes         integer,
  receipt_data          bytea,
  receipt_key           text,
  created_by            uuid references users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index expenses_tenant_date on expenses (tenant_id, expense_date desc);
create index expenses_unpaid on expenses (tenant_id, due_date) where paid_on is null;
