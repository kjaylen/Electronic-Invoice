-- The most a cashier may take off a line at the counter or a till, in percent (line and sale
-- discounts together). Null: no limit. Managers, admins and owners are never limited.

alter table tenants add column cashier_discount_limit numeric(5, 2)
  check (cashier_discount_limit is null or (cashier_discount_limit >= 0 and cashier_discount_limit <= 100));
