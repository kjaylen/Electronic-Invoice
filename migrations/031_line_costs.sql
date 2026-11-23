-- What each line sold from the catalog cost the business: the item's average cost (before GST)
-- when the document was issued. Gross margin by item and category comes from it.

alter table document_lines add column unit_cost numeric(24, 6) check (unit_cost is null or unit_cost >= 0);
