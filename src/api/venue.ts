/**
 * Hospitality: setup (the switch, floor plans, periods, stations, the menu's
 * modifiers and tags), and service (operations on checks, kitchen tickets).
 *
 *   GET  /v1/venue                          everything a device needs to work, in one answer (kept for offline)
 *   PUT  /v1/venue/settings                 the switch and the rules
 *   GET|POST /v1/venue/floor, PUT|DELETE /v1/venue/floor/:id      floor plans (area + layout, items with positions)
 *   GET|POST /v1/venue/periods, PUT|DELETE /v1/venue/periods/:id  menus and promotions by the clock
 *   GET|POST /v1/venue/stations, PUT|DELETE /v1/venue/stations/:id
 *   GET|POST /v1/venue/modifier-groups, PUT|DELETE /v1/venue/modifier-groups/:id
 *   PUT  /v1/venue/items/:id                allergens, dietary tags, course, stations, modifier groups
 *   POST /v1/venue/items/:id/availability   sold out ("86"), or how many are left
 *   POST /v1/venue/waste                    waste and spillage, off the stock with a reason
 *   GET|PUT /v1/venue/sections              who looks after which tables today
 *   POST /v1/venue/approve                  a supervisor's PIN, for what needs one
 *   POST /v1/venue/ops                      operations on checks (src/venue/check.ts), applied in order
 *   GET  /v1/venue/changes?since=           checks, tickets and sold-out items changed since then
 *   GET  /v1/venue/checks/:id               one check with its log
 *   POST /v1/venue/tickets/:id/:what        printed | failed | retry | reroute | bump | recall
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { atLimit, countHit } from '../db/ratelimit.ts';
import { checkPin } from '../db/users.ts';
import { moveStock, StockError } from '../inventory/stock.ts';
import { stockLocation } from '../inventory/locations.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { Check } from '../venue/check.ts';
import { applyOps, changesSince, loadMenu, loadModifierGroups, loadPeriods, loadStations, type OpInput, touchTicket } from '../venue/service.ts';
import { businessDate, loadVenue, saveVenue, venueOn, type VenueSettings } from '../venue/settings.ts';
import { taxRules } from '../venue/tax-rules.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission, type Role } from './permissions.ts';
import { uuid } from './schemas.ts';

export const ALLERGENS = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'tree nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'molluscs', 'lupin'] as const;
export const DIETARY = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'halal', 'kosher', 'spicy'] as const;

const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' }) as const;
const unique = (e: unknown, message: string) => { if (/unique|duplicate/i.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', message); throw e; };

/** A floor plan's items, made safe: tables, stools, walls and fixtures with a place on a 0-1000 grid. */
function floorItems(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const seen = new Set<string>();
  return raw.slice(0, 300).flatMap((r) => {
    const x = r as Record<string, unknown>;
    const id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) ? x.id : '';
    const type = x.type === 'stool' || x.type === 'wall' || x.type === 'fixture' ? x.type : 'table';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 30) : '';
    if ((type === 'table' || type === 'stool') && !name) return [];
    return [{
      id, type, name, shape: x.shape === 'round' || x.shape === 'rect' ? x.shape : 'square',
      seats: type === 'table' ? n(x.seats, 1, 40, 4) : type === 'stool' ? 1 : 0,
      x: n(x.x, 0, 1000, 100), y: n(x.y, 0, 1000, 100), w: n(x.w, 20, 1000, 100), h: n(x.h, 10, 1000, 100), rotation: n(x.rotation, 0, 359, 0),
    }];
  });
}

export function registerVenueRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const setup = (request: FastifyRequest) => requirePermission(request, 'business.manage');
  const menuSetup = (request: FastifyRequest) => requirePermission(request, 'catalog.manage');
  const service = (request: FastifyRequest) => {
    if (!can(request.principal, 'venue.orders') && !can(request.principal, 'venue.kitchen') && !can(request.principal, 'venue.floor') && !can(request.principal, 'hotel.frontdesk') && !can(request.principal, 'hotel.housekeeping')) requirePermission(request, 'venue.orders');
  };
  const on = async (tenantId: string): Promise<VenueSettings> => {
    const v = await loadVenue(db, tenantId);
    if (!venueOn(v)) throw new ApiError(409, 'venue_off', 'Turn on Restaurant, Bar or Hotel under Settings first');
    return v;
  };

  const floorJson = async (tenantId: string) => (await db.query<{ id: string; area: string; layout: string; position: number; items: unknown[] }>(
    'select id, area, layout, position, items from venue_floor_plans where tenant_id = $1 order by position, lower(area), lower(layout)', [tenantId],
  )).rows;

  // ---------- everything a device needs ----------
  app.get('/venue', async (request) => {
    service(request);
    const venue = await loadVenue(db, request.tenantId);
    if (!venueOn(venue)) return { venue, on: false };
    const stations = await loadStations(db, request.tenantId);
    const staff = (await db.query<{ id: string; name: string; role: Role }>("select id, name, role from users where tenant_id = $1 and status = 'active' order by lower(name)", [request.tenantId])).rows;
    const now = deps.now?.() ?? new Date();
    return {
      on: true, venue, now: now.toISOString(), businessDate: businessDate(now, venue.dayEndsHour),
      taxes: await taxRules(db, request.tenantId, now),
      floor: await floorJson(request.tenantId),
      periods: await loadPeriods(db, request.tenantId),
      stations,
      modifierGroups: await loadModifierGroups(db, request.tenantId),
      items: await loadMenu(db, request.tenantId, stations),
      staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, orders: can(s.role, 'venue.orders'), approves: can(s.role, 'venue.approve') })),
      sections: (await db.query<{ user_id: string; table_ids: string[] }>('select user_id, table_ids from venue_sections where tenant_id = $1 and business_date = $2', [request.tenantId, businessDate(now, venue.dayEndsHour)])).rows.map((r) => ({ userId: r.user_id, tableIds: r.table_ids })),
      allergens: ALLERGENS, dietary: DIETARY,
      me: { id: request.userId, deviceId: request.posDevice?.id ?? null, orders: can(request.principal, 'venue.orders'), approves: can(request.principal, 'venue.approve'), kitchen: can(request.principal, 'venue.kitchen'), floor: can(request.principal, 'venue.floor') },
    };
  });

  app.put<{ Body: Partial<VenueSettings> }>('/venue/settings', { schema: { body: { type: 'object' } } }, async (request) => {
    setup(request);
    const before = await loadVenue(db, request.tenantId);
    const b = request.body as Record<string, unknown>;
    // The hotel's date is the night audit's to move.
    delete b.hotelDate;
    delete b.closedThrough;
    const next = await saveVenue(db, request.tenantId, b);
    if (venueOn(next) !== venueOn(before) || next.restaurant !== before.restaurant || next.bar !== before.bar || next.hotel !== before.hotel) {
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'venue.kinds', details: { restaurant: next.restaurant, bar: next.bar, hotel: next.hotel }, ip: request.ip });
    }
    return next;
  });

  // ---------- floor plans ----------
  app.get('/venue/floor', async (request) => { service(request); return { data: await floorJson(request.tenantId) }; });
  app.post<{ Body: { area: string; layout?: string; items?: unknown[]; copyFrom?: string } }>(
    '/venue/floor',
    { schema: { body: { type: 'object', required: ['area'], additionalProperties: false, properties: { area: text(40), layout: text(40), items: { type: 'array', maxItems: 300 }, copyFrom: uuid } } } },
    async (request, reply) => {
      setup(request);
      const b = request.body;
      const id = randomUUID();
      // A new layout of an area starts as a copy of another, with the same tables.
      const from = b.copyFrom ? (await db.query<{ items: unknown[] }>('select items from venue_floor_plans where id = $1 and tenant_id = $2', [b.copyFrom, request.tenantId])).rows[0] : undefined;
      const position = Number((await db.query<{ n: unknown }>('select coalesce(max(position), -1) + 1 as n from venue_floor_plans where tenant_id = $1', [request.tenantId])).rows[0]!.n);
      try {
        await db.query('insert into venue_floor_plans (id, tenant_id, area, layout, position, items, updated_by) values ($1, $2, $3, $4, $5, $6, $7)',
          [id, request.tenantId, b.area.trim(), b.layout?.trim() || 'Standard', position, JSON.stringify(floorItems(b.items ?? from?.items ?? [])), request.userId || null]);
      } catch (e) { unique(e, 'That area already has a layout with that name'); }
      return reply.code(201).send({ id, data: await floorJson(request.tenantId) });
    },
  );
  app.put<{ Params: { id: string }; Body: { area?: string; layout?: string; items?: unknown[] } }>(
    '/venue/floor/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { area: text(40), layout: text(40), items: { type: 'array', maxItems: 300 } } } } },
    async (request) => {
      setup(request);
      const b = request.body;
      try {
        const r = await db.query(
          'update venue_floor_plans set area = coalesce($3, area), layout = coalesce($4, layout), items = coalesce($5::jsonb, items), updated_at = now(), updated_by = $6 where id = $1 and tenant_id = $2 returning id',
          [request.params.id, request.tenantId, b.area?.trim() ?? null, b.layout?.trim() ?? null, b.items ? JSON.stringify(floorItems(b.items)) : null, request.userId || null],
        );
        if (!r.rows.length) throw notFound('Floor plan');
      } catch (e) { unique(e, 'That area already has a layout with that name'); }
      return { data: await floorJson(request.tenantId) };
    },
  );
  app.delete<{ Params: { id: string } }>('/venue/floor/:id', { schema: { params: idParams } }, async (request) => {
    setup(request);
    const plan = (await db.query<{ items: Array<{ id: string }> }>('select items from venue_floor_plans where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!plan) throw notFound('Floor plan');
    const busy = (await db.query("select 1 from venue_checks where tenant_id = $1 and status in ('open', 'paid') and table_id = any($2::text[]) limit 1", [request.tenantId, plan.items.map((i) => i.id)])).rows.length;
    if (busy) throw new ApiError(409, 'tables_open', 'A table on this plan has a party. Close or move it first.');
    await db.query('delete from venue_floor_plans where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await floorJson(request.tenantId) };
  });

  // ---------- periods: menus and promotions ----------
  const periodBody = {
    type: 'object', required: ['kind', 'name', 'startsMin', 'endsMin'], additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['menu', 'promotion'] }, name: text(60),
      days: { type: 'array', maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } },
      startsMin: { type: 'integer', minimum: 0, maximum: 1439 }, endsMin: { type: 'integer', minimum: 0, maximum: 1439 },
      categories: { type: 'array', maxItems: 100, items: text(80) },
      prices: { type: 'object', additionalProperties: { type: 'integer', minimum: 0, maximum: 100000000 } },
      rules: { type: 'array', maxItems: 20, items: { type: 'object' } },
      active: { type: 'boolean' }, position: { type: 'integer', minimum: 0, maximum: 1000 },
    },
  } as const;
  type PeriodBody = { kind: 'menu' | 'promotion'; name: string; days?: number[]; startsMin: number; endsMin: number; categories?: string[]; prices?: Record<string, number>; rules?: unknown[]; active?: boolean; position?: number };
  const rulesOf = (raw: unknown[] | undefined): unknown[] => (raw ?? []).flatMap((r): unknown[] => {
    const x = r as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 100) : []);
    const cents = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
    if (x.kind === 'percent' && typeof x.percent === 'number' && x.percent > 0 && x.percent <= 100) return [{ kind: 'percent', percent: x.percent, categories: list(x.categories), itemIds: list(x.itemIds) }];
    if (x.kind === 'price' && typeof x.itemId === 'string' && cents(x.priceCents) !== null) return [{ kind: 'price', itemId: x.itemId, priceCents: cents(x.priceCents) }];
    if (x.kind === 'twoForOne') return [{ kind: 'twoForOne', categories: list(x.categories), itemIds: list(x.itemIds) }];
    if (x.kind === 'bundle' && list(x.itemIds).length >= 2 && cents(x.priceCents) !== null) return [{ kind: 'bundle', name: typeof x.name === 'string' ? x.name.trim().slice(0, 60) : '', itemIds: list(x.itemIds).slice(0, 8), priceCents: cents(x.priceCents) }];
    return [];
  });
  app.get('/venue/periods', async (request) => { service(request); return { data: await loadPeriods(db, request.tenantId) }; });
  app.post<{ Body: PeriodBody }>('/venue/periods', { schema: { body: periodBody } }, async (request, reply) => {
    menuSetup(request);
    const b = request.body;
    const id = randomUUID();
    await db.query('insert into venue_periods (id, tenant_id, kind, name, days, starts_min, ends_min, categories, prices, rules, active, position) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [id, request.tenantId, b.kind, b.name.trim(), b.days ?? [0, 1, 2, 3, 4, 5, 6], b.startsMin, b.endsMin, b.categories ?? [], JSON.stringify(b.prices ?? {}), JSON.stringify(rulesOf(b.rules)), b.active ?? true, b.position ?? 0]);
    return reply.code(201).send({ id, data: await loadPeriods(db, request.tenantId) });
  });
  app.put<{ Params: { id: string }; Body: PeriodBody }>('/venue/periods/:id', { schema: { params: idParams, body: periodBody } }, async (request) => {
    menuSetup(request);
    const b = request.body;
    const r = await db.query('update venue_periods set kind = $3, name = $4, days = $5, starts_min = $6, ends_min = $7, categories = $8, prices = $9, rules = $10, active = $11, position = $12 where id = $1 and tenant_id = $2 returning id',
      [request.params.id, request.tenantId, b.kind, b.name.trim(), b.days ?? [0, 1, 2, 3, 4, 5, 6], b.startsMin, b.endsMin, b.categories ?? [], JSON.stringify(b.prices ?? {}), JSON.stringify(rulesOf(b.rules)), b.active ?? true, b.position ?? 0]);
    if (!r.rows.length) throw notFound('Period');
    return { data: await loadPeriods(db, request.tenantId) };
  });
  app.delete<{ Params: { id: string } }>('/venue/periods/:id', { schema: { params: idParams } }, async (request) => {
    menuSetup(request);
    await db.query('delete from venue_periods where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await loadPeriods(db, request.tenantId) };
  });
  // A manager's override of the menu by the clock, until the business day ends.
  app.post<{ Body: { periodId: string | null } }>('/venue/menu-override', { schema: { body: { type: 'object', required: ['periodId'], additionalProperties: false, properties: { periodId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (request) => {
    requirePermission(request, 'venue.approve');
    const v = await loadVenue(db, request.tenantId);
    const today = businessDate(deps.now?.() ?? new Date(), v.dayEndsHour);
    const next = await saveVenue(db, request.tenantId, { menuOverride: request.body.periodId ? { periodId: request.body.periodId, businessDate: today } : null });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'venue.menu_override', details: { periodId: request.body.periodId }, ip: request.ip });
    return next;
  });

  // ---------- stations ----------
  const stationBody = {
    type: 'object', required: ['name'], additionalProperties: false,
    properties: { name: text(40), categories: { type: 'array', maxItems: 100, items: text(80) }, deviceId: { anyOf: [uuid, { type: 'null' }] }, screen: { type: 'boolean' }, fallbackId: { anyOf: [uuid, { type: 'null' }] }, targetMin: { type: 'integer', minimum: 1, maximum: 240 }, position: { type: 'integer', minimum: 0, maximum: 100 } },
  } as const;
  type StationBody = { name: string; categories?: string[]; deviceId?: string | null; screen?: boolean; fallbackId?: string | null; targetMin?: number; position?: number };
  const stationRefs = async (tenantId: string, b: StationBody, self?: string) => {
    if (b.deviceId && !(await db.query('select 1 from pos_devices where id = $1 and tenant_id = $2', [b.deviceId, tenantId])).rows.length) throw new ApiError(422, 'invalid_station', 'That till is not one of yours');
    if (b.fallbackId && (b.fallbackId === self || !(await db.query('select 1 from venue_stations where id = $1 and tenant_id = $2 and archived_at is null', [b.fallbackId, tenantId])).rows.length)) throw new ApiError(422, 'invalid_station', 'Choose another station as the fallback');
  };
  app.get('/venue/stations', async (request) => { service(request); return { data: await loadStations(db, request.tenantId) }; });
  app.post<{ Body: StationBody }>('/venue/stations', { schema: { body: stationBody } }, async (request, reply) => {
    setup(request);
    const b = request.body;
    await stationRefs(request.tenantId, b);
    const id = randomUUID();
    try {
      await db.query('insert into venue_stations (id, tenant_id, name, categories, device_id, screen, fallback_id, target_min, position) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, request.tenantId, b.name.trim(), b.categories ?? [], b.deviceId ?? null, b.screen ?? false, b.fallbackId ?? null, b.targetMin ?? 12, b.position ?? 0]);
    } catch (e) { unique(e, 'There is already a station with that name'); }
    return reply.code(201).send({ id, data: await loadStations(db, request.tenantId) });
  });
  app.put<{ Params: { id: string }; Body: StationBody }>('/venue/stations/:id', { schema: { params: idParams, body: stationBody } }, async (request) => {
    setup(request);
    const b = request.body;
    await stationRefs(request.tenantId, b, request.params.id);
    try {
      const r = await db.query('update venue_stations set name = $3, categories = $4, device_id = $5, screen = $6, fallback_id = $7, target_min = $8, position = $9 where id = $1 and tenant_id = $2 and archived_at is null returning id',
        [request.params.id, request.tenantId, b.name.trim(), b.categories ?? [], b.deviceId ?? null, b.screen ?? false, b.fallbackId ?? null, b.targetMin ?? 12, b.position ?? 0]);
      if (!r.rows.length) throw notFound('Station');
    } catch (e) { unique(e, 'There is already a station with that name'); }
    return { data: await loadStations(db, request.tenantId) };
  });
  app.delete<{ Params: { id: string } }>('/venue/stations/:id', { schema: { params: idParams } }, async (request) => {
    setup(request);
    await db.query('update venue_stations set archived_at = now() where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    await db.query('update venue_stations set fallback_id = null where fallback_id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await loadStations(db, request.tenantId) };
  });

  // ---------- modifiers ----------
  const groupBody = {
    type: 'object', required: ['name', 'options'], additionalProperties: false,
    properties: {
      name: text(60), minChoices: { type: 'integer', minimum: 0, maximum: 20 }, maxChoices: { type: 'integer', minimum: 1, maximum: 20 }, position: { type: 'integer', minimum: 0, maximum: 1000 },
      options: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', required: ['name'], additionalProperties: false, properties: { id: uuid, name: text(60), priceCents: { type: 'integer', minimum: -10000000, maximum: 10000000 }, isDefault: { type: 'boolean' }, itemId: { anyOf: [uuid, { type: 'null' }] } } } },
    },
  } as const;
  type GroupBody = { name: string; minChoices?: number; maxChoices?: number; position?: number; options: Array<{ id?: string; name: string; priceCents?: number; isDefault?: boolean; itemId?: string | null }> };
  const saveGroup = async (tenantId: string, id: string, b: GroupBody, isNew: boolean) => {
    const min = b.minChoices ?? 0;
    const max = b.maxChoices ?? 1;
    if (min > max) throw new ApiError(422, 'invalid_modifiers', 'At least cannot be more than at most');
    if (min > b.options.length) throw new ApiError(422, 'invalid_modifiers', 'There are fewer choices than the group requires');
    if (b.options.filter((o) => o.isDefault).length > max) throw new ApiError(422, 'invalid_modifiers', 'More defaults than the group allows');
    const stock = b.options.map((o) => o.itemId).filter((x): x is string => Boolean(x));
    if (stock.length && (await db.query('select 1 from items where tenant_id = $1 and id = any($2::uuid[])', [tenantId, stock])).rows.length !== new Set(stock).size) throw new ApiError(422, 'invalid_modifiers', 'A choice names an item that is not in your catalog');
    await db.transaction(async (tx) => {
      if (isNew) await tx.query('insert into modifier_groups (id, tenant_id, name, min_choices, max_choices, position) values ($1, $2, $3, $4, $5, $6)', [id, tenantId, b.name.trim(), min, max, b.position ?? 0]);
      else if (!(await tx.query('update modifier_groups set name = $3, min_choices = $4, max_choices = $5, position = $6 where id = $1 and tenant_id = $2 and archived_at is null returning id', [id, tenantId, b.name.trim(), min, max, b.position ?? 0])).rows.length) throw notFound('Modifier group');
      // Choices keep their ids (checks already ordered refer to them); the ones left out are retired.
      const keep: string[] = [];
      for (const [n, o] of b.options.entries()) {
        const existing = o.id ? (await tx.query('update modifiers set name = $3, price_cents = $4, is_default = $5, item_id = $6, position = $7, archived_at = null where id = $1 and group_id = $2 returning id', [o.id, id, o.name.trim(), o.priceCents ?? 0, o.isDefault ?? false, o.itemId ?? null, n])).rows.length : 0;
        const optionId = existing ? o.id! : randomUUID();
        if (!existing) await tx.query('insert into modifiers (id, group_id, tenant_id, name, price_cents, is_default, item_id, position) values ($1, $2, $3, $4, $5, $6, $7, $8)', [optionId, id, tenantId, o.name.trim(), o.priceCents ?? 0, o.isDefault ?? false, o.itemId ?? null, n]);
        keep.push(optionId);
      }
      await tx.query('update modifiers set archived_at = now() where group_id = $1 and archived_at is null and not (id = any($2::uuid[]))', [id, keep]);
    });
  };
  app.get('/venue/modifier-groups', async (request) => { service(request); return { data: await loadModifierGroups(db, request.tenantId) }; });
  app.post<{ Body: GroupBody }>('/venue/modifier-groups', { schema: { body: groupBody } }, async (request, reply) => {
    menuSetup(request);
    const id = randomUUID();
    await saveGroup(request.tenantId, id, request.body, true);
    return reply.code(201).send({ id, data: await loadModifierGroups(db, request.tenantId) });
  });
  app.put<{ Params: { id: string }; Body: GroupBody }>('/venue/modifier-groups/:id', { schema: { params: idParams, body: groupBody } }, async (request) => {
    menuSetup(request);
    await saveGroup(request.tenantId, request.params.id, request.body, false);
    return { data: await loadModifierGroups(db, request.tenantId) };
  });
  app.delete<{ Params: { id: string } }>('/venue/modifier-groups/:id', { schema: { params: idParams } }, async (request) => {
    menuSetup(request);
    await db.query('update modifier_groups set archived_at = now() where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    await db.query('delete from item_modifier_groups g using modifier_groups m where g.group_id = m.id and m.id = $1 and m.tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await loadModifierGroups(db, request.tenantId) };
  });

  // ---------- an item on the menu ----------
  const oneItem = async (tenantId: string, id: string) => (await loadMenu(db, tenantId, await loadStations(db, tenantId), [id]))[0];
  app.put<{ Params: { id: string }; Body: { allergens?: string[]; dietary?: string[]; course?: number | null; stationIds?: string[] | null; modifierGroupIds?: string[] } }>(
    '/venue/items/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            allergens: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', enum: [...ALLERGENS] } },
            dietary: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', enum: [...DIETARY] } },
            course: { anyOf: [{ type: 'integer', minimum: 0, maximum: 3 }, { type: 'null' }] },
            stationIds: { anyOf: [{ type: 'array', maxItems: 6, uniqueItems: true, items: uuid }, { type: 'null' }] },
            modifierGroupIds: { type: 'array', maxItems: 12, uniqueItems: true, items: uuid },
          },
        },
      },
    },
    async (request) => {
      menuSetup(request);
      const b = request.body;
      const item = (await db.query('select 1 from items where id = $1 and tenant_id = $2 and archived_at is null', [request.params.id, request.tenantId])).rows[0];
      if (!item) throw notFound('Item');
      if (b.allergens) await db.query('update items set allergens = $2 where id = $1', [request.params.id, b.allergens]);
      if (b.dietary) await db.query('update items set dietary = $2 where id = $1', [request.params.id, b.dietary]);
      if (b.course !== undefined) await db.query('update items set course = $2 where id = $1', [request.params.id, b.course]);
      if (b.stationIds !== undefined) await db.query('update items set station_ids = $2 where id = $1', [request.params.id, b.stationIds?.length ? b.stationIds : null]);
      if (b.modifierGroupIds) {
        const ok = (await db.query<{ id: string }>('select id from modifier_groups where tenant_id = $1 and archived_at is null and id = any($2::uuid[])', [request.tenantId, b.modifierGroupIds])).rows.map((r) => r.id);
        await db.transaction(async (tx) => {
          await tx.query('delete from item_modifier_groups where item_id = $1', [request.params.id]);
          for (const [n, g] of b.modifierGroupIds!.filter((x) => ok.includes(x)).entries()) await tx.query('insert into item_modifier_groups (item_id, group_id, position) values ($1, $2, $3)', [request.params.id, g, n]);
        });
      }
      return oneItem(request.tenantId, request.params.id);
    },
  );
  // "86": one tap by anyone who takes orders or runs the kitchen. Every device hears within its next poll.
  app.post<{ Params: { id: string }; Body: { soldOut?: boolean; remaining?: number | null } }>(
    '/venue/items/:id/availability',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { soldOut: { type: 'boolean' }, remaining: { anyOf: [{ type: 'integer', minimum: 0, maximum: 100000 }, { type: 'null' }] } } } } },
    async (request) => {
      if (!can(request.principal, 'venue.kitchen')) requirePermission(request, 'venue.orders');
      const b = request.body;
      const remaining = b.remaining === undefined ? undefined : b.remaining;
      const r = await db.query<{ name: string }>(
        `update items set sold_out = case when $4::boolean then $3::integer = 0 else coalesce($5::boolean, sold_out) end, remaining = case when $4::boolean then $3::integer else case when $5::boolean is false then null else remaining end end
         where id = $1 and tenant_id = $2 and archived_at is null returning name`,
        [request.params.id, request.tenantId, remaining ?? null, remaining !== undefined, b.soldOut ?? null],
      );
      if (!r.rows.length) throw notFound('Item');
      await db.query('update tenants set venue_seq = venue_seq + 1 where id = $1', [request.tenantId]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'venue.availability', target: r.rows[0]!.name, details: { soldOut: b.soldOut ?? null, remaining: remaining ?? null }, ip: request.ip });
      return oneItem(request.tenantId, request.params.id);
    },
  );

  app.post<{ Body: { itemId: string; quantity: string; reason: 'waste' | 'spillage'; note: string; locationId?: string } }>(
    '/venue/waste',
    { schema: { body: { type: 'object', required: ['itemId', 'quantity', 'reason', 'note'], additionalProperties: false, properties: { itemId: uuid, quantity: { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,3})?$' }, reason: { type: 'string', enum: ['waste', 'spillage'] }, note: text(200), locationId: uuid } } } },
    async (request) => {
      if (!can(request.principal, 'venue.kitchen')) requirePermission(request, 'venue.orders');
      const b = request.body;
      if (Number(b.quantity) <= 0) throw new ApiError(422, 'invalid_stock', 'How much was wasted?');
      const item = (await db.query<{ name: string; tracked: boolean }>('select name, stock_quantity is not null as tracked from items where id = $1 and tenant_id = $2 and archived_at is null', [b.itemId, request.tenantId])).rows[0];
      if (!item) throw notFound('Item');
      if (!item.tracked) throw new ApiError(409, 'not_tracked', `${item.name}: its stock is not tracked`);
      try {
        const locationId = await stockLocation(db, request.tenantId, b.locationId);
        const done = await moveStock(db, { tenantId: request.tenantId, itemId: b.itemId, quantity: `-${b.quantity}`, reason: b.reason, note: b.note, userId: request.userId || null, locationId });
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `stock.${b.reason}`, target: item.name, details: { quantity: b.quantity, note: b.note }, ip: request.ip });
        return { itemId: b.itemId, stock: done ? Number(done.balance) : null };
      } catch (e) {
        if (e instanceof StockError) throw new ApiError(422, 'invalid_stock', e.message);
        throw e;
      }
    },
  );

  // ---------- sections ----------
  app.put<{ Body: { sections: Array<{ userId: string; tableIds: string[] }> } }>(
    '/venue/sections',
    { schema: { body: { type: 'object', required: ['sections'], additionalProperties: false, properties: { sections: { type: 'array', maxItems: 60, items: { type: 'object', required: ['userId', 'tableIds'], additionalProperties: false, properties: { userId: uuid, tableIds: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 40 } } } } } } } } },
    async (request) => {
      if (!can(request.principal, 'venue.floor')) requirePermission(request, 'venue.approve');
      const v = await loadVenue(db, request.tenantId);
      const day = businessDate(deps.now?.() ?? new Date(), v.dayEndsHour);
      const staff = (await db.query<{ id: string }>("select id from users where tenant_id = $1 and status = 'active'", [request.tenantId])).rows.map((r) => r.id);
      await db.transaction(async (tx) => {
        await tx.query('delete from venue_sections where tenant_id = $1 and business_date = $2', [request.tenantId, day]);
        for (const s of request.body.sections.filter((x) => staff.includes(x.userId) && x.tableIds.length)) {
          await tx.query('insert into venue_sections (tenant_id, business_date, user_id, table_ids) values ($1, $2, $3, $4) on conflict do nothing', [request.tenantId, day, s.userId, s.tableIds]);
        }
      });
      return { businessDate: day, sections: request.body.sections };
    },
  );

  // ---------- a supervisor's PIN ----------
  app.post<{ Body: { pin: string } }>('/venue/approve', { schema: { body: { type: 'object', required: ['pin'], additionalProperties: false, properties: { pin: { type: 'string', minLength: 4, maxLength: 12 } } } } }, async (request) => {
    service(request);
    const key = `venue-approve|${request.tenantId}|${request.userId}`;
    if (await atLimit(db, key, 6)) throw new ApiError(429, 'too_many_attempts', 'Too many wrong PINs. Try again in 15 minutes.');
    const supervisors = (await db.query<{ id: string; role: Role }>("select id, role from users where tenant_id = $1 and status = 'active' and pos_pin_hash is not null", [request.tenantId])).rows.filter((u) => can(u.role, 'venue.approve'));
    for (const s of supervisors.slice(0, 40)) {
      const user = await checkPin(db, request.tenantId, s.id, request.body.pin);
      if (user) return { id: user.id, name: user.name };
    }
    await countHit(db, key, 15 * 60_000);
    throw new ApiError(401, 'wrong_pin', 'That is not a supervisor’s PIN');
  });

  // ---------- operations ----------
  app.post<{ Body: { ops: OpInput[] } }>(
    '/venue/ops',
    {
      schema: {
        body: {
          type: 'object', required: ['ops'], additionalProperties: false,
          properties: { ops: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['id', 'checkId', 'type', 'at'], additionalProperties: false, properties: { id: uuid, checkId: uuid, type: { type: 'string', maxLength: 20 }, at: { type: 'string', maxLength: 40 }, payload: { type: 'object' } } } } },
        },
      },
    },
    async (request) => {
      service(request);
      await on(request.tenantId);
      if (!request.userId) throw new ApiError(403, 'forbidden', 'Orders are taken by people, not API keys');
      const me = (await db.query<{ name: string }>('select name from users where id = $1', [request.userId])).rows[0]!;
      const role = request.principal as Role;
      return applyOps(db, request.tenantId, {
        userId: request.userId, name: me.name, deviceId: request.posDevice?.id ?? null,
        mayApprove: can(role, 'venue.approve'), mayOrder: can(role, 'venue.orders'), mayKitchen: can(role, 'venue.kitchen'),
      }, request.body.ops.map((o) => ({ ...o, payload: o.payload ?? {} })), { ...(deps.now && { now: deps.now() }), approvers: (r) => can(r as Role, 'venue.approve') });
    },
  );

  app.get<{ Querystring: { since?: string } }>('/venue/changes', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', pattern: '^\\d{1,15}$' } } } } }, async (request) => {
    service(request);
    return changesSince(db, request.tenantId, Number(request.query.since ?? 0));
  });

  app.get<{ Params: { id: string } }>('/venue/checks/:id', { schema: { params: idParams } }, async (request) => {
    service(request);
    const row = (await db.query<{ number: number; state: Check }>('select number, state from venue_checks where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!row) throw notFound('Check');
    return { ...row.state, number: row.number };
  });

  // ---------- tickets ----------
  app.post<{ Params: { id: string; what: string }; Body: { error?: string } | undefined }>(
    '/venue/tickets/:id/:what',
    { schema: { params: { type: 'object', required: ['id', 'what'], properties: { id: uuid, what: { type: 'string', enum: ['printed', 'failed', 'retry', 'reroute', 'bump', 'recall'] } } }, body: { type: ['object', 'null'], additionalProperties: false, properties: { error: { type: 'string', maxLength: 300 } } } } },
    async (request) => {
      service(request);
      const { id, what } = request.params;
      const t = (await db.query<{ station_id: string; status: string; check_id: string; body: { items: Array<{ id: string }> }; fallback_id: string | null }>(
        'select k.station_id, k.status, k.check_id, k.body, s.fallback_id from venue_tickets k join venue_stations s on s.id = k.station_id where k.id = $1 and k.tenant_id = $2', [id, request.tenantId],
      )).rows[0];
      if (!t) throw notFound('Ticket');
      let ticket;
      if (what === 'printed') ticket = await touchTicket(db, request.tenantId, id, "status = 'printed', printed_at = now(), attempts = k.attempts + 1, error = null", []);
      else if (what === 'failed') ticket = await touchTicket(db, request.tenantId, id, "status = 'failed', attempts = k.attempts + 1, error = $4", [request.body?.error?.trim() || 'The printer did not answer']);
      else if (what === 'retry') ticket = await touchTicket(db, request.tenantId, id, "status = 'queued', error = null", []);
      else if (what === 'reroute') {
        // To the fallback station's printer; with none, to the till of whoever asks.
        ticket = t.fallback_id
          ? await touchTicket(db, request.tenantId, id, "station_id = $4, status = 'queued', error = null", [t.fallback_id])
          : await touchTicket(db, request.tenantId, id, "origin_device_id = $4, status = 'queued', error = 'here'", [request.posDevice?.id ?? null]);
      } else if (what === 'bump') {
        ticket = await touchTicket(db, request.tenantId, id, 'bumped_at = now(), bumped_by = $4', [request.userId || null]);
        // Done in the kitchen: the floor is told its items are ready.
        if (request.userId) {
          const me = (await db.query<{ name: string }>('select name from users where id = $1', [request.userId])).rows[0]!;
          await applyOps(db, request.tenantId, { userId: request.userId, name: me.name, deviceId: request.posDevice?.id ?? null, mayApprove: false, mayOrder: false, mayKitchen: true },
            [{ id: randomUUID(), checkId: t.check_id, type: 'ready', at: new Date().toISOString(), payload: { itemIds: t.body.items.map((i) => i.id) } }], { approvers: () => false });
        }
      } else ticket = await touchTicket(db, request.tenantId, id, 'bumped_at = null, bumped_by = null', []);
      return ticket;
    },
  );
}
