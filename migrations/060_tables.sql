-- Tables: a bar or restaurant's open tabs (src/api/held.ts, src/commerce/counter.ts).
--
-- A table's tab is a held sale that belongs to a table: it is opened, added to
-- over the evening from any till, and paid like any sale. One open tab per
-- table, whichever till opens it.
alter table held_sales add column table_name text;
create unique index held_sales_table on held_sales (tenant_id, lower(table_name)) where table_name is not null;
