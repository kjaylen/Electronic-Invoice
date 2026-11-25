-- Guests, table reservations, the waitlist, deposits, and the day's close.

-- A guest of the venue: someone who books, waits, eats or stays. Their
-- history, preferences and allergies follow them to the host and the server.
create table venue_guests (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  phone       text,
  email       text,
  allergies   text,
  preferences text,
  notes       text,
  -- The customer record used when something is invoiced to them (a room charge).
  customer_id uuid references customers (id),
  visits      integer not null default 0,
  no_shows    integer not null default 0,
  last_visit  date,
  created_at  timestamptz not null default now()
);
create index venue_guests_tenant on venue_guests (tenant_id, lower(name));
create index venue_guests_phone on venue_guests (tenant_id, phone) where phone is not null;

create table venue_reservations (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  guest_id      uuid references venue_guests (id),
  name          text not null,
  phone         text,
  email         text,
  party_size    integer not null check (party_size between 1 and 200),
  starts_at     timestamptz not null,
  duration_min  integer not null check (duration_min between 15 and 720),
  -- The tables held for it (ids on the floor plan); none: a table is found when they arrive.
  table_ids     text[] not null default '{}',
  status        text not null default 'booked' check (status in ('booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
  occasion      text,
  allergy       text,
  notes         text,
  check_id      uuid,
  confirmation_sent_at timestamptz,
  reminder_sent_at     timestamptz,
  cancelled_at  timestamptz,
  cancel_reason text,
  created_by    uuid references users (id),
  created_at    timestamptz not null default now()
);
create index venue_reservations_day on venue_reservations (tenant_id, starts_at);

create table venue_waitlist (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  guest_id    uuid references venue_guests (id),
  name        text not null,
  phone       text,
  party_size  integer not null check (party_size between 1 and 200),
  quoted_min  integer not null default 15,
  notes       text,
  status      text not null default 'waiting' check (status in ('waiting', 'notified', 'seated', 'left')),
  added_at    timestamptz not null default now(),
  notified_at timestamptz,
  ended_at    timestamptz,
  check_id    uuid
);
create index venue_waitlist_open on venue_waitlist (tenant_id, added_at) where status in ('waiting', 'notified');

-- Money taken ahead of a table booking or a hotel stay. A tax receipt is
-- issued when it is taken; when it is used, that receipt is credited and the
-- amount counts as a payment on the final bill (ETD-MAPPING.md).
create table venue_deposits (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  kind          text not null check (kind in ('table', 'room')),
  ref_id        uuid not null,
  amount_cents  bigint not null check (amount_cents > 0),
  method        text not null,
  document_id   uuid not null references documents (id),
  status        text not null default 'held' check (status in ('held', 'applied', 'refunded', 'kept')),
  credit_document_id uuid references documents (id),
  applied_document_id uuid references documents (id),
  created_by    uuid references users (id),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
create index venue_deposits_ref on venue_deposits (ref_id);

-- A business day, closed: the day report as it stood, and who closed it.
create table venue_days (
  tenant_id     uuid not null references tenants (id),
  business_date date not null,
  closed_at     timestamptz not null default now(),
  closed_by     uuid references users (id),
  report        jsonb not null,
  primary key (tenant_id, business_date)
);
