-- People: accounts, membership of businesses, and login sessions for the web app.

create table users (
  id            uuid primary key,
  email         text not null,
  name          text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index users_email on users (lower(email));

-- A person can belong to several businesses; a business can have several people.
-- owner: everything, including the certificate, API keys and team. member: day-to-day issuing.
create table memberships (
  user_id    uuid not null references users (id),
  tenant_id  uuid not null references tenants (id),
  role       text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
create index memberships_tenant on memberships (tenant_id);

-- Only a hash of the session token is stored, so a database leak does not hand out live sessions.
create table sessions (
  id                uuid primary key,
  token_hash        text not null unique,
  user_id           uuid not null references users (id),
  current_tenant_id uuid references tenants (id),
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  expires_at        timestamptz not null
);
create index sessions_user on sessions (user_id);
