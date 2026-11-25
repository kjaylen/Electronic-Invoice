-- Hospitality: a restaurant, bar or hotel switches the module on
-- (tenants.venue). Everything here is unused by a business that does not.

-- Which kinds of venue the business is, and the module's settings (src/venue/settings.ts).
alter table tenants add column venue jsonb;

-- People who work a floor, a bar, a kitchen, the rooms.
alter table users drop constraint users_role;
alter table users add constraint users_role check (role in
  ('owner', 'admin', 'manager', 'cashier', 'accountant', 'supervisor', 'server', 'bartender', 'host', 'kitchen', 'housekeeper'));

-- A floor plan: one area (dining room, patio, bar) in one layout (standard,
-- weekday, event). Its tables, stools, walls and fixtures are items with a
-- position; a table keeps its id for as long as it exists, in every layout.
create table venue_floor_plans (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  area       text not null,
  layout     text not null default 'Standard',
  position   integer not null default 0,
  items      jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);
create unique index venue_floor_plans_name on venue_floor_plans (tenant_id, lower(area), lower(layout));

-- Service periods (breakfast, lunch, dinner, late night: a menu and its
-- prices by the clock) and promotions (happy hour, two-for-one, bundles:
-- price rules that start and stop by themselves).
create table venue_periods (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  kind       text not null check (kind in ('menu', 'promotion')),
  name       text not null,
  -- 0 Sunday to 6 Saturday; minutes from midnight; an end before the start runs past midnight.
  days       integer[] not null default '{0,1,2,3,4,5,6}',
  starts_min integer not null check (starts_min between 0 and 1439),
  ends_min   integer not null check (ends_min between 0 and 1439),
  -- A menu: the categories on it (empty: everything) and prices that differ from the catalog's.
  categories text[] not null default '{}',
  prices     jsonb not null default '{}',
  -- A promotion: its rules (src/venue/pricing.ts).
  rules      jsonb not null default '[]',
  active     boolean not null default true,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index venue_periods_tenant on venue_periods (tenant_id, kind, position);

-- Preparation stations. Each prints on a till's printer, shows on a kitchen
-- screen, or both; when its printer cannot print, the fallback station's does.
create table venue_stations (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  categories  text[] not null default '{}',
  -- The till whose printer prints this station's tickets (none: the till that sends the order).
  device_id   uuid references pos_devices (id),
  screen      boolean not null default false,
  fallback_id uuid references venue_stations (id),
  -- Minutes after which a ticket on the screen is late.
  target_min  integer not null default 12,
  position    integer not null default 0,
  archived_at timestamptz
);
create unique index venue_stations_name on venue_stations (tenant_id, lower(name)) where archived_at is null;

-- The menu on top of the catalog.
alter table items add column allergens text[] not null default '{}';
alter table items add column dietary text[] not null default '{}';
-- "86": sold out, or how many are left (counts down as they are ordered).
alter table items add column sold_out boolean not null default false;
alter table items add column remaining integer check (remaining is null or remaining >= 0);
-- Stations that make it when its category does not say (or says something else).
alter table items add column station_ids uuid[];
-- 0 drinks, 1 starters, 2 mains, 3 desserts: where it goes when ordered without saying.
alter table items add column course smallint check (course is null or course between 0 and 3);

create table modifier_groups (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  -- At least and at most this many choices; min 1 makes the group required.
  min_choices integer not null default 0 check (min_choices >= 0),
  max_choices integer not null default 1 check (max_choices >= 1),
  position    integer not null default 0,
  archived_at timestamptz,
  check (min_choices <= max_choices)
);
create index modifier_groups_tenant on modifier_groups (tenant_id);
create table modifiers (
  id          uuid primary key,
  group_id    uuid not null references modifier_groups (id),
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  price_cents bigint not null default 0,
  is_default  boolean not null default false,
  -- A choice that is itself something in stock (the side, the soft drink of a combo): sold with the item.
  item_id     uuid references items (id),
  position    integer not null default 0,
  archived_at timestamptz
);
create index modifiers_group on modifiers (group_id);
create table item_modifier_groups (
  item_id  uuid not null references items (id),
  group_id uuid not null references modifier_groups (id),
  position integer not null default 0,
  primary key (item_id, group_id)
);

-- Waste and spillage are their own reasons in the stock history.
alter table stock_movements drop constraint stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check check (reason in
  ('initial', 'sale', 'sale_reversed', 'order', 'order_cancelled', 'refund', 'receive', 'count', 'damaged', 'lost', 'returned', 'other', 'transfer_out', 'transfer_in', 'waste', 'spillage'));

-- Tax values as dated configuration: a business's own value for a rule,
-- from a day on (src/venue/tax-rules.ts holds the defaults and their sources).
create table venue_tax_rules (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  key        text not null,
  value      text not null,
  valid_from date not null,
  note       text,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index venue_tax_rules_tenant on venue_tax_rules (tenant_id, key, valid_from desc);
