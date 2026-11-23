-- A sale paid partly one way and partly another (cash and card): the parts, so the shift's cash
-- drawer and takings count each in its place. The e-invoice itself names the largest part's means
-- and lists the parts in its payment terms. Null: paid one way (payment_means).

alter table documents add column tenders jsonb;
