-- More events for webhooks, raised by trigger like the others: an expense recorded (by hand, with
-- a delivery, or by a repeating expense), stock received, a purchase order fully received.

create function outbox_expenses() returns trigger language plpgsql as $$
begin
  insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'expense.recorded', new.id);
  return new;
end $$;
create trigger expenses_outbox after insert on expenses for each row execute function outbox_expenses();

create function outbox_stock_receipts() returns trigger language plpgsql as $$
begin
  insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'stock.received', new.id);
  return new;
end $$;
create trigger stock_receipts_outbox after insert on stock_receipts for each row execute function outbox_stock_receipts();

create function outbox_purchase_orders() returns trigger language plpgsql as $$
begin
  if new.status = 'received' and old.status is distinct from 'received' then
    insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'purchase_order.received', new.id);
  end if;
  return new;
end $$;
create trigger purchase_orders_outbox after update of status on purchase_orders for each row execute function outbox_purchase_orders();
