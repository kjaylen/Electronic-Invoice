-- NetSuite connections: the business's NetSuite account is read here (OAuth 2.0
-- client credentials, with a key and certificate made for the connection), so
-- the Web Connector's user name and password do not apply to them.

alter table connector_links drop constraint connector_links_kind_check;
alter table connector_links add constraint connector_links_kind_check check (kind in ('qbd', 'qbpos', 'netsuite'));
alter table connector_links alter column username drop not null;
alter table connector_links alter column password_hash drop not null;
alter table connector_links alter column owner_id drop not null;
alter table connector_links alter column file_id drop not null;

-- { accountId, clientId, certificateId, numberField, statusField }: not secret.
alter table connector_links add column config jsonb not null default '{}'::jsonb;
-- The connection's private key (encrypted), and the certificate the business uploads to NetSuite.
alter table connector_links add column secret_encrypted text;
alter table connector_links add column certificate_pem text;
alter table connector_links add column certificate_expires_at timestamptz;
-- When it is next read (NetSuite is asked; QuickBooks calls in).
alter table connector_links add column next_poll_at timestamptz;

create index connector_links_due on connector_links (next_poll_at) where kind = 'netsuite' and removed_at is null and status = 'active';
