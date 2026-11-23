-- Bundles: an item made of other items (a breakfast combo, a gift basket). Selling one takes its
-- components off the shelf; its cost is theirs added up.

create table item_components (
  item_id      uuid not null references items (id),
  component_id uuid not null references items (id),
  quantity     numeric(18, 3) not null check (quantity > 0),
  primary key (item_id, component_id),
  check (item_id <> component_id)
);
create index item_components_component on item_components (component_id);
