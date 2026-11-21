-- Core engine schema (spec "Data model").
--
-- Multi-tenant from day one: every table carries tenant_id and every query
-- filters on it. Issued documents are never updated or deleted, only
-- superseded: triggers below enforce that in the database itself.
-- Money is stored as integer cents (bigint).

create table tenants (
  id                uuid primary key,
  legal_name        text not null,
  trade_name        text,
  tin               char(6) not null check (tin ~ '^[0-9]{6}$'),
  street            text not null,
  additional_street text,
  city              text not null,
  district_code     char(1) not null check (district_code between '1' and '6'),
  telephone         text not null,
  email             text not null,
  environment       text not null check (environment in ('test', 'production')),
  created_at        timestamptz not null default now(),
  unique (tin, environment)
);

-- The taxpayer's BTS certificate. The private key is encrypted with a key
-- held outside the database (AES-256-GCM, bound to the tenant id).
create table certificates (
  id              uuid primary key,
  tenant_id       uuid not null references tenants (id),
  certificate_pem text not null,
  encrypted_key   text not null,
  subject_tin     char(6) not null,
  serial_number   text not null,
  sha256          text not null,
  valid_from      timestamptz not null,
  valid_to        timestamptz not null,
  status          text not null check (status in ('active', 'retired', 'revoked')),
  created_at      timestamptz not null default now()
);
create unique index certificates_one_active on certificates (tenant_id) where status = 'active';

-- A numbering series. Serial numbers and the hash chain are per series, so
-- the row is locked (SELECT ... FOR UPDATE) while a document takes its number.
create table series (
  id                 uuid primary key,
  tenant_id          uuid not null references tenants (id),
  etd_type           char(2) not null check (etd_type in ('01', '02', '03', '04')),
  series_number      integer not null check (series_number between 1 and 999),
  purpose            text not null check (purpose in ('normal', 'contingency')),
  next_serial        bigint not null default 1 check (next_serial between 1 and 1000000000),
  last_sequence_hash text,
  created_at         timestamptz not null default now(),
  unique (tenant_id, etd_type, series_number)
);

create table customers (
  id             uuid primary key,
  tenant_id      uuid not null references tenants (id),
  name           text not null,
  tin            char(6),
  other_id_scheme text,
  other_id_value text,
  street         text,
  city           text,
  district_code  char(1) check (district_code between '1' and '6'),
  telephone      text,
  email          text,
  created_at     timestamptz not null default now()
);
create index customers_tenant on customers (tenant_id);

create table items (
  id                    uuid primary key,
  tenant_id             uuid not null references tenants (id),
  name                  text not null,
  description           text not null,
  seller_code           text,
  unit_code             text not null,
  unit_price            numeric(24, 6) not null check (unit_price >= 0),
  gst_category          char(1) not null check (gst_category in ('S', 'Z', 'E')),
  exemption_reason_code text,
  created_at            timestamptz not null default now()
);
create index items_tenant on items (tenant_id);

create table documents (
  id                     uuid primary key,
  tenant_id              uuid not null references tenants (id),
  series_id              uuid not null references series (id),
  etd_type               char(2) not null,
  series_number          integer not null,
  serial                 bigint not null,
  etdui                  char(44) not null unique,
  issue_date             date not null,
  issue_time             time not null,
  oper_mode              smallint not null,
  reception_env          char(2) not null,
  customer_id            uuid references customers (id),
  -- The customer exactly as issued, so later edits to the customer record never change history.
  customer_snapshot      jsonb,
  referenced_etdui       char(44),
  line_count             integer not null,
  line_extension_cents   bigint not null,
  gst_cents              bigint not null,
  tax_cents              bigint not null,
  tax_inclusive_cents    bigint not null,
  payable_cents          bigint not null,
  sequence_hash          text not null,
  previous_sequence_hash text,
  -- The legal record: the signed XML exactly as sent.
  signed_xml             text not null,
  status                 text not null check (status in ('pending', 'authorized', 'authorized_with_alert', 'rejected', 'contingency_pending', 'cancelled')),
  status_detail          jsonb,
  protocol_number        char(44),
  created_at             timestamptz not null default now(),
  settled_at             timestamptz,
  unique (tenant_id, etd_type, series_number, serial)
);
create index documents_tenant_status on documents (tenant_id, status, created_at);

create table document_lines (
  document_id      uuid not null references documents (id),
  tenant_id        uuid not null references tenants (id),
  line_number      integer not null,
  description      text not null,
  quantity         numeric(24, 6) not null,
  unit_code        text not null,
  unit_price       numeric(24, 6) not null,
  net_cents        bigint not null,
  gst_category     char(1) not null,
  gst_cents        bigint not null,
  tax_cents        bigint not null,
  line_total_cents bigint not null,
  primary key (document_id, line_number)
);

-- Every attempt to send or query, with BTS's reply exactly as received.
create table submissions (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants (id),
  document_id uuid not null references documents (id),
  attempt     integer not null,
  action      text not null check (action in ('submitted', 'queried')),
  at          timestamptz not null,
  http_status integer,
  result      text not null,
  raw_reply   text
);
create index submissions_document on submissions (document_id);

-- ---------- immutability ----------

create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows are permanent records and cannot be %d', tg_table_name, lower(tg_op);
end
$$;

create trigger document_lines_permanent before update or delete on document_lines
  for each row execute function forbid_change();
create trigger submissions_permanent before update or delete on submissions
  for each row execute function forbid_change();
create trigger documents_no_delete before delete on documents
  for each row execute function forbid_change();

-- Documents: only the outcome may change, and only along allowed transitions.
create function documents_guard_update() returns trigger language plpgsql as $$
begin
  if (new.id, new.tenant_id, new.series_id, new.etd_type, new.series_number, new.serial, new.etdui,
      new.issue_date, new.issue_time, new.oper_mode, new.reception_env, new.customer_snapshot,
      new.referenced_etdui, new.line_count, new.line_extension_cents, new.gst_cents, new.tax_cents,
      new.tax_inclusive_cents, new.payable_cents, new.sequence_hash, new.previous_sequence_hash,
      new.signed_xml, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.series_id, old.etd_type, old.series_number, old.serial, old.etdui,
      old.issue_date, old.issue_time, old.oper_mode, old.reception_env, old.customer_snapshot,
      old.referenced_etdui, old.line_count, old.line_extension_cents, old.gst_cents, old.tax_cents,
      old.tax_inclusive_cents, old.payable_cents, old.sequence_hash, old.previous_sequence_hash,
      old.signed_xml, old.created_at) then
    raise exception 'issued documents cannot be modified, only their status';
  end if;
  if new.status is distinct from old.status and not (
       old.status in ('pending', 'contingency_pending')
    or (old.status in ('authorized', 'authorized_with_alert') and new.status = 'cancelled')
  ) then
    raise exception 'document status cannot change from % to %', old.status, new.status;
  end if;
  return new;
end
$$;
create trigger documents_guard before update on documents
  for each row execute function documents_guard_update();
