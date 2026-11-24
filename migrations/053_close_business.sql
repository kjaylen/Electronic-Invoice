-- An owner can delete their business. It is closed at once (nobody but an
-- owner can sign in, the store, tills and API keys stop, nothing new is
-- issued) and erased for good when erase_after passes, unless an owner
-- reopens it first. See src/db/closure.ts.

alter table tenants
  add column closed_at   timestamptz,
  add column erase_after timestamptz,
  add column closed_by   uuid references users (id),
  add constraint tenants_closed_together check ((closed_at is null) = (erase_after is null));
create index tenants_erase_after on tenants (erase_after) where erase_after is not null;

-- Documents, their lines, submissions, events, payments and the activity log are permanent
-- records: nothing may change or delete them. The one exception is erasing a whole business
-- at the end of its 30 days, which runs inside a transaction that names the business in the
-- setting floreo.erasing_tenant. Only then, and only for rows of that business, a delete is
-- let through (rows without a tenant_id of their own, such as document lines, are reached
-- only through the documents of that business). Platform staff's own log keeps its rows:
-- they are detached from the business being erased, which is the one change it allows.
create or replace function forbid_change() returns trigger language plpgsql as $$
declare
  erasing text := nullif(current_setting('floreo.erasing_tenant', true), '');
begin
  if erasing is not null then
    if tg_op = 'DELETE' and coalesce(to_jsonb(old) ->> 'tenant_id', erasing) = erasing then
      return old;
    end if;
    if tg_op = 'UPDATE' and tg_table_name = 'platform_audit' and to_jsonb(old) ->> 'tenant_id' = erasing then
      return new;
    end if;
  end if;
  raise exception '% rows are permanent records and cannot be %d', tg_table_name, lower(tg_op);
end
$$;
