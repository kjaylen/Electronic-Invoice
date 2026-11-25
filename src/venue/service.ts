/**
 * The hospitality module on the server: the menu a device works from, and
 * operations on checks applied, stored and turned into kitchen tickets.
 *
 * Operations are applied one business at a time (the business's row is
 * locked while a batch is folded), in the order they arrive. Each is stored
 * whether it was applied or refused, so the log says everything that was
 * tried. Prices and modifiers on an "add" are the menu's at the moment the
 * item was ordered (`op.at`), never the device's.
 */

import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.ts';
import { StockError, moveStock, recordSale } from '../inventory/stock.ts';
import { apply, type Applied, type Check, type CheckItem, fullyPaid, needsApproval, type Op, type Store } from './check.ts';
import { type ModifierGroup, modifierProblem, type Period, priceNow, type PromoRule, resolveModifiers } from './pricing.ts';
import { belizeClock, businessDate, loadVenue, openBusinessDate, type VenueSettings } from './settings.ts';
import { type TicketBody, ticketsFor } from './station-tickets.ts';
export { type TicketBody, ticketsFor } from './station-tickets.ts';

export class VenueError extends Error {
  override name = 'VenueError';
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------- the menu ----------

export interface Station { id: string; name: string; categories: string[]; deviceId: string | null; screen: boolean; fallbackId: string | null; targetMin: number; position: number }
export interface MenuEntry {
  id: string; name: string; category: string | null; priceCents: number; gst: 'S' | 'Z' | 'E'; exemptionReasonCode: string | null; unitCode: string;
  allergens: string[]; dietary: string[]; soldOut: boolean; remaining: number | null; course: number | null; stationIds: string[]; modifierGroupIds: string[]; favorite: boolean; barcode: string | null;
}

export async function loadPeriods(db: Queryable, tenantId: string): Promise<Period[]> {
  return (await db.query<{ id: string; kind: 'menu' | 'promotion'; name: string; days: number[]; starts_min: number; ends_min: number; categories: string[]; prices: Record<string, number>; rules: PromoRule[]; active: boolean; position: number }>(
    'select id, kind, name, days, starts_min, ends_min, categories, prices, rules, active, position from venue_periods where tenant_id = $1 order by kind, position, lower(name)', [tenantId],
  )).rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, days: r.days, startsMin: r.starts_min, endsMin: r.ends_min, categories: r.categories, prices: r.prices ?? {}, rules: r.rules ?? [], active: r.active, position: r.position }));
}

export async function loadStations(db: Queryable, tenantId: string): Promise<Station[]> {
  return (await db.query<{ id: string; name: string; categories: string[]; device_id: string | null; screen: boolean; fallback_id: string | null; target_min: number; position: number }>(
    'select id, name, categories, device_id, screen, fallback_id, target_min, position from venue_stations where tenant_id = $1 and archived_at is null order by position, lower(name)', [tenantId],
  )).rows.map((r) => ({ id: r.id, name: r.name, categories: r.categories, deviceId: r.device_id, screen: r.screen, fallbackId: r.fallback_id, targetMin: r.target_min, position: r.position }));
}

export async function loadModifierGroups(db: Queryable, tenantId: string): Promise<ModifierGroup[]> {
  const groups = (await db.query<{ id: string; name: string; min_choices: number; max_choices: number }>(
    'select id, name, min_choices, max_choices from modifier_groups where tenant_id = $1 and archived_at is null order by position, lower(name)', [tenantId],
  )).rows;
  const options = (await db.query<{ id: string; group_id: string; name: string; price_cents: unknown; is_default: boolean; item_id: string | null }>(
    'select id, group_id, name, price_cents, is_default, item_id from modifiers where tenant_id = $1 and archived_at is null order by position, lower(name)', [tenantId],
  )).rows;
  return groups.map((g) => ({
    id: g.id, name: g.name, minChoices: g.min_choices, maxChoices: g.max_choices,
    options: options.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, priceCents: Number(o.price_cents), isDefault: o.is_default, itemId: o.item_id })),
  }));
}

const MENU_COLUMNS = `i.id, i.name, i.category, round(i.unit_price * 100)::bigint as price_cents, i.gst_category, i.exemption_reason_code, i.unit_code, i.allergens, i.dietary, i.sold_out, i.remaining,
  i.course, i.station_ids, i.favorite, i.barcode, coalesce((select array_agg(g.group_id order by g.position) from item_modifier_groups g where g.item_id = i.id), '{}') as group_ids`;
interface MenuRow { id: string; name: string; category: string | null; price_cents: unknown; gst_category: 'S' | 'Z' | 'E'; exemption_reason_code: string | null; unit_code: string; allergens: string[]; dietary: string[]; sold_out: boolean; remaining: number | null; course: number | null; station_ids: string[] | null; favorite: boolean; barcode: string | null; group_ids: string[] }

/** The stations that make an item: its own list, else those whose categories include its category. */
export const stationsFor = (stations: Station[], item: { category: string | null; stationIds: string[] | null }) =>
  item.stationIds?.length ? item.stationIds.filter((id) => stations.some((s) => s.id === id)) : stations.filter((s) => item.category && s.categories.some((c) => c.toLowerCase() === item.category!.toLowerCase())).map((s) => s.id);

const menuEntry = (r: MenuRow, stations: Station[]): MenuEntry => ({
  id: r.id, name: r.name, category: r.category, priceCents: Number(r.price_cents), gst: r.gst_category, exemptionReasonCode: r.exemption_reason_code, unitCode: r.unit_code,
  allergens: r.allergens ?? [], dietary: r.dietary ?? [], soldOut: r.sold_out, remaining: r.remaining, course: r.course,
  stationIds: stationsFor(stations, { category: r.category, stationIds: r.station_ids }), modifierGroupIds: r.group_ids ?? [], favorite: r.favorite, barcode: r.barcode,
});

export async function loadMenu(db: Queryable, tenantId: string, stations: Station[], ids?: string[]): Promise<MenuEntry[]> {
  const rows = (await db.query<MenuRow>(
    `select ${MENU_COLUMNS} from items i where i.tenant_id = $1 and i.archived_at is null and ($2::uuid[] is null or i.id = any($2::uuid[])) order by lower(i.name) limit 5000`, [tenantId, ids ?? null],
  )).rows;
  return rows.map((r) => menuEntry(r, stations));
}

// ---------- operations ----------

interface CheckRow { id: string; state: Check; number: number }

const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export interface OpInput { id: string; checkId: string; type: Op['type']; at: string; payload: Record<string, unknown> }
export interface OpResult { id: string; ok: boolean; reason?: string; code?: string; duplicate?: boolean; sent: string[] }
export interface Actor { userId: string; name: string; deviceId: string | null; mayApprove: boolean; mayOrder: boolean; mayKitchen: boolean; /** The server itself, for what only it may do (taking a deposit off a bill). */ internal?: boolean }

/** Who may approve, for the operations that need it: the approver named in the payload must hold the right. */
async function approver(db: Queryable, tenantId: string, raw: unknown, approvers: (role: string) => boolean): Promise<{ id: string; name: string } | null> {
  const id = (raw as { id?: string } | undefined)?.id;
  if (!isUuid(id)) return null;
  const u = (await db.query<{ id: string; name: string; role: string }>("select id, name, role from users where id = $1 and tenant_id = $2 and status = 'active'", [id, tenantId])).rows[0];
  return u && approvers(u.role) ? { id: u.id, name: u.name } : null;
}

/**
 * Apply a batch of operations from one device, in order. Returns what each
 * did. Tickets for what was sent or voided are queued in the same
 * transaction, so an order cannot be applied and its ticket lost.
 */
export async function applyOps(db: Database, tenantId: string, actor: Actor, inputs: OpInput[], options: { now?: Date; approvers: (role: string) => boolean }): Promise<{ results: OpResult[]; seq: number }> {
  return db.transaction(async (tx) => {
    // One batch at a time per business: the lock is the order.
    const t = (await tx.query<{ venue_seq: unknown }>('select venue_seq from tenants where id = $1 for update', [tenantId])).rows[0]!;
    let seq = Number(t.venue_seq);
    const venue = await loadVenue(tx, tenantId);
    const now = options.now ?? new Date();
    const loaded = new Map<string, CheckRow | null>();
    const changed = new Set<string>();
    const fresh = new Set<string>();
    const load = async (id: string) => {
      if (!loaded.has(id)) loaded.set(id, isUuid(id) ? (await tx.query<CheckRow>('select id, state, number from venue_checks where id = $1 and tenant_id = $2 for update', [id, tenantId])).rows[0] ?? null : null);
      return loaded.get(id) ?? null;
    };
    const store: Store = {
      get: (id) => loaded.get(id)?.state,
      put: (check) => {
        const row = loaded.get(check.id);
        if (row) row.state = check;
        else { loaded.set(check.id, { id: check.id, state: check, number: 0 }); fresh.add(check.id); }
        changed.add(check.id);
      },
    };
    let stations: Station[] | null = null;
    let periods: Period[] | null = null;
    let groups: ModifierGroup[] | null = null;
    const results: OpResult[] = [];
    // `printed`: the device had no connection when it sent the order, and printed the tickets itself.
    const tickets: Array<{ check: Check; itemIds: string[]; kind: 'order' | 'void'; printed: boolean }> = [];

    for (const input of inputs) {
      const refuse = async (code: string, reason: string) => {
        results.push({ id: input.id, ok: false, code, reason, sent: [] });
        await tx.query('insert into venue_ops (id, tenant_id, check_id, type, payload, user_id, device_id, at, ok, reason) values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9) on conflict (id) do nothing',
          [input.id, tenantId, input.checkId, input.type, JSON.stringify(input.payload ?? {}), actor.userId, actor.deviceId, input.at, reason]);
      };
      if (!isUuid(input.id) || !isUuid(input.checkId)) { results.push({ id: String(input.id), ok: false, code: 'invalid', reason: 'An operation needs an id and a check', sent: [] }); continue; }
      // The same operation again (the device did not hear the answer): what it did the first time, done once.
      const seen = (await tx.query<{ ok: boolean; reason: string | null }>('select ok, reason from venue_ops where id = $1 and tenant_id = $2', [input.id, tenantId])).rows[0];
      if (seen) { results.push({ id: input.id, ok: seen.ok, duplicate: true, ...(seen.reason && { reason: seen.reason }), sent: [] }); continue; }
      const at = new Date(input.at);
      // A device's clock is trusted for the past (it may have been offline), never for the future.
      const when = Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 120_000 ? now : at;
      const op: Op = { id: input.id, checkId: input.checkId, type: input.type, at: when.toISOString(), by: { id: actor.userId, name: actor.name }, payload: { ...(input.payload ?? {}) } };
      if (op.type === 'deposit' && !actor.internal) { await refuse('forbidden', 'A deposit is taken off from the booking'); continue; }
      const kitchenOnly = op.type === 'ready';
      if (kitchenOnly ? !(actor.mayKitchen || actor.mayOrder) : !actor.mayOrder) { await refuse('forbidden', 'Your role does not take orders'); continue; }
      await load(op.checkId);
      if (typeof op.payload.toCheckId === 'string') await load(op.payload.toCheckId);
      const current = store.get(op.checkId);

      if (op.type === 'open') {
        op.payload.businessDate = openBusinessDate(venue, when);
        const tableId = typeof op.payload.tableId === 'string' ? op.payload.tableId : null;
        if (!current && tableId && op.payload.kind !== 'tab' && op.payload.kind !== 'quick') {
          const taken = (await tx.query<{ id: string }>("select id from venue_checks where tenant_id = $1 and table_id = $2 and status in ('open', 'paid')", [tenantId, tableId])).rows[0];
          if (taken) { await refuse('table_taken', 'That table already has a party: open it instead'); continue; }
        }
        if (isUuid((op.payload.server as { id?: string } | undefined)?.id)) {
          const s = (await tx.query<{ id: string; name: string }>('select id, name from users where id = $1 and tenant_id = $2', [(op.payload.server as { id: string }).id, tenantId])).rows[0];
          if (s) op.payload.server = s; else delete op.payload.server;
        } else delete op.payload.server;
      }
      if (op.type === 'move' && typeof op.payload.tableId === 'string') {
        const taken = (await tx.query<{ id: string }>("select id from venue_checks where tenant_id = $1 and table_id = $2 and status in ('open', 'paid') and id <> $3", [tenantId, op.payload.tableId, op.checkId])).rows[0];
        if (taken) { await refuse('table_taken', 'That table already has a party: merge with it instead'); continue; }
      }
      if (op.type === 'transfer') {
        const id = (op.payload.server as { id?: string } | undefined)?.id;
        const s = isUuid(id) ? (await tx.query<{ id: string; name: string }>("select id, name from users where id = $1 and tenant_id = $2 and status = 'active'", [id, tenantId])).rows[0] : undefined;
        if (!s) { await refuse('invalid', 'Choose who takes it'); continue; }
        op.payload.server = s;
      }
      if (op.type === 'add') {
        // The menu's prices, modifiers, allergens and stations, as they were when it was ordered.
        stations ??= await loadStations(tx, tenantId);
        periods ??= await loadPeriods(tx, tenantId);
        groups ??= await loadModifierGroups(tx, tenantId);
        const raw = (Array.isArray(op.payload.items) ? op.payload.items : []) as Array<Record<string, unknown>>;
        const menu = await loadMenu(tx, tenantId, stations, raw.map((r) => r.itemId).filter(isUuid));
        const clock = belizeClock(when);
        const override = venue.menuOverride?.businessDate === businessDate(when, venue.dayEndsHour) ? venue.menuOverride.periodId : null;
        let problem: string | null = null;
        const priced: Array<Record<string, unknown>> = raw.map((r): Record<string, unknown> => {
          const entry = menu.find((m) => m.id === r.itemId);
          if (!entry) return { ...r, itemId: null, modifiers: [], allergens: [], stationIds: [], tags: [], promo: undefined };
          const itemGroups = groups!.filter((g) => entry.modifierGroupIds.includes(g.id));
          const chosen = (Array.isArray(r.modifiers) ? r.modifiers : []) as Array<{ groupId: string; optionId: string }>;
          problem ??= modifierProblem(itemGroups, chosen) && `${entry.name}: ${modifierProblem(itemGroups, chosen)}`;
          const price = priceNow({ id: entry.id, category: entry.category, priceCents: entry.priceCents }, periods!, clock.minutes, clock.weekday, override);
          return {
            ...r, name: entry.name, category: entry.category, unitCode: entry.unitCode, gst: entry.gst, exemptionReasonCode: entry.exemptionReasonCode ?? undefined,
            unitCents: price.priceCents, promo: price.promo, tags: price.tags, modifiers: resolveModifiers(itemGroups, chosen), allergens: [...entry.allergens],
            stationIds: entry.stationIds, course: r.course ?? entry.course ?? 2,
          };
        });
        if (problem) { await refuse('modifiers', problem); continue; }
        op.payload.items = priced;
        // The countdown of what is left ("86" at zero).
        for (const r of priced) {
          if (isUuid(r.itemId)) await tx.query('update items set remaining = greatest(remaining - $3, 0), sold_out = sold_out or remaining - $3 <= 0 where id = $1 and tenant_id = $2 and remaining is not null', [r.itemId, tenantId, Number(r.quantity ?? 1)]);
        }
      }
      if (current && needsApproval(current, op, venue.discountLimitPercent)) {
        // The person themselves, if they hold the right; else the supervisor whose PIN was checked.
        const ok = actor.mayApprove ? { id: actor.userId, name: actor.name } : await approver(tx, tenantId, op.payload.approvedBy, options.approvers);
        if (!ok) { await refuse('approval_needed', 'A supervisor has to approve this'); continue; }
        op.payload.approvedBy = ok;
      } else delete op.payload.approvedBy;

      const before = current ? new Map(current.items.map((i) => [i.id, fullyPaid(i)])) : new Map<string, boolean>();
      const done: Applied = apply(store, op);
      await tx.query('insert into venue_ops (id, tenant_id, check_id, type, payload, user_id, device_id, at, ok, reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [op.id, tenantId, op.checkId, op.type, JSON.stringify(op.payload), actor.userId, actor.deviceId, op.at, done.ok, done.reason ?? null]);
      results.push({ id: op.id, ok: done.ok, ...(done.reason && { reason: done.reason, code: 'refused' }), ...(done.duplicate && { duplicate: true }), sent: done.sent });
      if (!done.ok) continue;
      const after = store.get(op.checkId)!;
      const printed = op.payload.printed === true;
      if (done.sent.length) tickets.push({ check: after, itemIds: done.sent, kind: 'order', printed });
      if (done.voided.length) tickets.push({ check: after, itemIds: done.voided, kind: 'void', printed });
      if (op.type === 'pay') await stockForPaid(tx, tenantId, after, before, String(op.payload.documentId), actor.userId);
    }

    for (const id of changed) {
      const row = loaded.get(id)!;
      const c = row.state;
      seq += 1;
      const closedAt = c.status === 'closed' || c.status === 'merged' ? c.lastActivityAt : null;
      if (fresh.has(id)) {
        const number = (await tx.query<{ n: number }>('update tenants set next_check_number = next_check_number + 1 where id = $1 returning next_check_number - 1 as n', [tenantId])).rows[0]!.n;
        await tx.query('insert into venue_checks (id, tenant_id, number, kind, status, table_id, server_id, business_date, opened_at, closed_at, state, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
          [id, tenantId, number, c.kind, c.status, c.tableId, isUuid(c.server.id) ? c.server.id : null, c.businessDate, c.openedAt, closedAt, JSON.stringify(c), seq]);
        row.number = number;
      } else {
        // A table is given up the moment its check is closed (the unique index is on open ones).
        await tx.query('update venue_checks set kind = $3, status = $4, table_id = $5, server_id = $6, closed_at = $7, state = $8, seq = $9 where id = $1 and tenant_id = $2',
          [id, tenantId, c.kind, c.status, c.tableId, isUuid(c.server.id) ? c.server.id : null, closedAt, JSON.stringify(c), seq]);
      }
    }
    if (tickets.length) {
      stations ??= await loadStations(tx, tenantId);
      for (const t of tickets) {
        for (const ticket of ticketsFor(t.check, t.itemIds, t.kind, stations, loaded.get(t.check.id)?.number ?? 0)) {
          seq += 1;
          await tx.query(
            'insert into venue_tickets (id, tenant_id, check_id, station_id, kind, body, status, origin_device_id, sent_by, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [randomUUID(), tenantId, t.check.id, ticket.station.id, t.kind, JSON.stringify(ticket.body), t.printed ? 'printed' : ticket.station.screen && !ticket.station.deviceId ? 'screen' : 'queued', actor.deviceId, actor.userId, seq],
          );
        }
      }
    }
    if (seq !== Number(t.venue_seq)) await tx.query('update tenants set venue_seq = $2 where id = $1', [tenantId, seq]);
    return { results, seq };
  });
}

/**
 * Stock for what a payment finished paying. A whole item's receipt line
 * names the catalog item, so the sale already took it off; an item paid in
 * shares has no such line, and choices that are stock themselves (the fries
 * with the burger) are never lines. Those come off here, once, when the
 * item's last share is paid.
 */
async function stockForPaid(tx: Queryable, tenantId: string, check: Check, wasPaid: Map<string, boolean>, documentId: string, userId: string) {
  const doc = isUuid(documentId) ? (await tx.query('select 1 from documents where id = $1 and tenant_id = $2', [documentId, tenantId])).rows.length > 0 : false;
  const lines: Array<{ itemId: string; quantity: string }> = [];
  for (const i of check.items) {
    if (i.status === 'void' || !fullyPaid(i) || wasPaid.get(i.id)) continue;
    const whole = i.shares === 1 && i.paid.length === 1;
    if (!whole && i.itemId) lines.push({ itemId: i.itemId, quantity: String(i.quantity) });
    for (const m of i.modifiers) if (m.itemId) lines.push({ itemId: m.itemId, quantity: String(i.quantity) });
  }
  if (!lines.length) return;
  try {
    if (doc) await recordSale(tx, tenantId, documentId, lines, isUuid(userId) ? userId : null);
    else for (const l of lines) await moveStock(tx, { tenantId, itemId: l.itemId, quantity: `-${l.quantity}`, reason: 'sale', note: 'Sold at a table (the receipt is still on its till)', userId: isUuid(userId) ? userId : null });
  } catch (e) {
    if (!(e instanceof StockError)) throw e;
  }
}

/** What has changed since a device last asked: checks, tickets, and what is sold out. */
export async function changesSince(db: Queryable, tenantId: string, since: number) {
  const t = (await db.query<{ venue_seq: unknown }>('select venue_seq from tenants where id = $1', [tenantId])).rows[0]!;
  const seq = Number(t.venue_seq);
  // From nothing: every open check. Otherwise: whatever moved, open or closed (a closed one frees its table).
  const checks = (await db.query<{ number: number; state: Check }>(
    since === 0 ? "select number, state from venue_checks where tenant_id = $1 and status in ('open', 'paid') order by opened_at limit 2000"
      : 'select number, state from venue_checks where tenant_id = $1 and seq > $2 order by seq limit 2000', since === 0 ? [tenantId] : [tenantId, since],
  )).rows.map((r) => ({ ...r.state, number: r.number }));
  const tickets = (await db.query<TicketRow>(
    `select ${TICKET_COLUMNS} from venue_tickets k where k.tenant_id = $1 and ${since === 0 ? "(k.bumped_at is null and k.created_at > now() - interval '12 hours')" : 'k.seq > $2'} order by k.created_at limit 2000`,
    since === 0 ? [tenantId] : [tenantId, since],
  )).rows.map(ticketJson);
  const soldOut = (await db.query<{ id: string; sold_out: boolean; remaining: number | null }>('select id, sold_out, remaining from items where tenant_id = $1 and archived_at is null and (sold_out or remaining is not null)', [tenantId])).rows
    .map((r) => ({ id: r.id, soldOut: r.sold_out, remaining: r.remaining }));
  return { seq, checks, tickets, soldOut };
}

export const TICKET_COLUMNS = 'k.id, k.check_id, k.station_id, k.kind, k.body, k.status, k.attempts, k.error, k.origin_device_id, k.sent_by, k.created_at, k.printed_at, k.bumped_at';
export interface TicketRow { id: string; check_id: string; station_id: string; kind: 'order' | 'void' | 'change'; body: TicketBody; status: 'queued' | 'printed' | 'failed' | 'screen'; attempts: number; error: string | null; origin_device_id: string | null; sent_by: string | null; created_at: Date | string; printed_at: Date | string | null; bumped_at: Date | string | null }
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export const ticketJson = (k: TicketRow) => ({
  id: k.id, checkId: k.check_id, stationId: k.station_id, kind: k.kind, body: k.body, status: k.status, attempts: k.attempts, error: k.error,
  originDeviceId: k.origin_device_id, sentBy: k.sent_by, createdAt: iso(k.created_at)!, printedAt: iso(k.printed_at), bumpedAt: iso(k.bumped_at),
});

/** A change to a ticket (printed, failed, re-routed, bumped) is a change devices hear about. */
export async function touchTicket(db: Database, tenantId: string, ticketId: string, set: string, params: unknown[]): Promise<ReturnType<typeof ticketJson> | null> {
  return db.transaction(async (tx) => {
    const seq = Number((await tx.query<{ venue_seq: unknown }>('update tenants set venue_seq = venue_seq + 1 where id = $1 returning venue_seq', [tenantId])).rows[0]!.venue_seq);
    const row = (await tx.query<TicketRow>(`update venue_tickets k set ${set}, seq = $3 where k.id = $1 and k.tenant_id = $2 returning ${TICKET_COLUMNS}`, [ticketId, tenantId, seq, ...params])).rows[0];
    return row ? ticketJson(row) : null;
  });
}

export type { VenueSettings };
