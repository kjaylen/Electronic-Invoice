-- Categories group items (Coffee, Bakery, Hardware…): the counter's quick buttons, the item list,
-- sales by category and price changes by category. Each document line now also records the item
-- it was sold from, when it was, so sales can be counted by category.

alter table items add column category text check (category is null or length(category) between 1 and 80);
create index items_tenant_category on items (tenant_id, lower(category)) where category is not null and archived_at is null;
alter table document_lines add column item_id uuid references items (id);
