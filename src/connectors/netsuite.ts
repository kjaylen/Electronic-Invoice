/**
 * NetSuite: for businesses that invoice in NetSuite and use this service to
 * send those documents to BTS.
 *
 * Signing in: OAuth 2.0 client credentials (machine to machine). Each
 * connection gets its own RSA key here; the business uploads its certificate
 * to NetSuite (Setup > Integration > OAuth 2.0 Client Credentials Setup),
 * which gives a certificate ID. A token is asked for with a JWT signed with
 * that key (PS256), and lasts an hour. No password or refresh token is kept,
 * and nothing needs renewing until the certificate expires (two years).
 * (Token-based authentication is not used: NetSuite stops accepting it for
 * new integrations from 2027.1.)
 *
 * Reading: every few minutes, SuiteQL lists the invoices, cash sales and
 * credit memos changed since the last read (dated from the connection's start
 * day). Each one is read through the REST record API with its lines, and its
 * customer for the TIN and email. Then it is kept for issuing (see imports.ts).
 *
 * Writing back: once issued, the BTS number (and optionally the status and
 * ETDUI, and the address the document's QR code holds) goes into custom
 * transaction body fields the business creates (by default
 * custbody_bts_number). With the QR address in a field of its own, NetSuite's
 * own printout can draw the code: in an Advanced PDF/HTML template,
 * <barcode codetype="qrcode" showtext="false" value="${record.custbody_bts_qr}"/>.
 * Our own write-back is told from a person's
 * edit by the content: what was read for issuing is hashed, and a re-read
 * with the same hash is not a change.
 */

import { constants, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import forge from 'node-forge';
import type { Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { type ConnectorLink, LINK_SELECT, writebackText } from './qbwc.ts';
import type { QbAddress } from './qbxml.ts';
import { qrUrl } from '../render/view.ts';

export interface NetSuiteConfig {
  accountId?: string;
  clientId?: string;
  certificateId?: string;
  /** Custom transaction body field for the BTS number. */
  numberField?: string;
  /** Optional custom transaction body field for the BTS status and ETDUI. */
  statusField?: string;
  /** Optional custom transaction body field for the address the document's QR code holds (for NetSuite's own printout). */
  qrField?: string;
  /** SHA-256 of the token NetSuite's own script sends when a sale is saved, so it is read at once (see notifyScript). */
  notifyTokenHash?: string;
}

export const DEFAULT_NUMBER_FIELD = 'custbody_bts_number';
export const ACCOUNT_ID = /^[A-Za-z0-9]{1,30}(?:[_-][A-Za-z0-9]{1,10})?$/;
export const FIELD_ID = /^custbody[a-z0-9_]{1,40}$/;
const POLL_PAGES = 5;
const PAGE_SIZE = 200;
const WRITEBACK_BATCH = 50;

export const secretContext = (link: { tenant_id: string; id: string }) => `connector:${link.tenant_id}:${link.id}`;

// ---------- the connection's key and certificate ----------

/** A new RSA key (3072 bits) and a self-signed certificate for it, valid just under two years (NetSuite's limit). */
export function makeKeyAndCertificate(commonName: string, now = new Date()): { privateKeyPem: string; certificatePem: string; expiresAt: Date } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60_000);
  const expiresAt = new Date(now.getTime() + 728 * 86_400_000);
  cert.validity.notAfter = expiresAt;
  const name = [{ name: 'commonName', value: commonName.slice(0, 64) }, { name: 'organizationName', value: 'Floreo' }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { privateKeyPem: privateKey, certificatePem: forge.pki.certificateToPem(cert), expiresAt };
}

// ---------- signing in and calling NetSuite ----------

/** 1234567_SB1 → 1234567-sb1.suitetalk.api.netsuite.com */
export const accountHost = (accountId: string) => `${accountId.trim().toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
export const tokenUrl = (accountId: string) => `https://${accountHost(accountId)}/services/rest/auth/oauth2/v1/token`;

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** The signed JWT that asks NetSuite for a token. */
export function clientAssertion(cfg: Required<Pick<NetSuiteConfig, 'accountId' | 'clientId' | 'certificateId'>>, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { typ: 'JWT', alg: 'PS256', kid: cfg.certificateId };
  const payload = { iss: cfg.clientId, scope: ['rest_webservices'], aud: tokenUrl(cfg.accountId), iat, exp: iat + 3600 };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(data), { key: privateKeyPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return `${data}.${b64url(signature)}`;
}

export class NetSuiteError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** What NetSuite said, in words a person can act on. */
function explain(status: number, body: unknown, during: 'token' | 'call'): NetSuiteError {
  const b = (body ?? {}) as { error?: string; error_description?: string; title?: string; 'o:errorDetails'?: Array<{ detail?: string; 'o:errorCode'?: string }> };
  const detail = b['o:errorDetails']?.[0];
  const code = detail?.['o:errorCode'] ?? b.error ?? null;
  const said = (detail?.detail ?? b.error_description ?? b.title ?? b.error ?? `HTTP ${status}`).slice(0, 400);
  if (during === 'token') {
    if (b.error === 'invalid_client' || b.error === 'unauthorized_client') return new NetSuiteError(`NetSuite did not recognise the Client ID, or its integration record does not allow the client credentials (machine to machine) grant. (${said})`, status, code);
    if (b.error === 'invalid_grant' || b.error === 'invalid_request') return new NetSuiteError(`NetSuite refused the sign-in: check the Certificate ID, that the certificate from here is the one uploaded, and that the mapping's role is active. (${said})`, status, code);
    if (status === 404) return new NetSuiteError('No NetSuite account at that Account ID (Setup > Company > Company Information).', status, code);
  }
  if (status === 401) return new NetSuiteError(`NetSuite refused the token: the role may lack "REST Web Services" or "Log in using OAuth 2.0 Access Tokens". (${said})`, status, code);
  if (status === 403) return new NetSuiteError(`The NetSuite role is not allowed to do this. (${said})`, status, code);
  return new NetSuiteError(`NetSuite: ${said}`, status, code);
}

const tokens = new Map<string, { value: string; expires: number }>();

export class NetSuiteClient {
  readonly #cfg: Required<Pick<NetSuiteConfig, 'accountId' | 'clientId' | 'certificateId'>>;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #cacheKey: string;

  constructor(cacheKey: string, cfg: NetSuiteConfig, privateKeyPem: string, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()) {
    if (!cfg.accountId || !cfg.clientId || !cfg.certificateId) throw new NetSuiteError('Enter the NetSuite Account ID, Client ID and Certificate ID first.', 400);
    this.#cfg = { accountId: cfg.accountId, clientId: cfg.clientId, certificateId: cfg.certificateId };
    this.#key = privateKeyPem;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#cacheKey = `${cacheKey}:${cfg.accountId}:${cfg.clientId}:${cfg.certificateId}`;
  }

  async token(): Promise<string> {
    const cached = tokens.get(this.#cacheKey);
    if (cached && cached.expires > this.#now().getTime() + 60_000) return cached.value;
    let res: Response;
    try {
      res = await this.#fetch(tokenUrl(this.#cfg.accountId), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion(this.#cfg, this.#key, this.#now()),
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new NetSuiteError(`NetSuite could not be reached: ${(e as Error).message}`, 0);
    }
    const body = await res.json().catch(() => null) as { access_token?: string; expires_in?: number | string } | null;
    if (!res.ok || !body?.access_token) throw explain(res.status, body, 'token');
    tokens.set(this.#cacheKey, { value: body.access_token, expires: this.#now().getTime() + Number(body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.#fetch(`https://${accountHost(this.#cfg.accountId)}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new NetSuiteError(`NetSuite could not be reached: ${(e as Error).message}`, 0);
    }
    if (res.status === 401) tokens.delete(this.#cacheKey);
    if (res.status === 204) return undefined as T;
    const parsed = await res.json().catch(() => null);
    if (!res.ok) throw explain(res.status, parsed, 'call');
    return parsed as T;
  }

  suiteql(q: string, offset = 0, limit = PAGE_SIZE) {
    return this.call<{ items: Array<Record<string, unknown>>; hasMore: boolean }>('POST', `/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`, { q }, { prefer: 'transient' });
  }

  record(type: RecordType, id: string) {
    return this.call<Record<string, unknown>>('GET', `/services/rest/record/v1/${type}/${encodeURIComponent(id)}?expandSubResources=true`);
  }

  customer(id: string) {
    return this.call<Record<string, unknown>>('GET', `/services/rest/record/v1/customer/${encodeURIComponent(id)}`);
  }

  update(type: RecordType, id: string, fields: Record<string, string>) {
    return this.call<void>('PATCH', `/services/rest/record/v1/${type}/${encodeURIComponent(id)}`, fields);
  }
}

export async function clientFor(deps: { keys: KeyProtector; now?: () => Date }, link: ConnectorLink, fetchImpl?: typeof fetch): Promise<NetSuiteClient> {
  if (!link.secret_encrypted) throw new NetSuiteError('This connection has no key: disconnect it and connect NetSuite again.', 400);
  const key = (await deps.keys.decrypt(link.secret_encrypted, secretContext(link))).toString('utf8');
  return new NetSuiteClient(link.id, link.config, key, fetchImpl ?? fetch, deps.now);
}

/** Sign in and run a one-row query: null when it works, otherwise what to fix. */
export async function testNetSuite(deps: { keys: KeyProtector; now?: () => Date }, link: ConnectorLink, fetchImpl?: typeof fetch): Promise<string | null> {
  try {
    const client = await clientFor(deps, link, fetchImpl);
    await client.suiteql("SELECT t.id FROM transaction t WHERE t.type = 'CustInvc'", 0, 1);
    return null;
  } catch (e) {
    if (e instanceof NetSuiteError && e.status === 400 && /suiteanalytics|permission|not.*allowed/i.test(e.message)) return `${e.message} The role needs "SuiteAnalytics Workbook" to read with SuiteQL.`;
    return (e as Error).message;
  }
}

// ---------- reading transactions ----------

export type RecordType = 'invoice' | 'cashSale' | 'creditMemo';
const SQL_TYPES: Record<string, { record: RecordType; kind: NsTxn['kind'] }> = {
  CustInvc: { record: 'invoice', kind: 'invoice' },
  CashSale: { record: 'cashSale', kind: 'sales_receipt' },
  CustCred: { record: 'creditMemo', kind: 'credit_memo' },
};
const RECORD_OF: Record<NsTxn['kind'], RecordType> = { invoice: 'invoice', sales_receipt: 'cashSale', credit_memo: 'creditMemo' };

export interface NsLine {
  itemId: string | null;
  itemName: string | null;
  itemType: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string | null;
  taxCode: string | null;
  taxable: boolean | null;
  unit: string | null;
}

/** A NetSuite transaction as kept for issuing: only what the e-invoice uses. */
export interface NsTxn {
  source: 'netsuite';
  kind: 'invoice' | 'sales_receipt' | 'credit_memo';
  id: string;
  tranId: string | null;
  tranDate: string;
  dueDate: string | null;
  terms: string | null;
  memo: string | null;
  paymentMethod: string | null;
  currency: string | null;
  exchangeRate: string | null;
  customer: { id: string | null; name: string | null; companyName?: string | null; email?: string | null; phone?: string | null; tin?: string | null };
  billAddress: QbAddress | null;
  lines: NsLine[];
  subtotal: string | null;
  discountTotal: string | null;
  taxTotal: string | null;
  /** What the lines come to after discounts, shipping and handling, before tax. */
  netTotal: string | null;
  total: string | null;
  createdFrom: { id: string; name: string | null } | null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const refOf = (v: unknown): { id: string | null; name: string | null } | null => {
  if (!v || typeof v !== 'object') return v ? { id: String(v), name: null } : null;
  const r = v as Obj;
  return { id: str(r.id), name: str(r.refName) };
};
const refName = (v: unknown) => refOf(v)?.name ?? null;
const typeName = (v: unknown) => (v && typeof v === 'object' ? str((v as Obj).id) ?? str((v as Obj).refName) : str(v));

/** A six-digit Belize TIN from a tax registration number or a custom field named like it. */
export function tinFrom(customer: Obj): string | null {
  const candidates = [customer.vatRegNumber, customer.defaultTaxReg, ...Object.entries(customer).filter(([k]) => /^custentity.*(tin|tax)/i.test(k)).map(([, v]) => v)];
  for (const v of candidates) {
    const digits = str(typeof v === 'object' && v ? (v as Obj).refName ?? (v as Obj).id : v)?.replace(/\D/g, '');
    if (digits && /^\d{6}$/.test(digits)) return digits;
  }
  return null;
}

function addressOf(a: unknown): QbAddress | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as Obj;
  const lines = [r.addressee, r.addr1, r.addr2, r.addr3].map(str).filter((l): l is string => Boolean(l));
  const city = str(r.city);
  if (!lines.length && !city) return null;
  return { lines, city, state: str(r.state), country: refName(r.country) ?? str(r.country) };
}

/** Read a REST record (and its customer) into what is kept. */
export function normalize(kind: NsTxn['kind'], rec: Obj, customer: Obj | null): NsTxn {
  const items = ((rec.item as Obj | undefined)?.items as Obj[] | undefined) ?? [];
  const lines: NsLine[] = items.map((l) => ({
    itemId: refOf(l.item)?.id ?? null,
    itemName: refName(l.item),
    itemType: typeName(l.itemType),
    description: str(l.description),
    quantity: str(l.quantity),
    rate: str(l.rate),
    amount: str(l.amount),
    taxCode: refName(l.taxCode),
    taxable: typeof l.isTaxable === 'boolean' ? l.isTaxable : null,
    unit: refName(l.units) ?? str(l.unitsDisplay),
  }));
  // Shipping and handling are charged on the header: each becomes a line of its own (its tax code mapped like any other).
  let extras = 0;
  for (const [field, taxField, label] of [['shippingCost', 'shippingTaxCode', 'Shipping'], ['handlingCost', 'handlingTaxCode', 'Handling']] as const) {
    const amount = num(rec[field]);
    if (!amount) continue;
    extras += amount;
    lines.push({ itemId: null, itemName: label, itemType: label, description: label === 'Shipping' && refName(rec.shipMethod) ? `Shipping (${refName(rec.shipMethod)})` : label, quantity: '1', rate: String(amount), amount: String(amount), taxCode: refName(rec[taxField]) ?? label, taxable: null, unit: null });
  }
  const subtotal = num(rec.subtotal);
  const discount = num(rec.discountTotal);
  const c = customer ?? {};
  const person = [str(c.firstName), str(c.lastName)].filter(Boolean).join(' ');
  return {
    source: 'netsuite',
    kind,
    id: String(rec.id),
    tranId: str(rec.tranId),
    tranDate: str(rec.tranDate)?.slice(0, 10) ?? '',
    dueDate: str(rec.dueDate)?.slice(0, 10) ?? null,
    terms: refName(rec.terms),
    memo: str(rec.memo),
    paymentMethod: refName(rec.paymentOption) ?? refName(rec.paymentMethod),
    currency: refName(rec.currency),
    exchangeRate: str(rec.exchangeRate),
    customer: {
      id: refOf(rec.entity)?.id ?? null,
      name: refName(rec.entity),
      companyName: str(c.companyName) ?? (person || null),
      email: str(rec.email) ?? str(c.email),
      phone: str(c.phone),
      tin: tinFrom(c),
    },
    billAddress: addressOf(rec.billingAddress),
    lines,
    subtotal: str(rec.subtotal),
    discountTotal: str(rec.discountTotal),
    taxTotal: str(rec.taxTotal),
    netTotal: subtotal === null ? null : (subtotal + (discount ?? 0) + extras).toFixed(2),
    total: str(rec.total),
    createdFrom: refOf(rec.createdFrom)?.id ? { id: refOf(rec.createdFrom)!.id!, name: refName(rec.createdFrom) } : null,
  };
}

/** What was read for issuing, as a fingerprint: our own write-back (custom fields) and memo edits do not change it. */
export function contentHash(t: NsTxn): string {
  const { memo: _memo, ...rest } = t;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 40);
}

const cents = (v: string | null) => (v === null ? null : Math.round(Number(v) * 100));

interface Existing { id: string; status: string; edit_sequence: string | null }

/** Keep a NetSuite transaction for issuing, or note a change (or a void) to one already issued. True when it is new work. */
export async function stageNsTxn(db: Queryable, link: ConnectorLink, t: NsTxn, voided: boolean): Promise<boolean> {
  if (!t.id || (t.tranDate && t.tranDate < link.sync_from)) return false;
  const hash = contentHash(t);
  const existing = (await db.query<Existing>('select id, status, edit_sequence from connector_imports where link_id = $1 and source_type = $2 and source_id = $3', [link.id, t.kind, t.id])).rows[0];
  if (voided) {
    if (!existing) return false;
    if (existing.status === 'issued' || existing.status === 'issuing') {
      await db.query('update connector_imports set problem = $2, updated_at = now() where id = $1', [existing.id, 'Voided in NetSuite after it was sent to BTS: cancel it here, or issue a credit note.']);
    } else if (existing.status !== 'skipped') {
      await db.query("update connector_imports set status = 'skipped', problem = 'Voided in NetSuite.', updated_at = now() where id = $1", [existing.id]);
    }
    return false;
  }
  if (!existing) {
    await db.query(
      `insert into connector_imports (id, tenant_id, link_id, source_type, source_id, source_ref, edit_sequence, source_date, customer_name, total_cents, payload, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'new')`,
      [randomUUID(), link.tenant_id, link.id, t.kind, t.id, t.tranId, hash, t.tranDate || null, t.customer.name, cents(t.netTotal ?? t.subtotal), JSON.stringify(t)],
    );
    return true;
  }
  if (existing.edit_sequence === hash) return false;
  if (existing.status === 'issued' || existing.status === 'issuing') {
    await db.query('update connector_imports set edit_sequence = $2, problem = $3, updated_at = now() where id = $1', [
      existing.id, hash, 'Changed in NetSuite after it was sent to BTS. An authorized document cannot change: if the amounts changed, issue a credit note or debit note here.',
    ]);
    return false;
  }
  if (existing.status === 'skipped') {
    await db.query('update connector_imports set edit_sequence = $2, updated_at = now() where id = $1', [existing.id, hash]);
    return false;
  }
  await db.query(
    `update connector_imports set edit_sequence = $2, payload = $3, source_ref = $4, source_date = $5, customer_name = $6, total_cents = $7, status = 'new',
       problem = null, document_id = null, writeback = 'none', writeback_error = null, attempts = 0, updated_at = now() where id = $1`,
    [existing.id, hash, JSON.stringify(t), t.tranId, t.tranDate || null, t.customer.name, cents(t.netTotal ?? t.subtotal)],
  );
  return true;
}

const SINCE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export interface PollResult { picked: number; written: number; failedWrites: number }

/** One read of a NetSuite account: what changed, then the write-backs due. */
export async function pollNetSuite(deps: { db: Queryable; keys: KeyProtector; now?: () => Date }, link: ConnectorLink, fetchImpl?: typeof fetch): Promise<PollResult> {
  const { db } = deps;
  const client = await clientFor(deps, link, fetchImpl);
  const result: PollResult = { picked: 0, written: 0, failedWrites: 0 };
  const pull = link.settings.pull ?? {};
  const types = [pull.invoices !== false && 'CustInvc', pull.salesReceipts !== false && 'CashSale', pull.creditMemos !== false && 'CustCred'].filter(Boolean) as string[];
  const cursor = link.cursor.netsuite && SINCE.test(link.cursor.netsuite) ? link.cursor.netsuite : `${link.sync_from} 00:00:00`;
  let last = cursor;
  if (types.length && /^\d{4}-\d{2}-\d{2}$/.test(link.sync_from)) {
    // Dates as text in NetSuite's own time zone, compared in the same; >= so a second shared with the last read is read again (and found unchanged).
    const q = `SELECT t.id, t.type, t.voided, TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified FROM transaction t
      WHERE t.type IN (${types.map((x) => `'${x}'`).join(', ')}) AND t.trandate >= TO_DATE('${link.sync_from}', 'YYYY-MM-DD')
      AND t.lastmodifieddate >= TO_DATE('${cursor}', 'YYYY-MM-DD HH24:MI:SS') ORDER BY t.lastmodifieddate, t.id`;
    const customers = new Map<string, Obj | null>();
    try {
      for (let page = 0; page < POLL_PAGES; page++) {
        const r = await client.suiteql(q, page * PAGE_SIZE);
        for (const row of r.items) {
          const type = SQL_TYPES[String(row.type)];
          if (!type) continue;
          const id = String(row.id);
          const rec = await client.record(type.record, id);
          const entity = refOf(rec.entity)?.id;
          if (entity && !customers.has(entity)) customers.set(entity, await client.customer(entity).catch(() => null));
          const t = normalize(type.kind, rec, entity ? customers.get(entity) ?? null : null);
          if (await stageNsTxn(db, link, t, String(row.voided ?? 'F') === 'T')) result.picked++;
          const modified = String(row.modified ?? '');
          if (SINCE.test(modified) && modified > last) last = modified;
        }
        if (!r.hasMore) break;
      }
    } finally {
      // Whatever was read stays read, even when NetSuite stopped answering part way.
      if (last !== cursor) await db.query("update connector_links set cursor = jsonb_set(cursor, '{netsuite}', to_jsonb($2::text)) where id = $1", [link.id, last]);
    }
  }
  const w = await writeBack(db, client, link);
  result.written = w.written;
  result.failedWrites = w.failed;
  return result;
}

async function writeBack(db: Queryable, client: NetSuiteClient, link: ConnectorLink): Promise<{ written: number; failed: number }> {
  const out = { written: 0, failed: 0 };
  const numberField = link.config.numberField || DEFAULT_NUMBER_FIELD;
  const statusField = link.config.statusField || null;
  const qrField = link.config.qrField || null;
  const rows = (await db.query<{ id: string; source_type: NsTxn['kind']; source_id: string; payload: { memo?: string | null }; status: string; problem: string | null; doc_status: string | null; series_number: number | null; serial: string | null; etdui: string | null }>(
    `select i.id, i.source_type, i.source_id, i.payload, i.status, i.problem, d.status as doc_status, d.series_number, d.serial::text as serial, d.etdui
     from connector_imports i left join documents d on d.id = i.document_id
     where i.link_id = $1 and i.writeback = 'pending' order by i.updated_at limit ${WRITEBACK_BATCH}`, [link.id],
  )).rows;
  for (const r of rows) {
    const text = writebackText({ ...r, payload: { memo: '' } });
    const fields: Record<string, string> = { [numberField]: r.status === 'issued' ? text.other : 'Not authorized' };
    if (statusField) fields[statusField] = text.memo.replace(/^\[|\]$/g, '').slice(0, 300);
    // What the QR code on the printed copy holds: BTS's page for this document. Emptied when there is no document to show.
    if (qrField) fields[qrField] = r.status === 'issued' && r.etdui ? qrUrl(r.etdui) : '';
    try {
      await client.update(RECORD_OF[r.source_type], r.source_id, fields);
      await db.query("update connector_imports set writeback = 'done', writeback_error = null, written_status = $2, updated_at = now() where id = $1", [r.id, r.doc_status]);
      out.written++;
    } catch (e) {
      const err = e as NetSuiteError;
      if (err.status === 400 || err.status === 404) {
        const hint = /field|INVALID_KEY_OR_REF|USER_ERROR|INVALID_FLD/i.test(`${err.code} ${err.message}`)
          ? ` Create a Free-Form Text transaction body field with the ID ${[numberField, statusField, qrField].filter(Boolean).join(' and ')}, applied to sales (invoices, cash sales and credit memos), or change the field in Settings > Integrations.`
          : '';
        await db.query("update connector_imports set writeback = 'failed', writeback_error = $2, updated_at = now() where id = $1", [r.id, `${err.message}${hint}`.slice(0, 1000)]);
        out.failed++;
      } else {
        // Signing in or reaching NetSuite: tried again at the next read.
        throw e;
      }
    }
  }
  return out;
}

/** Read the NetSuite connections that are due (each every few minutes, or now when asked). */
export async function pollDueNetSuite(deps: { db: Queryable; keys: KeyProtector; now?: () => Date }, options: { fetch?: typeof fetch; everyMinutes?: number } = {}): Promise<{ links: number; picked: number; written: number; errors: number }> {
  const out = { links: 0, picked: 0, written: 0, errors: 0 };
  const due = (await deps.db.query<{ id: string }>(
    `update connector_links set next_poll_at = now() + make_interval(mins => $1)
     where id in (select id from connector_links where kind = 'netsuite' and status = 'active' and removed_at is null and config ? 'certificateId'
                  and coalesce(next_poll_at, '-infinity'::timestamptz) <= now() order by next_poll_at nulls first limit 10 for update skip locked)
     returning id`, [options.everyMinutes ?? 1],
  )).rows;
  for (const { id } of due) {
    const link = (await deps.db.query<ConnectorLink>(`${LINK_SELECT} where id = $1`, [id])).rows[0];
    if (!link) continue;
    out.links++;
    try {
      const r = await pollNetSuite(deps, link, options.fetch);
      out.picked += r.picked;
      out.written += r.written;
      await deps.db.query('update connector_links set last_seen_at = now(), last_error = null where id = $1', [id]);
    } catch (e) {
      out.errors++;
      await deps.db.query('update connector_links set last_error = $2 where id = $1', [id, (e as Error).message.slice(0, 1000)]);
    }
  }
  return out;
}

// ---------- told by NetSuite the moment a sale is saved ----------

/** A new token for NetSuite's script, and what is kept of it (its hash). */
export function newNotifyToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

export const notifyTokenMatches = (token: string, hash: string | undefined) => Boolean(hash) && createHash('sha256').update(token).digest('hex') === hash;

/**
 * The script a NetSuite administrator installs (a SuiteScript 2.1 user event, deployed on Invoice,
 * Cash Sale and Credit Memo): each time one is saved it tells this service, which reads it at once
 * instead of at the next minute. It sends nothing about the record, only "something changed"; what
 * changed is read through the connection as always. If the call fails, saving in NetSuite is not
 * affected and the record is still picked up at the next read.
 */
export function notifyScript(url: string, token: string): string {
  return `/**
 * Floreo: tells Floreo the moment an invoice, cash sale or credit memo is saved,
 * so it goes to the Belize Tax Service within seconds instead of at the next minute.
 *
 * Install: Customization > Scripting > Scripts > New, upload this file, Create Script Record
 * (User Event), then deploy it three times: on Invoice, Cash Sale and Credit Memo
 * (Status: Released; Execute As Role: Administrator; Audience: all roles).
 *
 * It sends no data about the record. If Floreo cannot be reached, saving is not affected.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/https', 'N/runtime', 'N/log'], (https, runtime, log) => {
  const URL = ${JSON.stringify(url)};
  const TOKEN = ${JSON.stringify(token)};

  const afterSubmit = (context) => {
    // Floreo's own write-back (the BTS number and QR address) is not news to Floreo.
    if (runtime.executionContext === runtime.ContextType.REST_WEBSERVICES) return;
    try {
      const response = https.post({ url: URL, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
      if (response.code >= 400) log.error({ title: 'Floreo', details: 'Floreo answered ' + response.code + ': ' + response.body });
    } catch (e) {
      log.error({ title: 'Floreo', details: e });
    }
  };

  return { afterSubmit };
});
`;
}
