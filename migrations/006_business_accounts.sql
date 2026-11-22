-- Each business is its own instance: it has its own address (slug) and owns
-- its user accounts. A person working for two businesses has two accounts.

-- ---------- business address: app.example.bz/<slug> ----------
alter table tenants add column slug text;
update tenants t set slug = s.slug
from (
  select id,
         coalesce(nullif(left(trim(both '-' from regexp_replace(lower(coalesce(trade_name, legal_name)), '[^a-z0-9]+', '-', 'g')), 30), ''), 'business')
           || '-' || substr(replace(id::text, '-', ''), 1, 6) as slug
  from tenants
) s
where s.id = t.id;
alter table tenants alter column slug set not null;
alter table tenants add constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
create unique index tenants_slug on tenants (slug);

-- ---------- accounts belong to one business ----------
alter table users add column tenant_id uuid references tenants (id);
alter table users add column username text;
alter table users add column role text;
alter table users add column status text not null default 'active';
alter table users add column must_change_password boolean not null default false;
alter table users add column last_login_at timestamptz;
alter table users add column created_by uuid references users (id);
alter table users alter column email drop not null;
drop index users_email;

-- An existing person keeps their account for their first business and gets a copy
-- (same name, email and password) for each other business they belonged to.
update users u set tenant_id = r.tenant_id, role = r.role
from (select user_id, tenant_id, role, row_number() over (partition by user_id order by created_at, tenant_id) as rn from memberships) r
where r.user_id = u.id and r.rn = 1;
insert into users (id, email, name, password_hash, created_at, tenant_id, role)
select gen_random_uuid(), u.email, u.name, u.password_hash, u.created_at, r.tenant_id, r.role
from (select user_id, tenant_id, role, row_number() over (partition by user_id order by created_at, tenant_id) as rn from memberships) r
join users u on u.id = r.user_id
where r.rn > 1;

-- Accounts that never created or joined a business have nothing to log in to any more.
update document_messages set sent_by = null where sent_by in (select id from users where tenant_id is null);
update share_links set created_by = null where created_by in (select id from users where tenant_id is null);
delete from sessions;
delete from password_resets where user_id in (select id from users where tenant_id is null);
drop table invitations;
delete from users where tenant_id is null;
drop table memberships;

-- Members could issue, send, cancel and manage the catalog: that is a manager now.
update users set role = 'manager' where role = 'member';
alter table users alter column tenant_id set not null;
alter table users alter column role set not null;
alter table users add constraint users_role check (role in ('owner', 'admin', 'manager', 'cashier', 'accountant'));
alter table users add constraint users_status check (status in ('active', 'disabled'));
alter table users add constraint users_can_log_in check (email is not null or username is not null);
alter table users add constraint users_username_format check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{1,39}$');
create unique index users_tenant_email on users (tenant_id, lower(email)) where email is not null;
create unique index users_tenant_username on users (tenant_id, username) where username is not null;
create index users_tenant on users (tenant_id);

-- A session belongs to one account, so to one business.
alter table sessions drop column current_tenant_id;

-- Password links: "reset" (forgot password, 1 hour) and "welcome" (new account, 7 days).
alter table password_resets add column purpose text not null default 'reset' check (purpose in ('reset', 'welcome'));

-- Who issued each document (not part of the signed record, so it may be set after issuing).
alter table documents add column issued_by uuid references users (id);

-- ---------- activity log ----------
create table audit_events (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references tenants (id),
  user_id    uuid references users (id),
  action     text not null,
  target     text,
  details    jsonb,
  ip         text,
  at         timestamptz not null default now()
);
create index audit_events_tenant on audit_events (tenant_id, id desc);
create trigger audit_events_permanent before update or delete on audit_events
  for each row execute function forbid_change();
