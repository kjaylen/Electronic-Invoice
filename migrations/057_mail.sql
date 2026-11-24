-- Email: the servers it goes out through, every message (the queue and the
-- log are one table), and the addresses not to write to (src/mail/).

-- An outgoing mail server: the platform's own (scope 'platform'), and one for
-- each business that sends from its own address (scope = the business's id).
create table mail_settings (
  scope         text primary key,
  tenant_id     uuid unique references tenants (id),
  host          text not null,
  port          integer not null check (port between 1 and 65535),
  -- none: plain; starttls: upgraded after connecting (587); tls: encrypted from the start (465).
  security      text not null check (security in ('none', 'starttls', 'tls')),
  username      text,
  -- Encrypted with the server's key (src/db/keystore.ts), bound to this row's scope. Never sent to a browser.
  password_enc  text,
  from_name     text not null,
  from_address  text not null,
  reply_to      text,
  enabled       boolean not null default true,
  -- How it has gone: the last message it accepted, and what went wrong since.
  verified_at   timestamptz,
  failures      integer not null default 0,
  last_error    text,
  last_error_at timestamptz,
  -- After several failures in a row a business's server is left alone for a while (mail goes from the platform's).
  paused_until  timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  check ((scope = 'platform') = (tenant_id is null))
);

-- Every email: written here first, sent in the background, kept as the log.
create table mail_messages (
  id               uuid primary key,
  -- The business it belongs to (and whose log shows it); null for the platform's own.
  tenant_id        uuid references tenants (id),
  -- What it is (src/mail/types.ts): 'document', 'order', 'password-reset', ...
  type             text not null,
  category         text not null check (category in ('transactional', 'optional')),
  -- Who it is from: the business (its own server when it has one) or the platform.
  sender           text not null check (sender in ('business', 'platform')),
  to_address       text not null,
  subject          text not null,
  reply_to         text,
  status           text not null check (status in ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  -- A server that took it and stopped: after this, another may take it.
  locked_until     timestamptz,
  -- Not worth sending after this (a sign-in code that no longer works).
  expires_at       timestamptz,
  -- Its text holds a link or code that lets someone in: scrubbed once delivered, never resent.
  sensitive        boolean not null default false,
  -- The text, HTML, attachments and extra headers: compressed, then encrypted with the server's key, bound to this row's id.
  payload          text,
  attachments      integer not null default 0,
  -- How it went out.
  via              text check (via in ('business', 'platform')),
  from_address     text,
  server_response  text,
  error            text,
  error_code       text,
  -- Something worth knowing that is not a failure ("sent from the platform's address: your server refused the password").
  note             text,
  -- The link that stops emails like this one (hashed), for those that are not transactional.
  unsubscribe_hash text,
  resend_of        uuid,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  failed_at        timestamptz
);
create index mail_messages_due on mail_messages (next_attempt_at) where status in ('queued', 'sending');
create index mail_messages_tenant on mail_messages (tenant_id, created_at desc);
create index mail_messages_created on mail_messages (created_at);
create unique index mail_messages_unsubscribe on mail_messages (unsubscribe_hash) where unsubscribe_hash is not null;

-- Addresses not to write to: a server said the mailbox does not exist, or
-- the person asked not to get emails that are not transactional. Per
-- business (null: the platform's own emails).
create table mail_suppressions (
  id          uuid primary key,
  tenant_id   uuid references tenants (id),
  -- Lower case.
  email       text not null,
  reason      text not null check (reason in ('bounced', 'unsubscribed', 'manual')),
  detail      text,
  created_at  timestamptz not null default now()
);
create unique index mail_suppressions_one on mail_suppressions (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), email);
