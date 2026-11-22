-- Webhooks: every change worth telling another system about lands in an
-- outbox (by trigger, so no code path can forget), and is delivered to each
-- business's endpoints with retries.

create table event_outbox (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references tenants (id),
  type         text not null,
  subject_id   uuid not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index event_outbox_pending on event_outbox (id) where processed_at is null;

create function outbox_documents() returns trigger language plpgsql as $$
declare kind text;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    kind := case new.status
      when 'authorized' then 'document.authorized'
      when 'authorized_with_alert' then 'document.authorized'
      when 'rejected' then 'document.rejected'
      when 'cancelled' then 'document.cancelled'
      when 'contingency_pending' then 'document.issued_offline'
      else null end;
    if kind is not null then
      insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, kind, new.id);
    end if;
  end if;
  return new;
end $$;
create trigger documents_outbox after insert or update of status on documents
  for each row execute function outbox_documents();

create function outbox_orders() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'order.placed', new.id);
    return new;
  end if;
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'order.paid', new.id);
  end if;
  if new.fulfillment_status = 'fulfilled' and old.fulfillment_status is distinct from 'fulfilled' then
    insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'order.fulfilled', new.id);
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'order.cancelled', new.id);
  end if;
  return new;
end $$;
create trigger orders_outbox after insert or update on orders
  for each row execute function outbox_orders();

create function outbox_refunds() returns trigger language plpgsql as $$
begin
  insert into event_outbox (tenant_id, type, subject_id) values (new.tenant_id, 'order.refunded', new.id);
  return new;
end $$;
create trigger order_refunds_outbox after insert on order_refunds
  for each row execute function outbox_refunds();

create table webhook_endpoints (
  id                   uuid primary key,
  tenant_id            uuid not null references tenants (id),
  url                  text not null,
  description          text,
  -- Event types, or '*' for all.
  events               text[] not null,
  secret_encrypted     text not null,
  enabled              boolean not null default true,
  consecutive_failures integer not null default 0,
  disabled_reason      text,
  created_at           timestamptz not null default now(),
  last_delivery_at     timestamptz
);
create index webhook_endpoints_tenant on webhook_endpoints (tenant_id);

create table webhook_deliveries (
  id              uuid primary key,
  endpoint_id     uuid not null references webhook_endpoints (id) on delete cascade,
  tenant_id       uuid not null references tenants (id),
  type            text not null,
  payload         jsonb not null,
  status          text not null check (status in ('pending', 'delivered', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  response_body   text,
  error           text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index webhook_deliveries_due on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc);
