-- Business tax and what is due when: the kinds of receipts a business has and
-- the rate for each (trade 1.75%, a profession 6%, rents 3%...), which
-- returns it files, whether it wants the monthly reminder, and dates of its
-- own (trade licence, Social Security, insurance). Null: the defaults.
alter table tenants add column tax_settings jsonb;
