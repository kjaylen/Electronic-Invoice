-- How much a customer may owe on account (invoices not yet paid). Null: no limit.
alter table customers add column credit_limit_cents bigint check (credit_limit_cents is null or credit_limit_cents >= 0);
