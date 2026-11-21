-- Events (cancellation 050) and contingency mode (manual 3.3.6, 4.10).

-- Event numbering lives in series too: type 05, series number = event code (50 for cancellations).
alter table series drop constraint series_etd_type_check;
alter table series add constraint series_etd_type_check check (etd_type in ('01', '02', '03', '04', '05'));

-- A contingency period: from the first undeliverable document until everything issued
-- meanwhile has been sent. All documents in one period share the same reason and start
-- date/time (contingencyInfo, manual 3.3.6.3).
create table contingency_periods (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id),
  reason     text not null,
  started_at timestamptz not null,
  ended_at   timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index contingency_periods_one_open on contingency_periods (tenant_id) where ended_at is null;

-- "superseded": a normal-mode document whose delivery was undetermined and whose sale was
-- reissued in contingency. It is never sent again; once BTS is back it is checked and, if
-- BTS had authorized it after all, cancelled with event 050 (manual 3.3.6.4).
alter table documents drop constraint documents_status_check;
alter table documents add constraint documents_status_check check (
  status in ('pending', 'authorized', 'authorized_with_alert', 'rejected', 'contingency_pending', 'superseded', 'cancelled')
);
alter table documents add column contingency_period_id uuid references contingency_periods (id);
alter table documents add column supersedes_document_id uuid references documents (id);

create or replace function documents_guard_update() returns trigger language plpgsql as $$
begin
  if (new.id, new.tenant_id, new.series_id, new.etd_type, new.series_number, new.serial, new.etdui,
      new.issue_date, new.issue_time, new.oper_mode, new.reception_env, new.customer_snapshot,
      new.referenced_etdui, new.line_count, new.line_extension_cents, new.gst_cents, new.tax_cents,
      new.tax_inclusive_cents, new.payable_cents, new.sequence_hash, new.previous_sequence_hash,
      new.signed_xml, new.created_at, new.contingency_period_id, new.supersedes_document_id)
     is distinct from
     (old.id, old.tenant_id, old.series_id, old.etd_type, old.series_number, old.serial, old.etdui,
      old.issue_date, old.issue_time, old.oper_mode, old.reception_env, old.customer_snapshot,
      old.referenced_etdui, old.line_count, old.line_extension_cents, old.gst_cents, old.tax_cents,
      old.tax_inclusive_cents, old.payable_cents, old.sequence_hash, old.previous_sequence_hash,
      old.signed_xml, old.created_at, old.contingency_period_id, old.supersedes_document_id) then
    raise exception 'issued documents cannot be modified, only their status';
  end if;
  if new.status is distinct from old.status and not (
       old.status in ('pending', 'contingency_pending')
    or (old.status in ('authorized', 'authorized_with_alert', 'superseded') and new.status = 'cancelled')
  ) then
    raise exception 'document status cannot change from % to %', old.status, new.status;
  end if;
  return new;
end
$$;

create table events (
  id               uuid primary key,
  tenant_id        uuid not null references tenants (id),
  series_id        uuid not null references series (id),
  event_code       char(3) not null,
  serial           bigint not null,
  etdui            char(44) not null unique,
  document_id      uuid not null references documents (id),
  referenced_etdui char(44) not null,
  reason           text not null,
  signed_xml       text not null,
  status           text not null check (status in ('pending', 'registered', 'rejected')),
  status_detail    jsonb,
  protocol_number  char(44),
  created_at       timestamptz not null default now(),
  settled_at       timestamptz,
  unique (tenant_id, event_code, serial)
);
create index events_document on events (document_id);

create trigger events_no_delete before delete on events
  for each row execute function forbid_change();

create function events_guard_update() returns trigger language plpgsql as $$
begin
  if (new.id, new.tenant_id, new.series_id, new.event_code, new.serial, new.etdui, new.document_id,
      new.referenced_etdui, new.reason, new.signed_xml, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.series_id, old.event_code, old.serial, old.etdui, old.document_id,
      old.referenced_etdui, old.reason, old.signed_xml, old.created_at) then
    raise exception 'registered events cannot be modified, only their status';
  end if;
  if new.status is distinct from old.status and old.status <> 'pending' then
    raise exception 'event status cannot change from % to %', old.status, new.status;
  end if;
  return new;
end
$$;
create trigger events_guard before update on events
  for each row execute function events_guard_update();

-- Event attempts are recorded alongside document attempts.
alter table submissions alter column document_id drop not null;
alter table submissions add column event_id uuid references events (id);
alter table submissions add constraint submissions_one_target check ((document_id is null) <> (event_id is null));
create index submissions_event on submissions (event_id);
