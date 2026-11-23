-- Wholesale prices: an item can have a second price (before GST) for customers on the wholesale
-- price list. Documents keep the price they were issued at, whichever list it came from.

alter table items add column wholesale_price numeric(24, 6) check (wholesale_price is null or wholesale_price >= 0);
alter table customers add column price_list text not null default 'retail' check (price_list in ('retail', 'wholesale'));
