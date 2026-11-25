/**
 * Offline-first tills: what a till needs to sell without the server, and how
 * it catches up. Both use the till's device token (Bearer till_...), so a
 * till can catch up even when nobody is signed in on it.
 *
 *   GET  /v1/pos/snapshot?install=<uuid>   everything needed to sell offline: the business, the receipt
 *                                          header, tax settings, items, categories, customers, the people
 *                                          who sell here, the till's register, its offline series and next
 *                                          serial, the server's clock. The first call for an install gives
 *                                          it a series of its own (pos_offline_series).
 *   POST /v1/pos/sync { events }           what the till did offline, oldest first: sales, shifts opened and
 *                                          closed, cash paid in and out. Each event has the till's own UUID;
 *                                          sending one again returns its first result and changes nothing.
 *
 * Rules, written down in docs/offline-tills/DECISIONS.md:
 *  - A completed sale is never refused or altered. It keeps the till's number, time, prices and ETDUI.
 *    A product deleted since, a customer deleted since, a person removed since, a price changed since:
 *    the sale is stored as sold, without the missing link, and a warning says so.
 *  - Stock may go negative; when it does, the reply warns and the activity log records it.
 *  - Events are applied in order. A failure that may pass on a retry (no certificate yet, the database
 *    busy) stops the batch there, so later sales do not overtake it; a failure that will not pass
 *    (a receipt that does not match its number) is reported and the batch goes on.
 */

import { loadVenue } from '../venue/settings.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { loadSupplier } from '../db/tenants.ts';
import { CalcError, calculateDocument, type LineInput } from '../engine/calc.ts';
import { buildEtdui, EtduiError } from '../engine/etdui.ts';
import { buildUblDocument, type Customer, UblError } from '../engine/ubl.ts';
import { recordSale } from '../inventory/stock.ts';
import { issueOfflineReceipt, type IssueRequest, PipelineError, type PipelineDeps } from '../pipeline/issue.ts';
import { QR_BASE_URLS, readEtdForPrint } from '../render/view.ts';
import { assetPath } from '../templates/assets.ts';
import { customersForTill, itemsForTill, meJson } from './catalog.ts';
import { ApiError } from './errors.ts';
import { recordLoyalty } from './loyalty.ts';
import { deviceFromToken, tillPermissions } from './pos.ts';
import type { Role } from './permissions.ts';
import { expectedCash, openShiftOf } from './shifts.ts';
import { uuid } from './schemas.ts';

const RECEPTION_ENV: Record<string, '01' | '02'> = { production: '01', test: '02' };
const SERIES_FIRST = 101;
const SERIES_LAST = 899;

/** The series this install of a till numbers its receipts in: given once, never to anyone else. */
export async function offlineSeries(db: Queryable, tenantId: string, environment: string, deviceId: string, installId: string): Promise<{ series: number; nextSerial: number }> {
  let row = (await db.query<{ series_number: number }>(
    'select series_number from pos_offline_series where device_id = $1 and install_id = $2 and environment = $3', [deviceId, installId, environment],
  )).rows[0];
  for (let attempt = 0; !row && attempt < 5; attempt++) {
    // The lowest number not used by any series of the business, nor ever given to a till.
    const free = (await db.query<{ n: number }>(
      `select n from generate_series($3::int, $4::int) n
       where not exists (select 1 from series s where s.tenant_id = $1 and s.environment = $2 and s.series_number = n)
         and not exists (select 1 from pos_offline_series o where o.tenant_id = $1 and o.environment = $2 and o.series_number = n)
       order by n limit 1`,
      [tenantId, environment, SERIES_FIRST, SERIES_LAST],
    )).rows[0];
    if (!free) throw new ApiError(409, 'no_series_left', 'Every series for tills is taken; contact support');
    const inserted = await db.query<{ series_number: number }>(
      `insert into pos_offline_series (tenant_id, environment, series_number, device_id, install_id) values ($1, $2, $3, $4, $5)
       on conflict do nothing returning series_number`,
      [tenantId, environment, free.n, deviceId, installId],
    );
    row = inserted.rows[0] ?? (await db.query<{ series_number: number }>(
      'select series_number from pos_offline_series where device_id = $1 and install_id = $2 and environment = $3', [deviceId, installId, environment],
    )).rows[0];
  }
  if (!row) throw new ApiError(503, 'busy', 'Could not give this till a series; try again');
  const next = (await db.query<{ next_serial: string }>(
    `select next_serial::text from series where tenant_id = $1 and environment = $2 and etd_type = '02' and series_number = $3`, [tenantId, environment, row.series_number],
  )).rows[0];
  return { series: row.series_number, nextSerial: next ? Number(next.next_serial) : 1 };
}

/** The business as its receipts print it: built the way the server's own printed copy reads it. */
async function receiptIssuer(deps: PipelineDeps, tenantId: string) {
  const { supplier, environment } = await loadSupplier(deps.db, tenantId);
  const totals = calculateDocument({ lines: [{ description: 'x', quantity: '1', unitCode: 'H87', unitPrice: '1', gstCategory: 'S' }] }, deps.tax);
  const etdui = buildEtdui({ etdType: '02', tin: supplier.tin, serial: 1, series: SERIES_FIRST, issueDate: '2026-01-01', issueTime: '00:00:00', operMode: 3, receptionEnv: RECEPTION_ENV[environment] ?? '02', securityCode: '000000000' });
  const ubl = buildUblDocument({ etdType: '02', etdui, issueDate: '2026-01-01', issueTime: '00:00:00', supplier, totals, payment: { meansCode: '10', terms: 'Paid' }, previousSequenceHash: null }, deps.ubl);
  return readEtdForPrint(ubl.xml).issuer;
}

// ---------- the events a till uploads ----------

interface SaleEvent {
  id: string;
  kind: 'sale';
  at: string;
  userId?: string | null;
  shiftId?: string | null;
  environment: string;
  series: number;
  serial: number;
  issueDate: string;
  issueTime: string;
  securityCode: string;
  etdui: string;
  request: { lines: LineInput[]; customer?: Customer; customerId?: string | null; payment?: { meansCode?: string; terms?: string }; note?: string; lineItemIds?: Array<string | null> };
  tenders?: Array<{ means: string; cents: string }>;
  /** A tip added to the payment: for the staff, not on the receipt. */
  tip?: { means: string; cents: string };
}
interface ShiftOpenEvent { id: string; kind: 'shift_open'; at: string; userId: string; shiftId: string; openingFloat: string }
interface CashEvent { id: string; kind: 'cash'; at: string; userId?: string | null; shiftId: string; type: 'pay_in' | 'pay_out'; amount: string; reason: string }
interface ShiftCloseEvent { id: string; kind: 'shift_close'; at: string; userId: string; shiftId: string; countedCash: string; counted?: Record<string, number> | null; note?: string | null }
type SyncEvent = SaleEvent | ShiftOpenEvent | CashEvent | ShiftCloseEvent;

interface EventResult {
  id: string;
  status: 'applied' | 'duplicate' | 'failed' | 'not_processed';
  /** A failure that may pass if sent again later. */
  retry?: boolean;
  error?: { code: string; message: string };
  document?: { id: string; etdui: string; status: string };
  warnings?: string[];
  /** A shift the till opened: the number the business gave it. */
  shift?: { number: number };
}

const money = { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,2})?$' } as const;
const at = { type: 'string', minLength: 10, maxLength: 40 } as const;
const eventSchema = {
  type: 'object',
  required: ['events'],
  additionalProperties: false,
  properties: {
    events: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['id', 'kind', 'at'],
        properties: {
          id: uuid,
          kind: { type: 'string', enum: ['sale', 'shift_open', 'cash', 'shift_close'] },
          at,
          userId: { anyOf: [uuid, { type: 'null' }] },
          shiftId: { anyOf: [uuid, { type: 'null' }] },
          environment: { type: 'string', enum: ['test', 'production'] },
          series: { type: 'integer', minimum: SERIES_FIRST, maximum: SERIES_LAST },
          serial: { type: 'integer', minimum: 1, maximum: 999_999_999 },
          issueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          issueTime: { type: 'string', pattern: '^\\d{2}:\\d{2}:\\d{2}$' },
          securityCode: { type: 'string', pattern: '^\\d{9}$' },
          etdui: { type: 'string', pattern: '^\\d{44}$' },
          request: { type: 'object' },
          tenders: { type: 'array', maxItems: 6, items: { type: 'object', required: ['means', 'cents'], additionalProperties: false, properties: { means: { type: 'string', pattern: '^\\d{1,3}$' }, cents: { type: 'string', pattern: '^\\d{1,15}$' } } } },
          tip: { type: 'object', required: ['means', 'cents'], additionalProperties: false, properties: { means: { type: 'string', pattern: '^\\d{1,3}$' }, cents: { type: 'string', pattern: '^[1-9]\\d{0,14}$' } } },
          openingFloat: money,
          type: { type: 'string', enum: ['pay_in', 'pay_out'] },
          amount: money,
          reason: { type: 'string', maxLength: 200 },
          countedCash: money,
          counted: { anyOf: [{ type: 'object', maxProperties: 30 }, { type: 'null' }] },
          note: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
        },
      },
    },
  },
} as const;

const centsOf = (amount: string) => {
  const [w = '0', f = ''] = amount.split('.');
  return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
};

/** Failures no retry can fix: the event itself is wrong. Anything else (the database, BTS settings, a certificate not uploaded yet) may pass later. */
function isPermanent(e: unknown): boolean {
  if (e instanceof CalcError || e instanceof UblError || e instanceof EtduiError) return true;
  if (e instanceof ApiError) return e.status === 422;
  return e instanceof PipelineError && /does not match its parts|reserved for|Only Tax Receipts|taken by another business/.test(e.message);
}

function failure(id: string, e: unknown): EventResult {
  const err = e as Error;
  const code = e instanceof ApiError ? e.code : e instanceof CalcError ? 'invalid_lines' : e instanceof PipelineError ? 'not_issued' : 'error';
  return { id, status: 'failed', retry: !isPermanent(e), error: { code, message: String(err?.message ?? e).slice(0, 300) } };
}

export function registerPosSyncRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get<{ Querystring: { install: string } }>(
    '/snapshot',
    { schema: { querystring: { type: 'object', required: ['install'], additionalProperties: false, properties: { install: uuid } } } },
    async (request, reply) => {
      const d = await deviceFromToken(db, request);
      const t = (await db.query<{ slug: string; legal_name: string; trade_name: string | null; tin: string; environment: string }>(
        'select slug, legal_name, trade_name, tin, environment from tenants where id = $1', [d.tenant_id],
      )).rows[0]!;
      const users = (await db.query<{ id: string; name: string; role: Role; has_pin: boolean; pin_set_at: Date | null }>(
        `select u.id, u.name, u.role, u.pos_pin_set_at is not null as has_pin, u.pos_pin_set_at as pin_set_at from users u
         where u.tenant_id = $1 and u.status = 'active' and u.role not in ('accountant') order by lower(u.name)`, [d.tenant_id],
      )).rows;
      const logo = (await db.query<{ id: string; name: string; content_type: string; bytes: number; data: Buffer | Uint8Array }>(
        'select a.id, a.name, a.content_type, a.bytes, a.data from tenants t join template_assets a on a.id = t.logo_asset_id where t.id = $1', [d.tenant_id],
      )).rows[0];
      const categories = (await db.query<{ name: string }>(
        `select distinct category as name from items where tenant_id = $1 and archived_at is null and category is not null order by 1`, [d.tenant_id],
      )).rows;
      const venue = await loadVenue(db, d.tenant_id);
      const series = await offlineSeries(db, d.tenant_id, t.environment, d.id, request.query.install);
      reply.header('Cache-Control', 'no-store');
      return {
        serverTime: new Date().toISOString(),
        business: { id: d.tenant_id, slug: t.slug, name: t.trade_name ?? t.legal_name, legalName: t.legal_name, tradeName: t.trade_name, tin: t.tin, environment: t.environment },
        device: { id: d.id, name: d.name, register: { id: d.register_id, name: d.register_name } },
        // pinSetAt: a PIN changed since the till remembered it is forgotten there (offline sign-in).
        users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, hasPin: u.has_pin, pinSetAt: u.pin_set_at ? new Date(u.pin_set_at).toISOString() : null, permissions: tillPermissions(u.role, venue) })),
        // A shift open on this till's drawer (opened before the till sold offline): the till carries on with it.
        openShift: await openShiftOf(db, d.tenant_id, d.register_id),
        me: await meJson(deps, d.tenant_id),
        receipt: {
          issuer: await receiptIssuer(deps, d.tenant_id),
          // The QR code on a receipt is this address followed by its ETDUI (render/view.ts, qrUrl).
          qrBase: t.environment === 'production' ? QR_BASE_URLS.production : QR_BASE_URLS.test,
          // Inlined, so the till prints it offline; a large one by its address (fetched while online).
          logo: !logo ? null : logo.bytes <= 512 * 1024 ? `data:${logo.content_type};base64,${Buffer.from(logo.data).toString('base64')}` : assetPath(logo),
        },
        tax: deps.tax ?? null,
        offline: { series: series.series, nextSerial: series.nextSerial, receptionEnv: RECEPTION_ENV[t.environment] ?? '02', environment: t.environment },
        items: await itemsForTill(db, d.tenant_id),
        categories,
        customers: await customersForTill(db, d.tenant_id),
      };
    },
  );

  app.post<{ Body: { events: SyncEvent[] } }>('/sync', { bodyLimit: 5 * 1024 * 1024, schema: { body: eventSchema } }, async (request) => {
    const d = await deviceFromToken(db, request);
    const results: EventResult[] = [];
    let stopped = false;
    for (const ev of request.body.events) {
      if (stopped) {
        results.push({ id: ev.id, status: 'not_processed', retry: true });
        continue;
      }
      let r: EventResult;
      try {
        r = await apply(request, d, ev);
      } catch (e) {
        request.log.error({ err: e, event: ev.id, kind: ev.kind }, 'till sync event failed');
        r = failure(ev.id, e);
      }
      results.push(r);
      // A retryable failure keeps the rest in order behind it.
      if (r.status === 'failed' && r.retry) stopped = true;
    }
    await db.query('update pos_devices set last_seen_at = now() where id = $1', [d.id]);
    return { results };
  });

  type Device = Awaited<ReturnType<typeof deviceFromToken>>;

  async function knownUser(q: Queryable, tenantId: string, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    return (await q.query<{ id: string }>('select id from users where id = $1 and tenant_id = $2', [userId, tenantId])).rows[0]?.id ?? null;
  }

  /**
   * Each event is written to pos_sync_events in the same transaction as what it does, so it is
   * done once: when the row is already there, its first result is returned and nothing runs.
   */
  async function once(tx: Queryable, d: Device, ev: SyncEvent, documentId: string | null): Promise<EventResult | null> {
    const fresh = await tx.query(
      `insert into pos_sync_events (id, tenant_id, device_id, kind, happened_at, document_id) values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing returning id`,
      [ev.id, d.tenant_id, d.id, ev.kind, ev.at, documentId],
    );
    if (fresh.rows.length) return null;
    const first = (await tx.query<{ tenant_id: string; kind: string; result: EventResult }>('select tenant_id, kind, result from pos_sync_events where id = $1', [ev.id])).rows[0];
    if (!first || first.tenant_id !== d.tenant_id || first.kind !== ev.kind) throw new ApiError(422, 'id_taken', 'This event id is already used by something else');
    return { ...first.result, id: ev.id, status: 'duplicate' };
  }

  async function finish(tx: Queryable, r: EventResult): Promise<EventResult> {
    await tx.query('update pos_sync_events set result = $2 where id = $1', [r.id, JSON.stringify(r)]);
    return r;
  }

  async function apply(request: FastifyRequest, d: Device, ev: SyncEvent): Promise<EventResult> {
    switch (ev.kind) {
      case 'sale': return applySale(request, d, ev);
      case 'shift_open': return db.transaction(async (tx) => (await once(tx, d, ev, null)) ?? finish(tx, await applyShiftOpen(tx, d, ev)));
      case 'cash': return db.transaction(async (tx) => (await once(tx, d, ev, null)) ?? finish(tx, await applyCash(tx, d, ev)));
      case 'shift_close': return db.transaction(async (tx) => (await once(tx, d, ev, null)) ?? finish(tx, await applyShiftClose(tx, d, ev)));
    }
  }

  async function applySale(request: FastifyRequest, d: Device, ev: SaleEvent): Promise<EventResult> {
    const warnings: string[] = [];
    if (!ev.series || !ev.serial || !ev.etdui || !ev.securityCode || !ev.issueDate || !ev.issueTime || !ev.request || !Array.isArray(ev.request.lines) || ev.request.lines.length === 0) {
      throw new ApiError(422, 'invalid_sale', 'The sale is missing its number, time or lines');
    }
    // Uploaded before, completely: its first result.
    const done = (await db.query<{ tenant_id: string; result: EventResult }>("select tenant_id, result from pos_sync_events where id = $1 and kind = 'sale'", [ev.id])).rows[0];
    if (done && done.tenant_id === d.tenant_id) return { ...done.result, id: ev.id, status: 'duplicate' };

    const env = (await db.query<{ environment: string }>('select environment from tenants where id = $1', [d.tenant_id])).rows[0]!.environment;
    // A series given to one of the business's tills (not only this one: a till removed and added again
    // sends the sales it made before with its new token).
    const owned = (await db.query('select 1 from pos_offline_series where tenant_id = $1 and environment = $2 and series_number = $3', [d.tenant_id, ev.environment, ev.series])).rows.length;
    if (!owned) throw new ApiError(422, 'unknown_series', `Series ${ev.series} was not given to a till of this business`);
    if (ev.environment !== env) throw new ApiError(422, 'environment_changed', `This sale was made in the ${ev.environment} environment; the business is now in ${env}`);

    // Links that no longer exist are dropped; the sale keeps what it printed.
    const userId = await knownUser(db, d.tenant_id, ev.userId);
    if (ev.userId && !userId) warnings.push('The person who sold is no longer in the business; the sale is kept without them.');
    let customerId: string | null = null;
    if (ev.request.customerId) {
      customerId = (await db.query<{ id: string }>('select id from customers where id = $1 and tenant_id = $2', [ev.request.customerId, d.tenant_id])).rows[0]?.id ?? null;
      if (!customerId) warnings.push('The customer was deleted; the sale keeps the customer as printed.');
    }
    const wanted = (ev.request.lineItemIds ?? []).filter((x): x is string => Boolean(x));
    const found = new Set(wanted.length ? (await db.query<{ id: string }>('select id from items where tenant_id = $1 and id = any($2::uuid[])', [d.tenant_id, wanted])).rows.map((r) => r.id) : []);
    const lineItemIds = ev.request.lines.map((_, i) => {
      const id = ev.request.lineItemIds?.[i] ?? null;
      return id && found.has(id) ? id : null;
    });
    if (wanted.some((id) => !found.has(id))) warnings.push('A product on the sale was deleted; its line is kept as sold.');
    let shiftId: string | null = null;
    if (ev.shiftId) {
      shiftId = (await db.query<{ id: string }>('select id from register_shifts where id = $1 and tenant_id = $2', [ev.shiftId, d.tenant_id])).rows[0]?.id ?? null;
      if (!shiftId) warnings.push('The shift of this sale was not found; the sale is kept outside a shift.');
    }

    const req: IssueRequest = {
      etdType: '02',
      lines: ev.request.lines,
      ...(ev.request.customer && { customer: ev.request.customer }),
      ...(customerId && { customerId }),
      ...(ev.request.payment && { payment: ev.request.payment }),
      ...(ev.request.note && { note: ev.request.note }),
      lineItemIds,
    };
    // 1. The document, with its till number, signed and sent to BTS (or queued for it). Once: the id is the till's.
    const result = await issueOfflineReceipt(deps, d.tenant_id, {
      documentId: ev.id, seriesNumber: ev.series, serial: ev.serial, issueDate: ev.issueDate, issueTime: ev.issueTime, securityCode: ev.securityCode, etdui: ev.etdui,
    }, req, async (tx, documentId) => {
      // Who sold, on which till and shift, and how it was paid, written with the document.
      await tx.query('update documents set issued_by = $3, device_id = $4, shift_id = $5, tenders = $6 where tenant_id = $1 and id = $2',
        [d.tenant_id, documentId, userId, d.id, shiftId, ev.tenders && ev.tenders.length > 1 ? JSON.stringify(ev.tenders) : null]);
      if (ev.tip) {
        await tx.query('insert into sale_tips (document_id, tenant_id, shift_id, user_id, means, amount_cents) values ($1, $2, $3, $4, $5, $6) on conflict do nothing',
          [documentId, d.tenant_id, shiftId, userId, ev.tip.means, ev.tip.cents]);
      }
    });

    // 2. Its stock and points, once, with the event's row. If this fails the sale is kept and the till sends it again:
    //    step 1 then finds the document, and this step runs again.
    return db.transaction(async (tx) => {
      const again = await once(tx, d, ev, result.documentId);
      if (again) return again;
      await recordSale(tx, d.tenant_id, result.documentId, lineItemIds.map((itemId, i) => ({ itemId, quantity: ev.request.lines[i]!.quantity })), userId);
      await recordLoyalty(tx, d.tenant_id, result.documentId, req, undefined, userId, deps.tax);
      // Stock below zero after an offline sale is allowed, and flagged for a count.
      const below = found.size ? (await tx.query<{ name: string; stock: string }>(
        'select name, stock_quantity::text as stock from items where tenant_id = $1 and id = any($2::uuid[]) and stock_quantity < 0', [d.tenant_id, [...found]],
      )).rows : [];
      for (const b of below) {
        warnings.push(`${b.name} is now at ${Number(b.stock)} in stock; count it.`);
        await audit(tx, { tenantId: d.tenant_id, userId, action: 'stock.negative', target: b.name, details: { stock: Number(b.stock), documentId: result.documentId, till: d.name } });
      }
      request.log.info({ event: ev.id, document: result.documentId, duplicateDocument: result.duplicate }, 'till sale synced');
      return finish(tx, { id: ev.id, status: 'applied', document: { id: result.documentId, etdui: result.etdui, status: result.status }, ...(warnings.length && { warnings }) });
    });
  }

  async function applyShiftOpen(tx: Queryable, d: Device, ev: ShiftOpenEvent): Promise<EventResult> {
    if (!ev.shiftId || ev.openingFloat === undefined) throw new ApiError(422, 'invalid_shift', 'The shift is missing its id or float');
    const exists = (await tx.query<{ number: number }>('select number from register_shifts where id = $1 and tenant_id = $2', [ev.shiftId, d.tenant_id])).rows[0];
    if (exists) return { id: ev.id, status: 'applied', shift: { number: exists.number } };
    const warnings: string[] = [];
    const userId = await knownUser(tx, d.tenant_id, ev.userId);
    if (!userId) throw new ApiError(422, 'unknown_user', 'The person who opened the shift is not in the business');
    // The till's drawer is the till's: a shift left open on it (or by this person elsewhere) is closed first, uncounted.
    const others = (await tx.query<{ id: string; number: number }>(
      `select id, number from register_shifts where tenant_id = $1 and closed_at is null and (register_id = $2 or opened_by = $3)`, [d.tenant_id, d.register_id, userId],
    )).rows;
    for (const o of others) {
      await tx.query(
        `update register_shifts set closed_at = greatest(opened_at, $3::timestamptz), close_note = $4 where id = $1 and tenant_id = $2 and closed_at is null`,
        [o.id, d.tenant_id, ev.at, `Closed automatically: the till ${d.name} uploaded a shift opened at ${ev.at}. Count this drawer's cash.`],
      );
      await audit(tx, { tenantId: d.tenant_id, userId, action: 'shift.closed', target: `#${o.number}`, details: { automatic: true, till: d.name } });
      warnings.push(`Shift ${o.number} was still open and has been closed; its cash was not counted.`);
    }
    const number = (await tx.query<{ n: number }>('update tenants set next_shift_number = next_shift_number + 1 where id = $1 returning next_shift_number - 1 as n', [d.tenant_id])).rows[0]!.n;
    await tx.query(
      `insert into register_shifts (id, tenant_id, register_id, number, opened_by, opened_at, opening_float_cents, device_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ev.shiftId, d.tenant_id, d.register_id, number, userId, ev.at, String(centsOf(ev.openingFloat)), d.id],
    );
    await audit(tx, { tenantId: d.tenant_id, userId, action: 'shift.opened', target: `#${number} ${d.register_name}`, details: { float: ev.openingFloat, till: d.name, offline: true } });
    return { id: ev.id, status: 'applied', shift: { number }, ...(warnings.length && { warnings }) };
  }

  async function applyCash(tx: Queryable, d: Device, ev: CashEvent): Promise<EventResult> {
    if (!ev.shiftId || !ev.type || !ev.amount || centsOf(ev.amount) <= 0n) throw new ApiError(422, 'invalid_cash', 'The cash movement is missing its shift, kind or amount');
    const shift = (await tx.query<{ number: number }>('select number from register_shifts where id = $1 and tenant_id = $2', [ev.shiftId, d.tenant_id])).rows[0];
    // Events come in order, so a shift still missing here was refused: the movement cannot be placed.
    if (!shift) throw new ApiError(422, 'shift_not_found', 'The shift of this cash movement was not found on the server');
    const userId = await knownUser(tx, d.tenant_id, ev.userId);
    const reason = (ev.reason ?? '').trim() || (ev.type === 'pay_in' ? 'Paid in' : 'Paid out');
    await tx.query(
      'insert into cash_movements (id, tenant_id, shift_id, kind, amount_cents, reason, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing',
      [ev.id, d.tenant_id, ev.shiftId, ev.type, String(centsOf(ev.amount)), reason, userId, ev.at],
    );
    await audit(tx, { tenantId: d.tenant_id, userId, action: ev.type === 'pay_in' ? 'shift.cash_in' : 'shift.cash_out', target: `#${shift.number}`, details: { amount: ev.amount, reason, till: d.name } });
    return { id: ev.id, status: 'applied' };
  }

  async function applyShiftClose(tx: Queryable, d: Device, ev: ShiftCloseEvent): Promise<EventResult> {
    if (!ev.shiftId || ev.countedCash === undefined) throw new ApiError(422, 'invalid_shift', 'The closing is missing its shift or count');
    const shift = (await tx.query<{ number: number; counted_cash_cents: string | null }>('select number, counted_cash_cents::text from register_shifts where id = $1 and tenant_id = $2', [ev.shiftId, d.tenant_id])).rows[0];
    if (!shift) throw new ApiError(422, 'shift_not_found', 'The shift was not found on the server');
    if (shift.counted_cash_cents !== null) return { id: ev.id, status: 'applied', warnings: ['This shift had already been counted; the till\'s count was not applied.'] };
    // Closed automatically meanwhile (another shift opened on this drawer): the count still goes on it.
    const expected = await expectedCash(tx, d.tenant_id, ev.shiftId);
    const counted = centsOf(ev.countedCash);
    const userId = await knownUser(tx, d.tenant_id, ev.userId);
    await tx.query(
      `update register_shifts set closed_by = $3, closed_at = coalesce(closed_at, $4::timestamptz), expected_cash_cents = $5, counted_cash_cents = $6, counted_detail = $7, close_note = coalesce($8, close_note)
       where id = $1 and tenant_id = $2 and counted_cash_cents is null`,
      [ev.shiftId, d.tenant_id, userId, ev.at, String(expected), String(counted), ev.counted ? JSON.stringify(ev.counted) : null, ev.note?.trim() || null],
    );
    const fmt = (c: bigint) => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
    await audit(tx, { tenantId: d.tenant_id, userId, action: 'shift.closed', target: `#${shift.number} ${d.register_name}`, details: { expected: fmt(expected), counted: fmt(counted), difference: fmt(counted - expected), till: d.name } });
    return { id: ev.id, status: 'applied' };
  }
}

export { PipelineError };
