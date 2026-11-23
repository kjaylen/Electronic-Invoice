-- An order ready for pickup, or out for delivery: when the buyer was told.
alter table orders add column ready_at timestamptz;
