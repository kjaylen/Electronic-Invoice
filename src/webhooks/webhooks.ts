/**
 * Webhooks: telling a business's other systems when something happens.
 *
 * Database triggers write each event to event_outbox. The dispatcher turns
 * outbox rows into deliveries (one per endpoint that wants the event), then
 * POSTs them as JSON:
 *
 *   { "id": "<delivery id>", "type": "document.authorized", "createdAt": "...", "data": { ... } }
 *
 * with headers
 *
 *   X-EInvoicing-Event: document.authorized
 *   X-EInvoicing-Delivery: <delivery id>
 *   X-EInvoicing-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint secret>
 *
 * A 2xx answer within 10 seconds is success. Otherwise it is retried after
 * 1 minute, 5 minutes, 30 minutes, 2, 6 and 12 hours, then marked failed; an
 * endpoint that fails 20 deliveries in a row is switched off.
 *
 * Endpoints must be https and resolve to public addresses (checked on every
 * delivery, against the address actually connected to), so webhooks cannot be
 * aimed at the platform's own network.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { formatCents } from '../engine/decimal.ts';

export const WEBHOOK_EVENTS = [
  'document.authorized',
  'document.rejected',
  'document.cancelled',
  'document.issued_offline',
  'order.placed',
  'order.paid',
  'order.fulfilled',
  'order.cancelled',
  'order.refunded',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'ping';

export const RETRY_DELAYS_S = [60, 300, 1800, 7200, 21600, 43200];
export const DISABLE_AFTER_FAILURES = 20;
const MAX_BODY = 2000;

export class WebhookError extends Error {
  override name = 'WebhookError';
}

// ---------- endpoint URLs ----------

/** Private, loopback, link-local, carrier-grade NAT, multicast, reserved: never a webhook target. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

/** A URL a webhook may be sent to; throws with a reason otherwise. */
export function checkEndpointUrl(raw: string, options: { allowPrivate?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError('Enter a full URL, starting with https://');
  }
  if (url.protocol !== 'https:' && !(options.allowPrivate && url.protocol === 'http:')) throw new WebhookError('Webhook URLs must use https');
  if (url.username || url.password) throw new WebhookError('Put credentials in the URL path or query, not before the host');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!options.allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (isIP(host) && isPrivateAddress(host)))) {
    throw new WebhookError('Webhook URLs must be reachable on the public internet');
  }
  return url;
}

// ---------- signing ----------

export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

export function signature(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** For receivers (and tests): check a signature header, rejecting old timestamps (default 5 minutes). */
export function verifySignature(secret: string, header: string, body: string, toleranceS = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceS || !parts.v1) return false;
  const expected = signature(secret, t, body).split('v1=')[1]!;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ---------- sending ----------

export interface SendResult {
  ok: boolean;
  status: number | null;
  body: string;
  error: string | null;
}

/** POST a JSON body, refusing to connect to private addresses (checked on the resolved address itself). */
export function postJson(rawUrl: string, body: string, headers: Record<string, string>, options: { allowPrivate?: boolean; timeoutMs?: number } = {}): Promise<SendResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = checkEndpointUrl(rawUrl, options);
    } catch (e) {
      resolve({ ok: false, status: null, body: '', error: (e as Error).message });
      return;
    }
    const guardedLookup = (hostname: string, opts: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...opts, all: true }, (err, addresses: LookupAddress[]) => {
        if (err) return cb(err, '', 0);
        const safe = options.allowPrivate ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
        if (!safe.length) return cb(Object.assign(new Error('The webhook host resolves to a private address'), { code: 'EPRIVATE' }), '', 0);
        if ((opts as { all?: boolean }).all) return cb(null, safe);
        cb(null, safe[0]!.address, safe[0]!.family);
      });
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'eInvoicing-Webhooks/1', ...headers },
      lookup: guardedLookup as never,
      timeout: options.timeoutMs ?? 10_000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (text.length < MAX_BODY) text += chunk;
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, body: text.slice(0, MAX_BODY), error: null });
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer within 10 seconds')));
    req.on('error', (e) => resolve({ ok: false, status: null, body: '', error: e.message }));
    req.end(body);
  });
}

// ---------- event payloads ----------

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const cents = (v: unknown) => formatCents(toBigInt(v ?? 0));

/** What a delivery says about the event's subject (a document, an order, a refund). */
export async function eventData(db: Queryable, type: string, tenantId: string, subjectId: string): Promise<Record<string, unknown> | null> {
  if (type.startsWith('document.')) {
    const d = (await db.query<Record<string, unknown>>(
      `select id, etdui, etd_type, series_number, serial::text as serial, issue_date::text as issue_date, status, status_detail, reception_env,
         customer_snapshot, referenced_etdui, line_extension_cents, gst_cents, tax_inclusive_cents, protocol_number
       from documents where id = $1 and tenant_id = $2`, [subjectId, tenantId],
    )).rows[0];
    if (!d) return null;
    const customer = (d.customer_snapshot ?? {}) as { name?: string; tin?: string };
    return {
      document: {
        id: d.id, etdui: d.etdui, type: d.etd_type,
        number: `${String(d.series_number).padStart(3, '0')}-${String(d.serial).padStart(9, '0')}`,
        issueDate: d.issue_date, status: d.status, environment: d.reception_env === '01' ? 'production' : 'test',
        customer: { name: customer.name ?? null, tin: customer.tin ?? null },
        referencedEtdui: d.referenced_etdui,
        totals: { lineExtension: cents(d.line_extension_cents), gst: cents(d.gst_cents), taxInclusive: cents(d.tax_inclusive_cents) },
        protocolNumber: d.protocol_number,
        conditions: (d.status_detail as { conditions?: unknown[] } | null)?.conditions ?? [],
      },
    };
  }
  const orderOf = async (orderId: string) => {
    const o = (await db.query<Record<string, unknown>>('select * from orders where id = $1 and tenant_id = $2', [orderId, tenantId])).rows[0];
    if (!o) return null;
    return {
      id: o.id, number: o.number, status: o.status, paymentStatus: o.payment_status, fulfillmentStatus: o.fulfillment_status,
      paymentMethod: o.payment_method, fulfillment: o.fulfillment,
      customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
      totals: { total: cents(o.total_cents), refunded: cents(o.refunded_cents) },
      documentId: o.document_id, createdAt: iso(o.created_at), paidAt: iso(o.paid_at),
    };
  };
  if (type === 'order.refunded') {
    const r = (await db.query<Record<string, unknown>>('select * from order_refunds where id = $1 and tenant_id = $2', [subjectId, tenantId])).rows[0];
    if (!r) return null;
    return { refund: { id: r.id, amount: cents(r.amount_cents), reason: r.reason, lines: r.lines, delivery: r.delivery, documentId: r.document_id, createdAt: iso(r.created_at) }, order: await orderOf(String(r.order_id)) };
  }
  if (type.startsWith('order.')) {
    const order = await orderOf(subjectId);
    return order ? { order } : null;
  }
  return null;
}

// ---------- the dispatcher ----------

export interface DispatchOptions {
  keys: KeyProtector;
  allowPrivate?: boolean;
  /** Called when an endpoint is switched off after repeated failures. */
  onDisabled?: (tenantId: string, endpointId: string, url: string) => Promise<void>;
}

/** Outbox rows → deliveries for each interested endpoint. Returns how many deliveries were created. */
export async function fanOut(db: Queryable, limit = 200): Promise<number> {
  const rows = (await db.query<{ id: string; tenant_id: string; type: string; subject_id: string; created_at: Date }>(
    `update event_outbox set processed_at = now() where id in (
       select id from event_outbox where processed_at is null order by id limit $1 for update skip locked
     ) returning id, tenant_id, type, subject_id, created_at`,
    [limit],
  )).rows;
  if (!rows.length) return 0;
  const tenants = [...new Set(rows.map((r) => r.tenant_id))];
  const endpoints = (await db.query<{ id: string; tenant_id: string; events: string[] }>(
    'select id, tenant_id, events from webhook_endpoints where enabled and tenant_id = any($1::uuid[])', [tenants],
  )).rows;
  let created = 0;
  for (const row of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    const targets = endpoints.filter((e) => e.tenant_id === row.tenant_id && (e.events.includes('*') || e.events.includes(row.type)));
    if (!targets.length) continue;
    const data = await eventData(db, row.type, row.tenant_id, row.subject_id);
    if (!data) continue;
    for (const e of targets) {
      await db.query(
        `insert into webhook_deliveries (id, endpoint_id, tenant_id, type, payload, status) values ($1, $2, $3, $4, $5, 'pending')`,
        [randomUUID(), e.id, row.tenant_id, row.type, JSON.stringify({ createdAt: new Date(row.created_at).toISOString(), data })],
      );
      created++;
    }
  }
  return created;
}

/** Send the deliveries that are due. Returns how many were attempted. */
export async function deliverDue(db: Queryable, options: DispatchOptions, limit = 25, onlyId?: string): Promise<number> {
  // Claim with a lease, so two processes never send the same delivery at once.
  const due = (await db.query<{ id: string; endpoint_id: string; tenant_id: string; type: string; payload: { createdAt: string; data: unknown }; attempts: number }>(
    `update webhook_deliveries set next_attempt_at = now() + interval '2 minutes' where id in (
       select id from webhook_deliveries where status = 'pending' and next_attempt_at <= now() and ($2::uuid is null or id = $2::uuid)
       order by next_attempt_at limit $1 for update skip locked
     ) returning id, endpoint_id, tenant_id, type, payload, attempts`,
    [limit, onlyId ?? null],
  )).rows;
  for (const d of due) {
    const ep = (await db.query<{ url: string; secret_encrypted: string; enabled: boolean; consecutive_failures: number }>(
      'select url, secret_encrypted, enabled, consecutive_failures from webhook_endpoints where id = $1', [d.endpoint_id],
    )).rows[0];
    if (!ep || !ep.enabled) {
      await db.query("update webhook_deliveries set status = 'failed', error = 'The endpoint is switched off' where id = $1", [d.id]);
      continue;
    }
    const secret = (await options.keys.decrypt(ep.secret_encrypted, `webhook:${d.endpoint_id}`)).toString('utf8');
    const body = JSON.stringify({ id: d.id, type: d.type, createdAt: d.payload.createdAt, data: d.payload.data });
    const t = Math.floor(Date.now() / 1000);
    const result = await postJson(ep.url, body, { 'x-einvoicing-event': d.type, 'x-einvoicing-delivery': d.id, 'x-einvoicing-signature': signature(secret, t, body) }, { ...(options.allowPrivate && { allowPrivate: true }) });
    const attempts = d.attempts + 1;
    if (result.ok) {
      await db.query("update webhook_deliveries set status = 'delivered', attempts = $2, response_status = $3, response_body = $4, error = null, delivered_at = now() where id = $1", [d.id, attempts, result.status, result.body]);
      await db.query('update webhook_endpoints set consecutive_failures = 0, last_delivery_at = now() where id = $1', [d.endpoint_id]);
      continue;
    }
    const delay = RETRY_DELAYS_S[attempts - 1];
    await db.query(
      `update webhook_deliveries set status = $2, attempts = $3, response_status = $4, response_body = $5, error = $6,
         next_attempt_at = case when $7::int is null then next_attempt_at else now() + make_interval(secs => $7::int) end where id = $1`,
      [d.id, delay === undefined ? 'failed' : 'pending', attempts, result.status, result.body, result.error ?? (result.status ? `Answered ${result.status}` : 'No answer'), delay ?? null],
    );
    const failures = (await db.query<{ n: number }>('update webhook_endpoints set consecutive_failures = consecutive_failures + 1 where id = $1 returning consecutive_failures as n', [d.endpoint_id])).rows[0]?.n ?? 0;
    if (failures >= DISABLE_AFTER_FAILURES) {
      const off = await db.query("update webhook_endpoints set enabled = false, disabled_reason = 'Switched off after 20 failed deliveries in a row' where id = $1 and enabled returning id", [d.endpoint_id]);
      if (off.rows.length) await options.onDisabled?.(d.tenant_id, d.endpoint_id, ep.url).catch(() => {});
    }
  }
  return due.length;
}

/** Fan out, then deliver; repeat while there is work (bounded). */
export async function dispatchWebhooks(db: Queryable, options: DispatchOptions): Promise<{ created: number; attempted: number }> {
  let created = 0;
  let attempted = 0;
  for (let i = 0; i < 10; i++) {
    const c = await fanOut(db);
    const a = await deliverDue(db, options);
    created += c;
    attempted += a;
    if (!c && !a) break;
  }
  return { created, attempted };
}

export function startWebhookDispatcher(db: Queryable, options: DispatchOptions & { intervalMs?: number; onError?: (e: unknown) => void }) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchWebhooks(db, options);
    } catch (e) {
      options.onError?.(e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5_000);
  timer.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
