/**
 * QuickBooks Online: every authorized document lands in the business's
 * books, without retyping.
 *
 *   Tax invoice, debit note → Invoice      Tax receipt → SalesReceipt      Credit note → CreditMemo
 *
 * The business connects with Intuit's OAuth 2.0 (Settings → Integrations). From
 * then on, documents issued from the chosen day are sent as soon as BTS
 * authorizes them (retried with backoff when QuickBooks is unavailable), and a
 * document cancelled with BTS is voided in QuickBooks too.
 *
 * Each document's DocNumber is its series and number ("001-000000012"), and
 * the BTS document id (ETDUI) and authorization go in the private note.
 * Customers are matched by name (and created when missing). Lines use one
 * service item ("eInvoicing sales", created on the first sync). GST: when the
 * business maps its QuickBooks tax codes to the GST rates, lines carry them
 * and QuickBooks books the tax; until then lines are sent with GST included
 * so totals always agree with the e-invoice.
 *
 * Settings (the platform's own Intuit app): QBO_CLIENT_ID, QBO_CLIENT_SECRET,
 * QBO_ENVIRONMENT (sandbox | production). The redirect URI to register with
 * Intuit is <PUBLIC_URL>/v1/integrations/quickbooks/callback.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { readEtdForPrint } from '../render/view.ts';

export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const API_HOSTS = { sandbox: 'https://sandbox-quickbooks.api.intuit.com', production: 'https://quickbooks.api.intuit.com' } as const;
const MINOR_VERSION = '73';
export const SALES_ITEM_NAME = 'eInvoicing sales';
const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200];

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
  redirectUri: string;
  fetch?: typeof fetch;
}

export class IntegrationError extends Error {
  override name = 'IntegrationError';
  readonly reconnect: boolean;
  constructor(message: string, reconnect = false) {
    super(message);
    this.reconnect = reconnect;
  }
}

interface Tokens {
  access: string;
  refresh: string;
}

const tokenContext = (tenantId: string) => `integration:${tenantId}:quickbooks`;
const hashState = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- OAuth ----------

export async function beginConnect(db: Queryable, config: QuickBooksConfig, tenantId: string, userId: string | null): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await db.query('delete from integration_oauth_states where expires_at < now()');
  await db.query(
    "insert into integration_oauth_states (state_hash, tenant_id, provider, user_id, expires_at) values ($1, $2, 'quickbooks', $3, now() + interval '10 minutes')",
    [hashState(state), tenantId, userId],
  );
  const q = new URLSearchParams({ client_id: config.clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: config.redirectUri, state });
  return `${AUTHORIZE_URL}?${q}`;
}

async function tokenRequest(config: QuickBooksConfig, body: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await (config.fetch ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new IntegrationError(json.error === 'invalid_grant' ? 'QuickBooks no longer accepts this connection; connect again' : `QuickBooks refused the sign-in (${res.status})`, json.error === 'invalid_grant');
  }
  return json as { access_token: string; refresh_token: string; expires_in: number };
}

/** Back from Intuit: check the state, get tokens, save the connection. Returns the business it was for. */
export async function finishConnect(db: Queryable, keys: KeyProtector, config: QuickBooksConfig, params: { code: string; state: string; realmId: string }): Promise<{ tenantId: string }> {
  const row = (await db.query<{ tenant_id: string; user_id: string | null }>(
    "delete from integration_oauth_states where state_hash = $1 and provider = 'quickbooks' and expires_at > now() returning tenant_id, user_id", [hashState(params.state)],
  )).rows[0];
  if (!row) throw new IntegrationError('This connection link has expired; start again from Settings → Integrations');
  const t = await tokenRequest(config, { grant_type: 'authorization_code', code: params.code, redirect_uri: config.redirectUri });
  const tokens: Tokens = { access: t.access_token, refresh: t.refresh_token };
  const client = new QuickBooksClient(config, params.realmId, async () => tokens.access);
  const info = await client.get(`/companyinfo/${encodeURIComponent(params.realmId)}`).catch(() => null);
  const name = (info?.CompanyInfo as { CompanyName?: string } | undefined)?.CompanyName ?? null;
  await db.query(
    `insert into integration_connections (tenant_id, provider, status, account_id, account_name, tokens_encrypted, access_expires_at, sync_from, connected_by)
     values ($1, 'quickbooks', 'connected', $2, $3, $4, now() + make_interval(secs => $5), (now() - interval '6 hours')::date, $6)
     on conflict (tenant_id, provider) do update set status = 'connected', account_id = excluded.account_id, account_name = excluded.account_name,
       tokens_encrypted = excluded.tokens_encrypted, access_expires_at = excluded.access_expires_at, connected_by = excluded.connected_by,
       settings = case when integration_connections.account_id = excluded.account_id then integration_connections.settings else '{}'::jsonb end,
       updated_at = now()`,
    [row.tenant_id, params.realmId, name, await keys.encrypt(Buffer.from(JSON.stringify(tokens)), tokenContext(row.tenant_id)), t.expires_in, row.user_id],
  );
  return { tenantId: row.tenant_id };
}

interface ConnectionRow {
  tenant_id: string;
  status: string;
  account_id: string;
  account_name: string | null;
  tokens_encrypted: string;
  access_expires_at: Date | string;
  settings: QuickBooksSettings;
  sync_from: string;
}

export interface QuickBooksSettings {
  /** QuickBooks tax code ids for our GST categories. */
  taxCodes?: { S?: string; Z?: string; E?: string };
  itemId?: string;
}

/** A fresh access token, refreshing (and saving the rotated refresh token) when needed. */
async function accessToken(db: Queryable, keys: KeyProtector, config: QuickBooksConfig, conn: ConnectionRow, force = false): Promise<string> {
  const tokens = JSON.parse((await keys.decrypt(conn.tokens_encrypted, tokenContext(conn.tenant_id))).toString('utf8')) as Tokens;
  if (!force && new Date(conn.access_expires_at).getTime() > Date.now() + 60_000) return tokens.access;
  try {
    const t = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
    const next: Tokens = { access: t.access_token, refresh: t.refresh_token || tokens.refresh };
    const encrypted = await keys.encrypt(Buffer.from(JSON.stringify(next)), tokenContext(conn.tenant_id));
    await db.query("update integration_connections set tokens_encrypted = $2, access_expires_at = now() + make_interval(secs => $3), updated_at = now() where tenant_id = $1 and provider = 'quickbooks'", [conn.tenant_id, encrypted, t.expires_in]);
    conn.tokens_encrypted = encrypted;
    conn.access_expires_at = new Date(Date.now() + t.expires_in * 1000);
    return next.access;
  } catch (e) {
    if (e instanceof IntegrationError && e.reconnect) {
      await db.query("update integration_connections set status = 'needs_reconnect', updated_at = now() where tenant_id = $1 and provider = 'quickbooks'", [conn.tenant_id]);
    }
    throw e;
  }
}

export async function disconnect(db: Queryable, keys: KeyProtector, config: QuickBooksConfig, tenantId: string): Promise<void> {
  const conn = (await db.query<ConnectionRow>("select * from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [tenantId])).rows[0];
  if (!conn) return;
  try {
    const tokens = JSON.parse((await keys.decrypt(conn.tokens_encrypted, tokenContext(tenantId))).toString('utf8')) as Tokens;
    await (config.fetch ?? fetch)(REVOKE_URL, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokens.refresh }),
    });
  } catch {
    // Revoking is a courtesy; the connection is removed either way.
  }
  await db.query("delete from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [tenantId]);
  await db.query("delete from integration_customer_refs where tenant_id = $1 and provider = 'quickbooks'", [tenantId]);
}

// ---------- the API ----------

export class QuickBooksClient {
  readonly base: string;
  readonly realmId: string;
  #token: () => Promise<string>;
  #fetch: typeof fetch;
  #onUnauthorized: (() => Promise<string>) | undefined;

  constructor(config: QuickBooksConfig, realmId: string, token: () => Promise<string>, onUnauthorized?: () => Promise<string>) {
    this.base = `${API_HOSTS[config.environment]}/v3/company/${encodeURIComponent(realmId)}`;
    this.realmId = realmId;
    this.#token = token;
    this.#fetch = config.fetch ?? fetch;
    this.#onUnauthorized = onUnauthorized;
  }

  async #send(method: string, path: string, body?: unknown, retried = false): Promise<Record<string, unknown>> {
    const sep = path.includes('?') ? '&' : '?';
    const res = await this.#fetch(`${this.base}${path}${sep}minorversion=${MINOR_VERSION}`, {
      method,
      headers: { authorization: `Bearer ${await this.#token()}`, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && !retried && this.#onUnauthorized) {
      const fresh = await this.#onUnauthorized();
      this.#token = async () => fresh;
      return this.#send(method, path, body, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.Fault) {
      const err = ((json.Fault as { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } | undefined)?.Error ?? [])[0];
      throw Object.assign(new IntegrationError(err ? `${err.Message ?? 'QuickBooks error'}${err.Detail ? `: ${err.Detail}` : ''}` : `QuickBooks answered ${res.status}`), { status: res.status, code: err?.code });
    }
    return json;
  }

  get(path: string) {
    return this.#send('GET', path);
  }
  post(path: string, body: unknown) {
    return this.#send('POST', path, body);
  }
  async query<T>(entity: string, sql: string): Promise<T[]> {
    const json = await this.#send('GET', `/query?query=${encodeURIComponent(sql)}`);
    return ((json.QueryResponse as Record<string, T[]> | undefined)?.[entity] ?? []) as T[];
  }
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ---------- sending documents ----------

export interface SyncContext {
  db: Queryable;
  keys: KeyProtector;
  config: QuickBooksConfig;
}

async function connection(ctx: SyncContext, tenantId: string): Promise<{ conn: ConnectionRow; client: QuickBooksClient }> {
  const conn = (await ctx.db.query<ConnectionRow>("select * from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [tenantId])).rows[0];
  if (!conn || conn.status !== 'connected') throw new IntegrationError('QuickBooks is not connected', true);
  const client = new QuickBooksClient(ctx.config, conn.account_id, () => accessToken(ctx.db, ctx.keys, ctx.config, conn), () => accessToken(ctx.db, ctx.keys, ctx.config, conn, true));
  return { conn, client };
}

/** The service item every line uses, created once. */
async function salesItem(ctx: SyncContext, conn: ConnectionRow, client: QuickBooksClient): Promise<string> {
  if (conn.settings.itemId) return conn.settings.itemId;
  let item = (await client.query<{ Id: string }>('Item', `select Id from Item where Name = ${quote(SALES_ITEM_NAME)}`))[0];
  if (!item) {
    const account = (await client.query<{ Id: string }>('Account', "select Id from Account where AccountType = 'Income' and Active = true maxresults 1"))[0];
    if (!account) throw new IntegrationError('QuickBooks has no income account to book sales to');
    item = ((await client.post('/item', { Name: SALES_ITEM_NAME, Type: 'Service', IncomeAccountRef: { value: account.Id } })).Item as { Id: string });
  }
  conn.settings = { ...conn.settings, itemId: item.Id };
  await ctx.db.query("update integration_connections set settings = $2, updated_at = now() where tenant_id = $1 and provider = 'quickbooks'", [conn.tenant_id, JSON.stringify(conn.settings)]);
  return item.Id;
}

/** The QuickBooks customer for a document's customer (or "Walk-in customers"), found by name or created. */
async function customerRef(ctx: SyncContext, conn: ConnectionRow, client: QuickBooksClient, customer: { name?: string; tin?: string; email?: string; telephone?: string; addressLines: string[] } | undefined): Promise<string> {
  const name = (customer?.name?.trim() || 'Walk-in customers').slice(0, 100);
  const key = customer?.tin ? `tin:${customer.tin}` : `name:${name.toLowerCase()}`;
  const known = (await ctx.db.query<{ remote_id: string }>("select remote_id from integration_customer_refs where tenant_id = $1 and provider = 'quickbooks' and local_key = $2", [conn.tenant_id, key])).rows[0];
  if (known) return known.remote_id;
  let found = (await client.query<{ Id: string }>('Customer', `select Id from Customer where DisplayName = ${quote(name)}`))[0];
  if (!found) {
    const body = {
      DisplayName: name,
      ...(customer?.email && { PrimaryEmailAddr: { Address: customer.email } }),
      ...(customer?.telephone && { PrimaryPhone: { FreeFormNumber: customer.telephone } }),
      ...(customer?.addressLines.length && { BillAddr: { Line1: customer.addressLines[0], ...(customer.addressLines[1] && { City: customer.addressLines[1] }), Country: 'Belize' } }),
      ...(customer?.tin && { Notes: `TIN ${customer.tin}` }),
    };
    found = (await client.post('/customer', body)).Customer as { Id: string };
  }
  await ctx.db.query("insert into integration_customer_refs (tenant_id, provider, local_key, remote_id) values ($1, 'quickbooks', $2, $3) on conflict do nothing", [conn.tenant_id, key, found.Id]);
  return found.Id;
}

const ENTITY: Record<string, 'Invoice' | 'SalesReceipt' | 'CreditMemo'> = { '01': 'Invoice', '03': 'Invoice', '02': 'SalesReceipt', '04': 'CreditMemo' };

/** Send one document; returns the QuickBooks entity and id. */
export async function sendDocument(ctx: SyncContext, tenantId: string, documentId: string): Promise<{ type: string; id: string }> {
  const { conn, client } = await connection(ctx, tenantId);
  const d = (await ctx.db.query<{ signed_xml: string; etd_type: string; protocol_number: string | null; gst_category_list: string[] | null }>(
    `select d.signed_xml, d.etd_type, d.protocol_number, (select array_agg(gst_category order by line_number) from document_lines l where l.document_id = d.id) as gst_category_list
     from documents d where d.id = $1 and d.tenant_id = $2`, [documentId, tenantId],
  )).rows[0];
  if (!d) throw new IntegrationError('Document not found');
  const view = readEtdForPrint(d.signed_xml);
  const entity = ENTITY[d.etd_type]!;
  const itemId = await salesItem(ctx, conn, client);
  const customerId = await customerRef(ctx, conn, client, view.customer);
  const categories = d.gst_category_list ?? [];
  const codes = conn.settings.taxCodes ?? {};
  const taxed = categories.length > 0 && categories.every((c) => codes[c as 'S' | 'Z' | 'E']);
  const lines = view.lines.map((l, i) => {
    const amount = taxed ? l.net : l.total;
    const qty = Number(l.quantity);
    const exact = taxed && Math.abs(qty * Number(l.unitPrice) - Number(l.net)) < 0.005;
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: Number(amount),
      Description: (exact ? l.description : `${l.quantity} × ${l.description}`).slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        ...(exact ? { Qty: qty, UnitPrice: Number(l.unitPrice) } : { Qty: 1, UnitPrice: Number(amount) }),
        ...(taxed && { TaxCodeRef: { value: codes[categories[i] as 'S' | 'Z' | 'E']! } }),
      },
    };
  });
  const note = [
    `BTS ETDUI ${view.etdui}`,
    d.protocol_number ? `Authorization ${d.protocol_number}` : null,
    view.reference ? `Corrects ${view.reference.etdui}: ${view.reference.reason}` : null,
    taxed ? null : `GST included: BZ$${view.totals.gst}`,
  ].filter(Boolean).join('. ');
  const body = {
    CustomerRef: { value: customerId },
    TxnDate: view.issueDate,
    DocNumber: `${view.series}-${view.number}`.slice(0, 21),
    Line: lines,
    PrivateNote: note.slice(0, 4000),
    GlobalTaxCalculation: taxed ? 'TaxExcluded' : 'NotApplicable',
    ...(entity === 'Invoice' && view.payment?.dueDate && { DueDate: view.payment.dueDate }),
  };
  const json = await client.post(`/${entity.toLowerCase()}?requestid=${documentId}`, body);
  const created = json[entity] as { Id: string };
  return { type: entity, id: created.Id };
}

/** A document cancelled with BTS: void its QuickBooks copy (credit memos are deleted). */
export async function voidDocument(ctx: SyncContext, tenantId: string, remote: { type: string; id: string }): Promise<void> {
  const { client } = await connection(ctx, tenantId);
  const path = `/${remote.type.toLowerCase()}`;
  const current = (await client.get(`${path}/${encodeURIComponent(remote.id)}`))[remote.type] as { Id: string; SyncToken: string };
  await client.post(`${path}?operation=${remote.type === 'CreditMemo' ? 'delete' : 'void'}`, { Id: current.Id, SyncToken: current.SyncToken });
}

/** QuickBooks tax codes, for the business to map to GST rates. */
export async function taxCodes(ctx: SyncContext, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const { client } = await connection(ctx, tenantId);
  const rows = await client.query<{ Id: string; Name: string; Active?: boolean }>('TaxCode', 'select Id, Name, Active from TaxCode maxresults 100');
  return rows.filter((r) => r.Active !== false).map((r) => ({ id: r.Id, name: r.Name }));
}

// ---------- the sync run ----------

/** Queue new authorized documents and cancellations, then send what is due. */
export async function runQuickBooksSync(ctx: SyncContext, limit = 25): Promise<{ queued: number; synced: number; failed: number; voided: number }> {
  const { db } = ctx;
  const queued = (await db.query(
    `insert into integration_syncs (tenant_id, provider, document_id, status)
     select d.tenant_id, 'quickbooks', d.id, 'pending' from documents d
     join integration_connections c on c.tenant_id = d.tenant_id and c.provider = 'quickbooks' and c.status = 'connected'
     join tenants t on t.id = d.tenant_id
     where d.status in ('authorized', 'authorized_with_alert', 'cancelled') and d.issue_date >= c.sync_from
       and d.reception_env = case t.environment when 'production' then '01' else '02' end
       and not exists (select 1 from integration_syncs s where s.tenant_id = d.tenant_id and s.provider = 'quickbooks' and s.document_id = d.id)
     limit 500
     on conflict do nothing returning document_id`,
  )).rows.length;

  let synced = 0;
  let failed = 0;
  const due = (await db.query<{ tenant_id: string; document_id: string; attempts: number; doc_status: string }>(
    `update integration_syncs s set next_attempt_at = now() + interval '5 minutes' from documents d
     where d.id = s.document_id and (s.tenant_id, s.provider, s.document_id) in (
       select tenant_id, provider, document_id from integration_syncs where provider = 'quickbooks' and status = 'pending' and next_attempt_at <= now()
       order by next_attempt_at limit $1 for update skip locked
     ) returning s.tenant_id, s.document_id, s.attempts, d.status as doc_status`,
    [limit],
  )).rows;
  for (const row of due) {
    // A document cancelled before it was ever sent has nothing to send.
    if (row.doc_status === 'cancelled') {
      await db.query("update integration_syncs set status = 'skipped', error = 'Cancelled before it was sent' where tenant_id = $1 and provider = 'quickbooks' and document_id = $2", [row.tenant_id, row.document_id]);
      continue;
    }
    try {
      const r = await sendDocument(ctx, row.tenant_id, row.document_id);
      await db.query(
        "update integration_syncs set status = 'synced', remote_type = $3, remote_id = $4, attempts = attempts + 1, error = null, synced_at = now() where tenant_id = $1 and provider = 'quickbooks' and document_id = $2",
        [row.tenant_id, row.document_id, r.type, r.id],
      );
      synced++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const delay = RETRY_DELAYS_S[attempts - 1];
      const reconnect = e instanceof IntegrationError && e.reconnect;
      await db.query(
        `update integration_syncs set attempts = $3, error = $4, status = $5,
           next_attempt_at = case when $6::int is null then next_attempt_at else now() + make_interval(secs => $6::int) end
         where tenant_id = $1 and provider = 'quickbooks' and document_id = $2`,
        // Waiting for the business to reconnect is not a failure of the document: it stays queued.
        [row.tenant_id, row.document_id, attempts, (e as Error).message.slice(0, 1000), delay === undefined && !reconnect ? 'failed' : 'pending', reconnect ? 3600 : delay ?? null],
      );
      failed++;
    }
  }

  // Cancelled after being sent: void the QuickBooks copy.
  let voided = 0;
  const cancelled = (await db.query<{ tenant_id: string; document_id: string; remote_type: string; remote_id: string }>(
    `select s.tenant_id, s.document_id, s.remote_type, s.remote_id from integration_syncs s join documents d on d.id = s.document_id
     join integration_connections c on c.tenant_id = s.tenant_id and c.provider = 'quickbooks' and c.status = 'connected'
     where s.provider = 'quickbooks' and s.status = 'synced' and s.voided_at is null and d.status = 'cancelled' limit $1`,
    [limit],
  )).rows;
  for (const c of cancelled) {
    try {
      await voidDocument(ctx, c.tenant_id, { type: c.remote_type, id: c.remote_id });
      await db.query("update integration_syncs set voided_at = now() where tenant_id = $1 and provider = 'quickbooks' and document_id = $2", [c.tenant_id, c.document_id]);
      voided++;
    } catch (e) {
      await db.query("update integration_syncs set error = $3 where tenant_id = $1 and provider = 'quickbooks' and document_id = $2", [c.tenant_id, c.document_id, `Voiding failed: ${(e as Error).message}`.slice(0, 1000)]);
    }
  }
  return { queued, synced, failed, voided };
}
