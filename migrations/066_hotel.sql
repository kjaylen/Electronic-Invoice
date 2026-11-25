-- The hotel: room types and their rates, rooms, bookings, folios,
-- housekeeping and the night audit.

create table hotel_room_types (
  id                 uuid primary key,
  tenant_id          uuid not null references tenants (id),
  name               text not null,
  capacity           integer not null default 2 check (capacity between 1 and 30),
  -- A night, before taxes, in cents of the currency the type is quoted in.
  rate_cents         bigint not null check (rate_cents >= 0),
  -- Friday and Saturday nights, when they cost something else.
  weekend_rate_cents bigint check (weekend_rate_cents is null or weekend_rate_cents >= 0),
  -- Quoted in US dollars (stored and billed in BZ$ at the venue's rate).
  usd                boolean not null default false,
  min_stay           integer not null default 1 check (min_stay between 1 and 60),
  features           text[] not null default '{}',
  archived_at        timestamptz
);
create unique index hotel_room_types_name on hotel_room_types (tenant_id, lower(name)) where archived_at is null;

-- A season: other rates and another minimum stay between two dates.
create table hotel_seasons (
  id                 uuid primary key,
  tenant_id          uuid not null references tenants (id),
  room_type_id       uuid not null references hotel_room_types (id),
  name               text not null,
  starts_on          date not null,
  ends_on            date not null,
  rate_cents         bigint not null check (rate_cents >= 0),
  weekend_rate_cents bigint,
  min_stay           integer check (min_stay is null or min_stay between 1 and 60),
  check (starts_on <= ends_on)
);
create index hotel_seasons_type on hotel_seasons (room_type_id, starts_on);

create table hotel_rooms (
  id           uuid primary key,
  tenant_id    uuid not null references tenants (id),
  room_type_id uuid not null references hotel_room_types (id),
  name         text not null,
  features     text[] not null default '{}',
  -- Housekeeping: clean, dirty, inspected (checked by a supervisor), out of order.
  status       text not null default 'clean' check (status in ('clean', 'dirty', 'inspected', 'out_of_order')),
  status_note  text,
  status_at    timestamptz,
  status_by    uuid references users (id),
  archived_at  timestamptz
);
create unique index hotel_rooms_name on hotel_rooms (tenant_id, lower(name)) where archived_at is null;

alter table tenants add column next_booking_number integer not null default 1;
create table hotel_bookings (
  id             uuid primary key,
  tenant_id      uuid not null references tenants (id),
  number         integer not null,
  status         text not null default 'booked' check (status in ('booked', 'in_house', 'checked_out', 'cancelled', 'no_show')),
  guest_name     text not null,
  phone          text,
  email          text,
  guest_id       uuid references venue_guests (id),
  customer_id    uuid references customers (id),
  room_type_id   uuid not null references hotel_room_types (id),
  room_id        uuid references hotel_rooms (id),
  arrival        date not null,
  departure      date not null,
  adults         integer not null default 2,
  children       integer not null default 0,
  source         text not null default 'direct' check (source in ('direct', 'phone', 'website', 'agent', 'walk_in')),
  -- Each night's rate in BZ$ cents, fixed when booked: [{ "date": "2026-12-01", "cents": 36000 }].
  nightly        jsonb not null,
  policy         text,
  group_name     text,
  notes          text,
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_by     uuid references users (id),
  created_at     timestamptz not null default now(),
  check (arrival < departure)
);
create index hotel_bookings_dates on hotel_bookings (tenant_id, arrival, departure);
create index hotel_bookings_room on hotel_bookings (room_id) where status in ('booked', 'in_house');

-- A stay's account. Most stays have one folio; a second takes the extras when
-- someone else pays for the room.
create table hotel_folios (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  booking_id uuid not null references hotel_bookings (id),
  name       text not null,
  position   integer not null default 0
);
create index hotel_folios_booking on hotel_folios (booking_id);

create table hotel_folio_lines (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  booking_id    uuid not null references hotel_bookings (id),
  folio_id      uuid not null references hotel_folios (id),
  business_date date not null,
  -- room: a night, posted by the night audit. extra: something typed at the desk. charge: an invoice from an
  -- outlet (restaurant, bar) posted to the room. payment: money received. deposit: a deposit used.
  kind          text not null check (kind in ('room', 'extra', 'charge', 'payment', 'deposit')),
  description   text not null,
  -- What the guest owes for it (positive), or paid (negative). For room and extra lines: before taxes.
  amount_cents  bigint not null,
  -- The tax document: an outlet's invoice (charge), or the invoice a room or extra line went on.
  document_id   uuid references documents (id),
  -- The room the night was spent in.
  room_id       uuid references hotel_rooms (id),
  created_by    uuid references users (id),
  created_at    timestamptz not null default now()
);
create index hotel_folio_lines_booking on hotel_folio_lines (booking_id, created_at);
-- A night is posted once.
create unique index hotel_folio_lines_night on hotel_folio_lines (booking_id, business_date) where kind = 'room';

create table hotel_audits (
  tenant_id     uuid not null references tenants (id),
  business_date date not null,
  report        jsonb not null,
  run_by        uuid references users (id),
  run_at        timestamptz not null default now(),
  primary key (tenant_id, business_date)
);

create table hotel_tasks (
  id            uuid primary key,
  tenant_id     uuid not null references tenants (id),
  business_date date not null,
  room_id       uuid not null references hotel_rooms (id),
  kind          text not null check (kind in ('departure', 'stayover', 'deep')),
  user_id       uuid references users (id),
  done_at       timestamptz,
  done_by       uuid references users (id),
  unique (tenant_id, business_date, room_id)
);
