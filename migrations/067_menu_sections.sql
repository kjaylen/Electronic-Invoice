-- The menu's sections (Starters, Mains, Drinks…) in the order the business puts them. A section is an
-- item category: what is in it is the items with that category, so the counter's quick buttons, sales
-- by category and the stations that make a category follow the menu. This table only holds the order,
-- and sections made before anything is in them.
create table venue_menu_sections (
  tenant_id  uuid not null references tenants (id),
  name       text not null check (length(name) between 1 and 80),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index venue_menu_sections_name on venue_menu_sections (tenant_id, lower(name));
