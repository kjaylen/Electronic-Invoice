-- Secret API keys that may do less than everything, and that end by themselves.
-- A key made before this, or made without saying, is as it always was: every
-- part of the API, reading and changing, with no end date. See src/api/key-scope.ts.

alter table api_keys
  -- 'read': the key may look (GET) and may not change anything.
  add column access     text not null default 'full' check (access in ('full', 'read')),
  -- The parts of the API the key may use; null for all of them.
  add column areas      text[] check (areas is null or (cardinality(areas) > 0
                          and areas <@ array['documents', 'customers', 'catalog', 'orders', 'reports', 'expenses', 'webhooks', 'business']::text[])),
  -- The moment the key stops working; null for never.
  add column expires_at timestamptz;
