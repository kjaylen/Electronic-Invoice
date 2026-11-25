/**
 * The hotel: room types and rates, rooms, bookings, the front desk, folios,
 * housekeeping and the night audit.
 *
 *   GET|POST /v1/hotel/room-types, PUT|DELETE /v1/hotel/room-types/:id     with seasons
 *   GET|POST /v1/hotel/rooms, PUT|DELETE /v1/hotel/rooms/:id
 *   GET  /v1/hotel/calendar?from&to          rooms against dates, with the bookings on them
 *   GET  /v1/hotel/availability?arrival&departure   free rooms by type, and the rate for the stay
 *   POST /v1/hotel/bookings                  PUT /v1/hotel/bookings/:id (dates, room, details)
 *   GET  /v1/hotel/bookings/:id              with its folios, lines and balance
 *   POST /v1/hotel/bookings/:id/deposit | check-in | move | extras | folios | payments | invoice | check-out | cancel | no-show
 *   PUT  /v1/hotel/folio-lines/:id           move a line to another folio
 *   GET  /v1/hotel/front-desk                arrivals, departures and in-house for the hotel's day
 *   GET  /v1/hotel/in-house?room=            who is in a room (the till confirms the guest before charging)
 *   GET  /v1/hotel/housekeeping              POST /v1/hotel/rooms/:id/status, PUT /v1/hotel/tasks/:id
 *   POST /v1/hotel/night-audit               GET /v1/hotel/audits
 *
 * Which tax document is issued when is in ETD-MAPPING.md; rates and taxes
 * come from dated configuration (src/venue/tax-rules.ts).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Database, Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { receivable, recordPayment, ReceivableError, type PaymentMethod } from '../receivables/receivables.ts';
import { percentCents } from '../venue/bill.ts';
import { loadVenue, saveVenue, type VenueSettings } from '../venue/settings.ts';
import { taxRules, type TaxValues } from '../venue/tax-rules.ts';
import { issueFromBody } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const money = (cents: number | bigint) => formatCents(BigInt(cents));
const day = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T12:00:00Z`);
const addDays = (s: string, n: number) => day(new Date(utc(s).getTime() + n * 86_400_000));
/** The nights of a stay: every date from arrival up to, not including, departure. */
export const nightsOf = (arrival: string, departure: string) => { const out: string[] = []; for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d); return out; };
const belizeToday = (now = new Date()) => day(new Date(now.getTime() - 6 * 3600_000));
const METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'] as const;

interface TypeRow { id: string; name: string; capacity: number; rate_cents: unknown; weekend_rate_cents: unknown; usd: boolean; min_stay: number; features: string[] }
interface SeasonRow { id: string; room_type_id: string; name: string; starts_on: string; ends_on: string; rate_cents: unknown; weekend_rate_cents: unknown; min_stay: number | null }
interface BookingRow {
  id: string; number: number; status: 'booked' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show'; guest_name: string; phone: string | null; email: string | null; guest_id: string | null; customer_id: string | null;
  room_type_id: string; room_id: string | null; arrival: string; departure: string; adults: number; children: number; source: string; nightly: Array<{ date: string; cents: number }>;
  policy: string | null; group_name: string | null; notes: string | null; checked_in_at: Date | string | null; checked_out_at: Date | string | null; room_name: string | null; type_name: string;
}
const BOOKING = `b.id, b.number, b.status, b.guest_name, b.phone, b.email, b.guest_id, b.customer_id, b.room_type_id, b.room_id, b.arrival::text as arrival, b.departure::text as departure, b.adults, b.children,
  b.source, b.nightly, b.policy, b.group_name, b.notes, b.checked_in_at, b.checked_out_at, r.name as room_name, t.name as type_name`;
const BOOKING_FROM = 'hotel_bookings b join hotel_room_types t on t.id = b.room_type_id left join hotel_rooms r on r.id = b.room_id';
export const bookingNumber = (n: number) => `H-${String(n).padStart(4, '0')}`;
const bookingJson = (b: BookingRow) => ({
  id: b.id, number: bookingNumber(b.number), status: b.status, guest: { name: b.guest_name, phone: b.phone, email: b.email, id: b.guest_id }, roomType: { id: b.room_type_id, name: b.type_name },
  room: b.room_id ? { id: b.room_id, name: b.room_name } : null, arrival: b.arrival, departure: b.departure, nights: b.nightly.length, adults: b.adults, children: b.children, source: b.source,
  nightly: b.nightly.map((n) => ({ date: n.date, rate: money(n.cents) })), roomTotal: money(b.nightly.reduce((a, n) => a + n.cents, 0)), policy: b.policy, groupName: b.group_name, notes: b.notes,
  checkedInAt: b.checked_in_at ? new Date(b.checked_in_at).toISOString() : null, checkedOutAt: b.checked_out_at ? new Date(b.checked_out_at).toISOString() : null,
});

/** A night's rate in BZ$ cents: the season that covers it (the latest to start), else the type's; weekends (Friday and Saturday nights) their own when set. */
export function nightRate(type: { rate_cents: unknown; weekend_rate_cents: unknown; usd: boolean }, seasons: SeasonRow[], date: string, usdRateCents: number): number {
  const season = seasons.filter((s) => s.starts_on <= date && date <= s.ends_on).sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1))[0];
  const weekend = [5, 6].includes(utc(date).getUTCDay());
  const from = season ?? type;
  const cents = Number(weekend && from.weekend_rate_cents !== null && from.weekend_rate_cents !== undefined ? from.weekend_rate_cents : from.rate_cents);
  return type.usd ? Math.round((cents * usdRateCents) / 100) : cents;
}
export function minStay(type: { min_stay: number }, seasons: SeasonRow[], arrival: string): number {
  const season = seasons.filter((s) => s.starts_on <= arrival && arrival <= s.ends_on && s.min_stay !== null).sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1))[0];
  return season?.min_stay ?? type.min_stay;
}

/** The hotel's own day: moved on by the night audit, so "today's arrivals" stay today's until the audit has run. */
export async function hotelDate(db: Queryable, tenantId: string, venue?: VenueSettings): Promise<string> {
  return (venue ?? await loadVenue(db, tenantId)).hotelDate ?? belizeToday();
}

/** Rooms of a type with no booking over these nights (a booking with no room yet holds one of its type). */
async function freeRooms(db: Queryable, tenantId: string, arrival: string, departure: string, except?: string, prefer?: string | null): Promise<Array<{ id: string; name: string; room_type_id: string; status: string }>> {
  const rooms = (await db.query<{ id: string; name: string; room_type_id: string; status: string }>('select id, name, room_type_id, status from hotel_rooms where tenant_id = $1 and archived_at is null order by name', [tenantId])).rows;
  const taken = (await db.query<{ room_id: string | null; room_type_id: string }>(
    "select room_id, room_type_id from hotel_bookings where tenant_id = $1 and status in ('booked', 'in_house') and arrival < $3::date and departure > $2::date and ($4::uuid is null or id <> $4)", [tenantId, arrival, departure, except ?? null],
  )).rows;
  const busy = new Set(taken.map((t) => t.room_id).filter(Boolean));
  let free = rooms.filter((r) => !busy.has(r.id) && r.status !== 'out_of_order');
  // Each booking without a room takes one free room of its type out of what can be sold.
  // (Which one is not decided yet, so it is never the one being asked for while another will do.)
  for (const t of taken.filter((x) => !x.room_id)) {
    const ofType = free.filter((r) => r.room_type_id === t.room_type_id);
    const give = ofType.find((r) => r.id !== prefer) ?? ofType[0];
    if (give) free = free.filter((r) => r !== give);
  }
  return free;
}

async function loadBooking(db: Queryable, tenantId: string, id: string, lock = false): Promise<BookingRow> {
  const b = (await db.query<BookingRow>(`select ${BOOKING} from ${BOOKING_FROM} where b.id = $1 and b.tenant_id = $2${lock ? ' for update of b' : ''}`, [id, tenantId])).rows[0];
  if (!b) throw notFound('Booking');
  return b;
}

interface LineRow { id: string; folio_id: string; business_date: string; kind: 'room' | 'extra' | 'charge' | 'payment' | 'deposit'; description: string; amount_cents: unknown; document_id: string | null; room_id: string | null; created_at: Date | string }

/** What a line that is not yet on an invoice will come to with its taxes: a room night with the hotel tax, an extra with GST. */
function withTaxes(l: { kind: string; amount_cents: unknown }, tax: TaxValues): number {
  const net = Number(l.amount_cents);
  if (l.kind === 'room') {
    const hotelTax = percentCents(net, tax.hotelTaxPercent);
    return net + hotelTax + (tax.accommodationGst === 'standard' ? percentCents(net + hotelTax, tax.gstPercent) : 0);
  }
  return l.kind === 'extra' ? net + percentCents(net, tax.gstPercent) : net;
}

/** A booking's folios with their lines and what is still owed on each. */
export async function folioJson(db: Queryable, tenantId: string, bookingId: string, tax: TaxValues) {
  const folios = (await db.query<{ id: string; name: string }>('select id, name from hotel_folios where booking_id = $1 and tenant_id = $2 order by position, name', [bookingId, tenantId])).rows;
  const lines = (await db.query<LineRow>('select id, folio_id, business_date::text as business_date, kind, description, amount_cents, document_id, room_id, created_at from hotel_folio_lines where booking_id = $1 and tenant_id = $2 order by business_date, created_at', [bookingId, tenantId])).rows;
  const deposit = (await db.query<{ amount_cents: unknown; status: string; document_id: string }>("select amount_cents, status, document_id from venue_deposits where ref_id = $1 and tenant_id = $2 and kind = 'room' order by created_at", [bookingId, tenantId])).rows;
  const held = deposit.filter((d) => d.status === 'held').reduce((a, d) => a + Number(d.amount_cents), 0);
  const docs = new Map<string, { balance: number; number: string; total: number }>();
  for (const id of new Set(lines.map((l) => l.document_id).filter((x): x is string => Boolean(x)))) {
    const r = await receivable(db, tenantId, id);
    if (r) docs.set(id, { balance: Number(r.balanceCents), number: r.number, total: Math.round(Number(r.total) * 100) });
  }
  const out = folios.map((f) => {
    const mine = lines.filter((l) => l.folio_id === f.id);
    const onDocs = [...new Set(mine.filter((l) => l.kind !== 'payment' && l.kind !== 'deposit').map((l) => l.document_id).filter((x): x is string => Boolean(x)))];
    const toInvoice = mine.filter((l) => (l.kind === 'room' || l.kind === 'extra') && !l.document_id);
    const balance = onDocs.reduce((a, id) => a + (docs.get(id)?.balance ?? 0), 0) + toInvoice.reduce((a, l) => a + withTaxes(l, tax), 0);
    return {
      id: f.id, name: f.name, balance: money(balance), balanceCents: balance,
      lines: mine.map((l) => ({
        id: l.id, date: l.business_date, kind: l.kind, description: l.description, amount: money(Number(l.amount_cents)),
        // With taxes, as the guest will pay it.
        total: l.kind === 'charge' && l.document_id ? money(docs.get(l.document_id)?.total ?? Number(l.amount_cents)) : money(l.kind === 'payment' || l.kind === 'deposit' ? Number(l.amount_cents) : withTaxes(l, tax)),
        document: l.document_id ? { id: l.document_id, number: docs.get(l.document_id)?.number ?? null } : null,
      })),
    };
  });
  const balance = out.reduce((a, f) => a + f.balanceCents, 0);
  return { folios: out, depositHeld: money(held), balance: money(balance - held), balanceCents: balance - held };
}

/** Group a folio's uninvoiced nights into invoice lines: consecutive nights at one rate in one room are one line. */
export function roomLines(nights: Array<{ date: string; cents: number; room: string }>, typeName: string, tax: TaxValues) {
  const groups: Array<{ from: string; to: string; cents: number; room: string; n: number }> = [];
  for (const night of [...nights].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const last = groups[groups.length - 1];
    if (last && last.cents === night.cents && last.room === night.room && addDays(last.to, 1) === night.date) { last.to = night.date; last.n += 1; } else groups.push({ from: night.date, to: night.date, cents: night.cents, room: night.room, n: 1 });
  }
  return groups.map((g) => ({
    description: `Room ${g.room} (${typeName}), ${g.n} night${g.n === 1 ? '' : 's'} from ${g.from}`.slice(0, 200),
    quantity: String(g.n), unitCode: 'DAY', unitPrice: money(g.cents),
    gstCategory: tax.accommodationGst === 'standard' ? 'S' as const : 'E' as const,
    ...(tax.accommodationGst !== 'standard' && { exemptionReasonCode: tax.accommodationExemptionCode }),
    allowanceCharges: [{ isCharge: true, reason: `Hotel tax ${tax.hotelTaxPercent}%`, amount: money(percentCents(g.cents * g.n, tax.hotelTaxPercent)) }],
  }));
}

export function registerHotelRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' }) as const;
  const cents = { type: 'integer', minimum: 0, maximum: 100000000 } as const;
  const amount = { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,2})?$' } as const;
  const setup = (request: FastifyRequest) => requirePermission(request, 'business.manage');
  const desk = (request: FastifyRequest) => requirePermission(request, 'hotel.frontdesk');
  const anyone = (request: FastifyRequest) => { if (!can(request.principal, 'hotel.housekeeping') && !can(request.principal, 'venue.orders')) requirePermission(request, 'hotel.frontdesk'); };
  const hotel = async (tenantId: string) => {
    const v = await loadVenue(db, tenantId);
    if (!v.hotel) throw new ApiError(409, 'hotel_off', 'Turn on Hotel under Settings first');
    return v;
  };
  const toCents = (s: string) => Math.round(Number(s) * 100);
  const unique = (e: unknown, message: string) => { if (/unique|duplicate/i.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', message); throw e; };

  // ---------- room types, seasons, rooms ----------
  const types = (tenantId: string) => db.query<TypeRow>('select id, name, capacity, rate_cents, weekend_rate_cents, usd, min_stay, features from hotel_room_types where tenant_id = $1 and archived_at is null order by lower(name)', [tenantId]).then((r) => r.rows);
  const seasons = (tenantId: string) => db.query<SeasonRow>('select id, room_type_id, name, starts_on::text as starts_on, ends_on::text as ends_on, rate_cents, weekend_rate_cents, min_stay from hotel_seasons where tenant_id = $1 order by starts_on', [tenantId]).then((r) => r.rows);
  const typesJson = async (tenantId: string) => {
    const s = await seasons(tenantId);
    return (await types(tenantId)).map((t) => ({
      id: t.id, name: t.name, capacity: t.capacity, rateCents: Number(t.rate_cents), weekendRateCents: t.weekend_rate_cents === null ? null : Number(t.weekend_rate_cents), usd: t.usd, minStay: t.min_stay, features: t.features,
      seasons: s.filter((x) => x.room_type_id === t.id).map((x) => ({ id: x.id, name: x.name, from: x.starts_on, to: x.ends_on, rateCents: Number(x.rate_cents), weekendRateCents: x.weekend_rate_cents === null ? null : Number(x.weekend_rate_cents), minStay: x.min_stay })),
    }));
  };
  const typeBody = {
    type: 'object', required: ['name', 'rateCents'], additionalProperties: false,
    properties: {
      name: text(60), capacity: { type: 'integer', minimum: 1, maximum: 30 }, rateCents: cents, weekendRateCents: { anyOf: [cents, { type: 'null' }] }, usd: { type: 'boolean' }, minStay: { type: 'integer', minimum: 1, maximum: 60 },
      features: { type: 'array', maxItems: 20, items: text(40) },
      seasons: { type: 'array', maxItems: 20, items: { type: 'object', required: ['name', 'from', 'to', 'rateCents'], additionalProperties: false, properties: { name: text(60), from: dateSchema, to: dateSchema, rateCents: cents, weekendRateCents: { anyOf: [cents, { type: 'null' }] }, minStay: { anyOf: [{ type: 'integer', minimum: 1, maximum: 60 }, { type: 'null' }] } } } },
    },
  } as const;
  type TypeBody = { name: string; capacity?: number; rateCents: number; weekendRateCents?: number | null; usd?: boolean; minStay?: number; features?: string[]; seasons?: Array<{ name: string; from: string; to: string; rateCents: number; weekendRateCents?: number | null; minStay?: number | null }> };
  const saveType = async (tenantId: string, id: string, b: TypeBody, isNew: boolean) => {
    if (b.seasons?.some((s) => s.from > s.to)) throw new ApiError(422, 'invalid_season', 'A season ends on or after the day it starts');
    try {
      await db.transaction(async (tx) => {
        const values = [id, tenantId, b.name.trim(), b.capacity ?? 2, b.rateCents, b.weekendRateCents ?? null, b.usd ?? false, b.minStay ?? 1, b.features ?? []];
        if (isNew) await tx.query('insert into hotel_room_types (id, tenant_id, name, capacity, rate_cents, weekend_rate_cents, usd, min_stay, features) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', values);
        else if (!(await tx.query('update hotel_room_types set name = $3, capacity = $4, rate_cents = $5, weekend_rate_cents = $6, usd = $7, min_stay = $8, features = $9 where id = $1 and tenant_id = $2 and archived_at is null returning id', values)).rows.length) throw notFound('Room type');
        if (b.seasons) {
          await tx.query('delete from hotel_seasons where room_type_id = $1 and tenant_id = $2', [id, tenantId]);
          for (const s of b.seasons) await tx.query('insert into hotel_seasons (id, tenant_id, room_type_id, name, starts_on, ends_on, rate_cents, weekend_rate_cents, min_stay) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [randomUUID(), tenantId, id, s.name.trim(), s.from, s.to, s.rateCents, s.weekendRateCents ?? null, s.minStay ?? null]);
        }
      });
    } catch (e) { unique(e, 'There is already a room type with that name'); }
  };
  app.get('/hotel/room-types', async (request) => { anyone(request); return { data: await typesJson(request.tenantId) }; });
  app.post<{ Body: TypeBody }>('/hotel/room-types', { schema: { body: typeBody } }, async (request, reply) => {
    setup(request);
    await hotel(request.tenantId);
    const id = randomUUID();
    await saveType(request.tenantId, id, request.body, true);
    return reply.code(201).send({ id, data: await typesJson(request.tenantId) });
  });
  app.put<{ Params: { id: string }; Body: TypeBody }>('/hotel/room-types/:id', { schema: { params: idParams, body: typeBody } }, async (request) => {
    setup(request);
    await saveType(request.tenantId, request.params.id, request.body, false);
    return { data: await typesJson(request.tenantId) };
  });
  app.delete<{ Params: { id: string } }>('/hotel/room-types/:id', { schema: { params: idParams } }, async (request) => {
    setup(request);
    if ((await db.query('select 1 from hotel_rooms where room_type_id = $1 and tenant_id = $2 and archived_at is null limit 1', [request.params.id, request.tenantId])).rows.length) throw new ApiError(409, 'has_rooms', 'Rooms are of this type. Change or remove them first.');
    await db.query('update hotel_room_types set archived_at = now() where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await typesJson(request.tenantId) };
  });

  const roomsJson = async (tenantId: string) => (await db.query<{ id: string; name: string; room_type_id: string; type_name: string; features: string[]; status: string; status_note: string | null; status_at: Date | string | null }>(
    'select r.id, r.name, r.room_type_id, t.name as type_name, r.features, r.status, r.status_note, r.status_at from hotel_rooms r join hotel_room_types t on t.id = r.room_type_id where r.tenant_id = $1 and r.archived_at is null order by r.name', [tenantId],
  )).rows.map((r) => ({ id: r.id, name: r.name, roomType: { id: r.room_type_id, name: r.type_name }, features: r.features, status: r.status, statusNote: r.status_note, statusAt: r.status_at ? new Date(r.status_at).toISOString() : null }));
  const roomBody = { type: 'object', required: ['name', 'roomTypeId'], additionalProperties: false, properties: { name: text(20), roomTypeId: uuid, features: { type: 'array', maxItems: 20, items: text(40) } } } as const;
  app.get('/hotel/rooms', async (request) => { anyone(request); return { data: await roomsJson(request.tenantId) }; });
  app.post<{ Body: { name: string; roomTypeId: string; features?: string[] } }>('/hotel/rooms', { schema: { body: roomBody } }, async (request, reply) => {
    setup(request);
    await hotel(request.tenantId);
    if (!(await types(request.tenantId)).some((t) => t.id === request.body.roomTypeId)) throw new ApiError(422, 'invalid_room', 'Choose one of your room types');
    const id = randomUUID();
    try { await db.query('insert into hotel_rooms (id, tenant_id, room_type_id, name, features) values ($1, $2, $3, $4, $5)', [id, request.tenantId, request.body.roomTypeId, request.body.name.trim(), request.body.features ?? []]); } catch (e) { unique(e, 'There is already a room with that name'); }
    return reply.code(201).send({ id, data: await roomsJson(request.tenantId) });
  });
  app.put<{ Params: { id: string }; Body: { name: string; roomTypeId: string; features?: string[] } }>('/hotel/rooms/:id', { schema: { params: idParams, body: roomBody } }, async (request) => {
    setup(request);
    if (!(await types(request.tenantId)).some((t) => t.id === request.body.roomTypeId)) throw new ApiError(422, 'invalid_room', 'Choose one of your room types');
    try {
      if (!(await db.query('update hotel_rooms set name = $3, room_type_id = $4, features = $5 where id = $1 and tenant_id = $2 and archived_at is null returning id', [request.params.id, request.tenantId, request.body.name.trim(), request.body.roomTypeId, request.body.features ?? []])).rows.length) throw notFound('Room');
    } catch (e) { unique(e, 'There is already a room with that name'); }
    return { data: await roomsJson(request.tenantId) };
  });
  app.delete<{ Params: { id: string } }>('/hotel/rooms/:id', { schema: { params: idParams } }, async (request) => {
    setup(request);
    if ((await db.query("select 1 from hotel_bookings where room_id = $1 and status in ('booked', 'in_house') limit 1", [request.params.id])).rows.length) throw new ApiError(409, 'has_bookings', 'This room has bookings. Move them first.');
    await db.query('update hotel_rooms set archived_at = now() where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    return { data: await roomsJson(request.tenantId) };
  });

  // ---------- availability and the calendar ----------
  const stayQuery = { type: 'object', required: ['arrival', 'departure'], additionalProperties: false, properties: { arrival: dateSchema, departure: dateSchema } } as const;
  app.get<{ Querystring: { arrival: string; departure: string } }>('/hotel/availability', { schema: { querystring: stayQuery } }, async (request) => {
    desk(request);
    const { arrival, departure } = request.query;
    if (arrival >= departure) throw new ApiError(400, 'invalid_request', 'Departure is after arrival');
    const venue = await hotel(request.tenantId);
    const free = await freeRooms(db, request.tenantId, arrival, departure);
    const s = await seasons(request.tenantId);
    return {
      data: (await types(request.tenantId)).map((t) => {
        const mine = s.filter((x) => x.room_type_id === t.id);
        const nightly = nightsOf(arrival, departure).map((d) => ({ date: d, cents: nightRate(t, mine, d, venue.usdRateCents) }));
        const total = nightly.reduce((a, n) => a + n.cents, 0);
        return { roomType: { id: t.id, name: t.name, capacity: t.capacity }, free: free.filter((r) => r.room_type_id === t.id).map((r) => ({ id: r.id, name: r.name, status: r.status })), minStay: minStay(t, mine, arrival), nightly: nightly.map((n) => ({ date: n.date, rate: money(n.cents) })), total: money(total), totalUsd: money(Math.round((total * 100) / venue.usdRateCents)) };
      }),
    };
  });
  app.get<{ Querystring: { from: string; to: string } }>('/hotel/calendar', { schema: { querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema } } } }, async (request) => {
    anyone(request);
    const { from, to } = request.query;
    if (from > to || nightsOf(from, to).length > 120) throw new ApiError(400, 'invalid_request', 'Up to 120 days at a time');
    const bookings = (await db.query<BookingRow>(`select ${BOOKING} from ${BOOKING_FROM} where b.tenant_id = $1 and b.status in ('booked', 'in_house', 'checked_out') and b.arrival <= $3::date and b.departure > $2::date order by b.arrival`, [request.tenantId, from, to])).rows;
    return { from, to, today: await hotelDate(db, request.tenantId), rooms: await roomsJson(request.tenantId), bookings: bookings.map(bookingJson) };
  });

  // ---------- bookings ----------
  const bookingBody = {
    type: 'object', required: ['guestName', 'roomTypeId', 'arrival', 'departure'], additionalProperties: false,
    properties: {
      guestName: text(120), phone: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 254 }, roomTypeId: uuid, roomId: { anyOf: [uuid, { type: 'null' }] }, arrival: dateSchema, departure: dateSchema,
      adults: { type: 'integer', minimum: 1, maximum: 30 }, children: { type: 'integer', minimum: 0, maximum: 30 }, source: { type: 'string', enum: ['direct', 'phone', 'website', 'agent', 'walk_in'] },
      policy: { type: 'string', maxLength: 500 }, groupName: { type: 'string', maxLength: 80 }, notes: { type: 'string', maxLength: 1000 },
      // A rate agreed for this stay, per night, instead of the plan's.
      rateCents: cents, shortStay: { type: 'boolean' },
    },
  } as const;
  type BookingBody = { guestName: string; phone?: string; email?: string; roomTypeId: string; roomId?: string | null; arrival: string; departure: string; adults?: number; children?: number; source?: string; policy?: string; groupName?: string; notes?: string; rateCents?: number; shortStay?: boolean };

  /** Check a stay can be sold, and price it. */
  const priceStay = async (tx: Queryable, tenantId: string, venue: VenueSettings, b: BookingBody, except?: string, keep: Array<{ date: string; cents: number }> = []) => {
    if (b.arrival >= b.departure) throw new ApiError(422, 'invalid_booking', 'Departure is after arrival');
    const nights = nightsOf(b.arrival, b.departure);
    if (nights.length > 365) throw new ApiError(422, 'invalid_booking', 'A stay of up to a year');
    const type = (await tx.query<TypeRow>('select id, name, capacity, rate_cents, weekend_rate_cents, usd, min_stay, features from hotel_room_types where id = $1 and tenant_id = $2 and archived_at is null', [b.roomTypeId, tenantId])).rows[0];
    if (!type) throw new ApiError(422, 'invalid_booking', 'Choose one of your room types');
    const s = (await tx.query<SeasonRow>('select id, room_type_id, name, starts_on::text as starts_on, ends_on::text as ends_on, rate_cents, weekend_rate_cents, min_stay from hotel_seasons where room_type_id = $1', [type.id])).rows;
    const least = minStay(type, s, b.arrival);
    if (nights.length < least && !b.shortStay) throw new ApiError(422, 'min_stay', `${type.name} is sold for at least ${least} nights from ${b.arrival}`);
    const free = await freeRooms(tx, tenantId, b.arrival, b.departure, except, b.roomId);
    if (b.roomId) {
      const room = free.find((r) => r.id === b.roomId);
      if (!room) throw new ApiError(409, 'room_taken', 'That room is not free for those nights');
      if (room.room_type_id !== type.id) throw new ApiError(422, 'invalid_booking', 'That room is of another type');
    } else if (!free.some((r) => r.room_type_id === type.id)) throw new ApiError(409, 'sold_out', `No ${type.name} is free for those nights`);
    // Nights already agreed (or already charged) keep their rate when a stay is moved or extended.
    const nightly = nights.map((d) => ({ date: d, cents: keep.find((k) => k.date === d)?.cents ?? b.rateCents ?? nightRate(type, s, d, venue.usdRateCents) }));
    return { nightly, type };
  };

  const fullBooking = async (tenantId: string, id: string) => {
    const b = await loadBooking(db, tenantId, id);
    const tax = await taxRules(db, tenantId, deps.now?.() ?? new Date());
    return { ...bookingJson(b), ...(await folioJson(db, tenantId, id, tax)) };
  };

  app.post<{ Body: BookingBody }>('/hotel/bookings', { schema: { body: bookingBody } }, async (request, reply) => {
    desk(request);
    const venue = await hotel(request.tenantId);
    const b = request.body;
    const id = randomUUID();
    await db.transaction(async (tx) => {
      // One booking at a time per business: two desks cannot sell the same room.
      await tx.query('select 1 from tenants where id = $1 for update', [request.tenantId]);
      const { nightly } = await priceStay(tx, request.tenantId, venue, b);
      const number = (await tx.query<{ n: number }>('update tenants set next_booking_number = next_booking_number + 1 where id = $1 returning next_booking_number - 1 as n', [request.tenantId])).rows[0]!.n;
      // The guest is a customer too: what is charged to the room is invoiced to them.
      const customerId = randomUUID();
      await tx.query('insert into customers (id, tenant_id, name, telephone, email) values ($1, $2, $3, $4, $5)', [customerId, request.tenantId, b.guestName.trim(), b.phone?.trim() || null, b.email?.trim() || null]);
      const guestId = randomUUID();
      await tx.query('insert into venue_guests (id, tenant_id, name, phone, email, customer_id) values ($1, $2, $3, $4, $5, $6)', [guestId, request.tenantId, b.guestName.trim(), b.phone?.trim() || null, b.email?.trim() || null, customerId]);
      await tx.query(
        `insert into hotel_bookings (id, tenant_id, number, guest_name, phone, email, guest_id, customer_id, room_type_id, room_id, arrival, departure, adults, children, source, nightly, policy, group_name, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [id, request.tenantId, number, b.guestName.trim(), b.phone?.trim() || null, b.email?.trim() || null, guestId, customerId, b.roomTypeId, b.roomId ?? null, b.arrival, b.departure, b.adults ?? 2, b.children ?? 0, b.source ?? 'direct',
          JSON.stringify(nightly), b.policy?.trim() || null, b.groupName?.trim() || null, b.notes?.trim() || null, request.userId || null],
      );
      await tx.query("insert into hotel_folios (id, tenant_id, booking_id, name, position) values ($1, $2, $3, 'Room', 0)", [randomUUID(), request.tenantId, id]);
    });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.booked', target: b.guestName.trim(), details: { arrival: b.arrival, departure: b.departure }, ip: request.ip });
    return reply.code(201).send(await fullBooking(request.tenantId, id));
  });

  app.get<{ Params: { id: string } }>('/hotel/bookings/:id', { schema: { params: idParams } }, async (request) => { desk(request); return fullBooking(request.tenantId, request.params.id); });

  // Extend, shorten, move dates or change the room (dragging on the calendar). Nights already charged keep their rate.
  app.put<{ Params: { id: string }; Body: Partial<BookingBody> }>('/hotel/bookings/:id', { schema: { params: idParams, body: { ...bookingBody, required: [] } } }, async (request) => {
    desk(request);
    const venue = await hotel(request.tenantId);
    await db.transaction(async (tx) => {
      await tx.query('select 1 from tenants where id = $1 for update', [request.tenantId]);
      const cur = await loadBooking(tx, request.tenantId, request.params.id, true);
      if (cur.status !== 'booked' && cur.status !== 'in_house') throw new ApiError(409, 'closed', 'This booking is finished');
      const p = request.body;
      const next: BookingBody = {
        guestName: p.guestName ?? cur.guest_name, roomTypeId: p.roomTypeId ?? cur.room_type_id, roomId: p.roomId === undefined ? cur.room_id : p.roomId, arrival: p.arrival ?? cur.arrival, departure: p.departure ?? cur.departure,
        shortStay: p.shortStay ?? cur.status === 'in_house', ...(p.rateCents !== undefined && { rateCents: p.rateCents }),
      };
      if (cur.status === 'in_house' && next.arrival !== cur.arrival) throw new ApiError(409, 'in_house', 'The guest has arrived: the arrival date stays');
      const posted = (await tx.query<{ d: string }>("select business_date::text as d from hotel_folio_lines where booking_id = $1 and kind = 'room'", [cur.id])).rows.map((r) => r.d);
      if (posted.some((d) => d >= next.departure)) throw new ApiError(409, 'nights_charged', 'Nights after that date are already charged');
      const sameType = next.roomTypeId === cur.room_type_id;
      const { nightly } = await priceStay(tx, request.tenantId, venue, next, cur.id, sameType || posted.length ? cur.nightly.filter((n) => sameType || posted.includes(n.date)) : []);
      await tx.query(
        `update hotel_bookings set guest_name = $3, phone = coalesce($4, phone), email = coalesce($5, email), room_type_id = $6, room_id = $7, arrival = $8, departure = $9, adults = coalesce($10, adults), children = coalesce($11, children),
           nightly = $12, policy = coalesce($13, policy), group_name = coalesce($14, group_name), notes = coalesce($15, notes) where id = $1 and tenant_id = $2`,
        [cur.id, request.tenantId, next.guestName.trim(), p.phone ?? null, p.email ?? null, next.roomTypeId, next.roomId ?? null, next.arrival, next.departure, p.adults ?? null, p.children ?? null, JSON.stringify(nightly), p.policy ?? null, p.groupName ?? null, p.notes ?? null],
      );
      if (cur.status === 'in_house' && next.roomId && next.roomId !== cur.room_id) {
        if (cur.room_id) await tx.query("update hotel_rooms set status = 'dirty', status_at = now() where id = $1", [cur.room_id]);
      }
    });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.booking_changed', target: request.params.id, details: request.body as Record<string, unknown>, ip: request.ip });
    return fullBooking(request.tenantId, request.params.id);
  });

  // A deposit: a tax receipt now; used at check-out, or given back.
  app.post<{ Params: { id: string }; Body: { amount: string; method: PaymentMethod } }>(
    '/hotel/bookings/:id/deposit',
    { schema: { params: idParams, body: { type: 'object', required: ['amount', 'method'], additionalProperties: false, properties: { amount, method: { type: 'string', enum: [...METHODS] } } } } },
    async (request, reply) => {
      desk(request);
      const b = await loadBooking(db, request.tenantId, request.params.id);
      if (b.status !== 'booked' && b.status !== 'in_house') throw new ApiError(409, 'closed', 'This booking is finished');
      const tax = await taxRules(db, request.tenantId, deps.now?.() ?? new Date());
      const means = { cash: '10', cheque: '20', bank_transfer: '30', card: '48', online: '68', other: '1', refund: '10' }[request.body.method] ?? '10';
      const result = await issueFromBody(deps, request.tenantId, {
        type: '02', ...(b.customer_id && { customerId: b.customer_id }),
        // Money for a room night, taken ahead: it carries the room's own GST treatment. The hotel tax is charged on the final bill.
        lines: [{ description: `Deposit for booking ${bookingNumber(b.number)}, ${b.arrival} to ${b.departure}`, quantity: '1', unitCode: 'C62', unitPrice: request.body.amount, gstCategory: tax.accommodationGst === 'standard' ? 'S' : 'E', ...(tax.accommodationGst !== 'standard' && { exemptionReasonCode: tax.accommodationExemptionCode }) }],
        payment: { meansCode: means === '1' ? '30' : means, terms: 'Deposit' },
      }, request.userId || null, { deviceId: request.posDevice?.id ?? null });
      if (result.status === 'rejected') throw new ApiError(409, 'rejected', 'BTS rejected the deposit receipt. Look at the document for why.');
      const paid = Number((await db.query<{ c: unknown }>('select payable_cents as c from documents where id = $1', [result.documentId])).rows[0]!.c);
      await db.query("insert into venue_deposits (id, tenant_id, kind, ref_id, amount_cents, method, document_id, created_by) values ($1, $2, 'room', $3, $4, $5, $6, $7)", [randomUUID(), request.tenantId, b.id, paid, request.body.method, result.documentId, request.userId || null]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.deposit', target: bookingNumber(b.number), details: { amount: money(paid) }, ip: request.ip });
      return reply.code(201).send({ documentId: result.documentId, ...(await fullBooking(request.tenantId, b.id)) });
    },
  );

  app.post<{ Params: { id: string }; Body: { roomId?: string; force?: boolean } | undefined }>(
    '/hotel/bookings/:id/check-in',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { roomId: uuid, force: { type: 'boolean' } } } } },
    async (request) => {
      desk(request);
      const today = await hotelDate(db, request.tenantId);
      await db.transaction(async (tx) => {
        await tx.query('select 1 from tenants where id = $1 for update', [request.tenantId]);
        const b = await loadBooking(tx, request.tenantId, request.params.id, true);
        if (b.status !== 'booked') throw new ApiError(409, 'not_booked', b.status === 'in_house' ? 'The guest is already checked in' : 'This booking is finished');
        if (b.arrival > today && !request.body?.force) throw new ApiError(409, 'early', `This booking arrives on ${b.arrival}`);
        const roomId = request.body?.roomId ?? b.room_id;
        const free = await freeRooms(tx, request.tenantId, b.arrival < today ? b.arrival : today, b.departure, b.id, roomId);
        const room = roomId ? free.find((r) => r.id === roomId) : free.find((r) => r.room_type_id === b.room_type_id && r.status !== 'dirty') ?? free.find((r) => r.room_type_id === b.room_type_id);
        if (!room) throw new ApiError(409, 'room_taken', roomId ? 'That room is not free' : 'No room of that type is free');
        // Housekeeping decides when a room can be given: a dirty room needs someone to say so.
        if (room.status === 'dirty' && !request.body?.force) throw new ApiError(409, 'room_dirty', `Room ${room.name} has not been cleaned yet`);
        await tx.query("update hotel_bookings set status = 'in_house', room_id = $2, checked_in_at = now() where id = $1", [b.id, room.id]);
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.checked_in', target: request.params.id, ip: request.ip });
      return fullBooking(request.tenantId, request.params.id);
    },
  );

  // Something typed at the desk (laundry, a tour): on the final bill, standard-rated.
  app.post<{ Params: { id: string }; Body: { description: string; amount: string; folioId?: string } }>(
    '/hotel/bookings/:id/extras',
    { schema: { params: idParams, body: { type: 'object', required: ['description', 'amount'], additionalProperties: false, properties: { description: text(120), amount, folioId: uuid } } } },
    async (request) => {
      desk(request);
      const b = await loadBooking(db, request.tenantId, request.params.id);
      if (b.status !== 'in_house' && b.status !== 'booked') throw new ApiError(409, 'closed', 'This booking is finished');
      const folio = (await db.query<{ id: string }>('select id from hotel_folios where booking_id = $1 and ($2::uuid is null or id = $2) order by position limit 1', [b.id, request.body.folioId ?? null])).rows[0];
      if (!folio) throw notFound('Folio');
      await db.query("insert into hotel_folio_lines (id, tenant_id, booking_id, folio_id, business_date, kind, description, amount_cents, created_by) values ($1, $2, $3, $4, $5, 'extra', $6, $7, $8)",
        [randomUUID(), request.tenantId, b.id, folio.id, await hotelDate(db, request.tenantId), request.body.description.trim(), toCents(request.body.amount), request.userId || null]);
      return fullBooking(request.tenantId, b.id);
    },
  );

  // A second folio: the company pays the room, the guest the extras.
  app.post<{ Params: { id: string }; Body: { name: string } }>('/hotel/bookings/:id/folios', { schema: { params: idParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: text(40) } } } }, async (request) => {
    desk(request);
    const b = await loadBooking(db, request.tenantId, request.params.id);
    const n = Number((await db.query<{ n: unknown }>('select count(*) as n from hotel_folios where booking_id = $1', [b.id])).rows[0]!.n);
    if (n >= 4) throw new ApiError(422, 'too_many', 'Up to four folios for a stay');
    await db.query('insert into hotel_folios (id, tenant_id, booking_id, name, position) values ($1, $2, $3, $4, $5)', [randomUUID(), request.tenantId, b.id, request.body.name.trim(), n]);
    return fullBooking(request.tenantId, b.id);
  });
  app.put<{ Params: { id: string }; Body: { folioId: string } }>('/hotel/folio-lines/:id', { schema: { params: idParams, body: { type: 'object', required: ['folioId'], additionalProperties: false, properties: { folioId: uuid } } } }, async (request) => {
    desk(request);
    const line = (await db.query<{ booking_id: string; document_id: string | null; kind: string }>('select booking_id, document_id, kind from hotel_folio_lines where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!line) throw notFound('Line');
    if (line.document_id && line.kind !== 'charge') throw new ApiError(409, 'invoiced', 'That line is already on an invoice');
    if (!(await db.query('select 1 from hotel_folios where id = $1 and booking_id = $2', [request.body.folioId, line.booking_id])).rows.length) throw new ApiError(422, 'invalid_folio', 'That folio is of another stay');
    await db.query('update hotel_folio_lines set folio_id = $2 where id = $1', [request.params.id, request.body.folioId]);
    return fullBooking(request.tenantId, line.booking_id);
  });

  /** Issue the invoice for a folio's nights and extras not yet on one. */
  const invoiceFolio = async (tenantId: string, b: BookingRow, folioId: string, userId: string | null, tax: TaxValues): Promise<string | null> => {
    const lines = (await db.query<LineRow & { room_name: string | null }>(
      "select l.id, l.folio_id, l.business_date::text as business_date, l.kind, l.description, l.amount_cents, l.document_id, l.room_id, l.created_at, r.name as room_name from hotel_folio_lines l left join hotel_rooms r on r.id = l.room_id where l.folio_id = $1 and l.kind in ('room', 'extra') and l.document_id is null order by l.business_date, l.created_at", [folioId],
    )).rows;
    if (!lines.length) return null;
    const nights = lines.filter((l) => l.kind === 'room').map((l) => ({ date: l.business_date, cents: Number(l.amount_cents), room: l.room_name ?? b.room_name ?? '' }));
    const extras = lines.filter((l) => l.kind === 'extra').map((l) => ({ description: l.description, quantity: '1', unitCode: 'C62', unitPrice: money(Number(l.amount_cents)), gstCategory: 'S' as const }));
    const result = await issueFromBody(deps, tenantId, {
      type: '01', customerId: b.customer_id!, lines: [...roomLines(nights, b.type_name, tax), ...extras],
      payment: { meansCode: '30', dueDate: b.departure < belizeToday() ? belizeToday() : b.departure, terms: `Booking ${bookingNumber(b.number)}: due at check-out` },
    }, userId, { accountLimit: 'skip' });
    if (result.status === 'rejected') throw new ApiError(409, 'rejected', 'BTS rejected the invoice. Look at the document for why; nothing was charged.');
    await db.query('update hotel_folio_lines set document_id = $2 where id = any($1::uuid[])', [lines.map((l) => l.id), result.documentId]);
    return result.documentId;
  };

  /** Pay a stay's open invoices, oldest first (those of one folio, or all). Returns what could not be placed. */
  const payStay = async (tenantId: string, bookingId: string, folioId: string | null, amountCents: number, method: PaymentMethod, reference: string | null, userId: string | null, deviceId: string | null, kind: 'payment' | 'deposit'): Promise<number> => {
    const docs = (await db.query<{ document_id: string; folio_id: string }>(
      "select distinct on (l.document_id) l.document_id, l.folio_id from hotel_folio_lines l join documents d on d.id = l.document_id where l.booking_id = $1 and l.kind in ('room', 'extra', 'charge') and ($2::uuid is null or l.folio_id = $2) order by l.document_id, d.issue_date", [bookingId, folioId],
    )).rows;
    let left = amountCents;
    for (const d of docs) {
      if (left <= 0) break;
      const r = await receivable(db, tenantId, d.document_id);
      if (!r || r.balanceCents <= 0n) continue;
      const pay = Math.min(left, Number(r.balanceCents));
      await recordPayment(db, tenantId, d.document_id, { amountCents: BigInt(pay), method, reference }, userId, { deviceId });
      await db.query('insert into hotel_folio_lines (id, tenant_id, booking_id, folio_id, business_date, kind, description, amount_cents, document_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [randomUUID(), tenantId, bookingId, d.folio_id, await hotelDate(db, tenantId), kind, kind === 'deposit' ? 'Deposit used' : `Payment (${method.replace('_', ' ')})`, -pay, d.document_id, userId]);
      left -= pay;
    }
    return left;
  };

  const paymentsSchema = { type: 'array', maxItems: 6, items: { type: 'object', required: ['amount', 'method'], additionalProperties: false, properties: { amount, method: { type: 'string', enum: [...METHODS] }, folioId: uuid, reference: { type: 'string', maxLength: 80 } } } } as const;
  type Pay = { amount: string; method: PaymentMethod; folioId?: string; reference?: string };

  // The bill so far, as tax invoices (what is not yet on one), and a payment against it.
  app.post<{ Params: { id: string }; Body: { payments?: Pay[] } | undefined }>(
    '/hotel/bookings/:id/payments',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { payments: paymentsSchema } } } },
    async (request) => {
      desk(request);
      const b = await loadBooking(db, request.tenantId, request.params.id);
      if (b.status !== 'in_house') throw new ApiError(409, 'not_in_house', 'Payments are taken once the guest has checked in; before that, take a deposit');
      const tax = await taxRules(db, request.tenantId, deps.now?.() ?? new Date());
      for (const f of (await db.query<{ id: string }>('select id from hotel_folios where booking_id = $1', [b.id])).rows) await invoiceFolio(request.tenantId, b, f.id, request.userId || null, tax);
      for (const p of request.body?.payments ?? []) {
        try {
          const left = await payStay(request.tenantId, b.id, p.folioId ?? null, toCents(p.amount), p.method, p.reference ?? null, request.userId || null, request.posDevice?.id ?? null, 'payment');
          if (left > 0) throw new ApiError(422, 'too_much', `That is BZ$${money(left)} more than is owed`);
        } catch (e) { if (e instanceof ReceivableError) throw new ApiError(422, 'invalid_payment', e.message); throw e; }
      }
      return fullBooking(request.tenantId, b.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { payments?: Pay[]; leaveBalance?: boolean } | undefined }>(
    '/hotel/bookings/:id/check-out',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { payments: paymentsSchema, leaveBalance: { type: 'boolean' } } } } },
    async (request) => {
      desk(request);
      const tenantId = request.tenantId;
      const b = await loadBooking(db, tenantId, request.params.id);
      if (b.status !== 'in_house') throw new ApiError(409, 'not_in_house', b.status === 'checked_out' ? 'This guest has already checked out' : 'This guest has not checked in');
      const userId = request.userId || null;
      const tax = await taxRules(db, tenantId, deps.now?.() ?? new Date());
      const today = await hotelDate(db, tenantId);
      // An early departure: nights not stayed come off; the departure date is today.
      if (today < b.departure) {
        const kept = b.nightly.filter((n) => n.date < today);
        await db.query('update hotel_bookings set departure = $2, nightly = $3 where id = $1', [b.id, today > b.arrival ? today : addDays(b.arrival, 1), JSON.stringify(kept.length ? kept : b.nightly.slice(0, 1))]);
      }
      // 1. Everything not yet invoiced goes on its folio's invoice.
      for (const f of (await db.query<{ id: string }>('select id from hotel_folios where booking_id = $1 order by position', [b.id])).rows) await invoiceFolio(tenantId, b, f.id, userId, tax);
      // 2. The deposit: its receipt is credited, and the money counts as a payment on the bill.
      for (const d of (await db.query<{ id: string; amount_cents: unknown; document_id: string }>("select id, amount_cents, document_id from venue_deposits where ref_id = $1 and kind = 'room' and status = 'held'", [b.id])).rows) {
        const credit = await issueFromBody(deps, tenantId, {
          type: '04', ...(b.customer_id && { customerId: b.customer_id }), reference: { documentId: d.document_id, reason: 'Deposit used on the final bill' },
          lines: [{ description: `Deposit for booking ${bookingNumber(b.number)}, used on the final bill`, quantity: '1', unitCode: 'C62', unitPrice: money(Number(d.amount_cents)), gstCategory: tax.accommodationGst === 'standard' ? 'S' : 'E', ...(tax.accommodationGst !== 'standard' && { exemptionReasonCode: tax.accommodationExemptionCode }) }],
          payment: { meansCode: '30', terms: 'Deposit used on the final bill: no money given back' },
        }, userId, { accountLimit: 'skip' });
        if (credit.status === 'rejected') throw new ApiError(409, 'rejected', 'BTS rejected the credit note for the deposit. The guest is still checked in.');
        const left = await payStay(tenantId, b.id, null, Number(d.amount_cents), 'other', 'Deposit', userId, request.posDevice?.id ?? null, 'deposit');
        await db.query("update venue_deposits set status = $2, credit_document_id = $3, settled_at = now() where id = $1", [d.id, left > 0 ? 'applied' : 'applied', credit.documentId]);
      }
      // 3. What the guest pays now, in as many parts as they like.
      for (const p of request.body?.payments ?? []) {
        try {
          const left = await payStay(tenantId, b.id, p.folioId ?? null, toCents(p.amount), p.method, p.reference ?? null, userId, request.posDevice?.id ?? null, 'payment');
          if (left > 0) throw new ApiError(422, 'too_much', `That is BZ$${money(left)} more than is owed`);
        } catch (e) { if (e instanceof ReceivableError) throw new ApiError(422, 'invalid_payment', e.message); throw e; }
      }
      const folio = await folioJson(db, tenantId, b.id, tax);
      if (folio.balanceCents > 0 && !request.body?.leaveBalance) throw new ApiError(409, 'balance_due', `BZ$${folio.balance} is still owed. Take the payment, or leave it on the guest's account.`);
      await db.query("update hotel_bookings set status = 'checked_out', checked_out_at = now() where id = $1", [b.id]);
      if (b.room_id) await db.query("update hotel_rooms set status = 'dirty', status_at = now(), status_note = 'Checked out' where id = $1", [b.room_id]);
      if (b.guest_id) await db.query('update venue_guests set visits = visits + 1, last_visit = $2 where id = $1', [b.guest_id, today]);
      await audit(db, { tenantId, userId, action: 'hotel.checked_out', target: bookingNumber(b.number), details: { balance: folio.balance }, ip: request.ip });
      return fullBooking(tenantId, b.id);
    },
  );

  for (const [path, status] of [['cancel', 'cancelled'], ['no-show', 'no_show']] as const) {
    app.post<{ Params: { id: string }; Body: { reason?: string; refundDeposit?: boolean } | undefined }>(
      `/hotel/bookings/:id/${path}`,
      { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: 300 }, refundDeposit: { type: 'boolean' } } } } },
      async (request) => {
        desk(request);
        const b = await loadBooking(db, request.tenantId, request.params.id);
        if (b.status !== 'booked') throw new ApiError(409, 'not_booked', 'Only a booking that has not arrived can be cancelled');
        // A deposit is given back (its receipt credited) or kept, by the cancellation policy: the desk says which.
        for (const d of (await db.query<{ id: string; document_id: string; amount_cents: unknown }>("select id, document_id, amount_cents from venue_deposits where ref_id = $1 and kind = 'room' and status = 'held'", [b.id])).rows) {
          if (request.body?.refundDeposit) {
            const tax = await taxRules(db, request.tenantId, deps.now?.() ?? new Date());
            const credit = await issueFromBody(deps, request.tenantId, {
              type: '04', ...(b.customer_id && { customerId: b.customer_id }), reference: { documentId: d.document_id, reason: 'Booking cancelled: deposit returned' },
              lines: [{ description: `Deposit for booking ${bookingNumber(b.number)} returned`, quantity: '1', unitCode: 'C62', unitPrice: money(Number(d.amount_cents)), gstCategory: tax.accommodationGst === 'standard' ? 'S' : 'E', ...(tax.accommodationGst !== 'standard' && { exemptionReasonCode: tax.accommodationExemptionCode }) }],
              payment: { meansCode: '10', terms: 'Deposit returned' },
            }, request.userId || null, { accountLimit: 'skip' });
            await db.query("update venue_deposits set status = 'refunded', credit_document_id = $2, settled_at = now() where id = $1", [d.id, credit.documentId]);
          } else await db.query("update venue_deposits set status = 'kept', settled_at = now() where id = $1", [d.id]);
        }
        await db.query('update hotel_bookings set status = $2, cancelled_at = now(), cancel_reason = $3 where id = $1', [b.id, status, request.body?.reason?.trim() || null]);
        if (status === 'no_show' && b.guest_id) await db.query('update venue_guests set no_shows = no_shows + 1 where id = $1', [b.guest_id]);
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `hotel.${status}`, target: bookingNumber(b.number), details: { reason: request.body?.reason ?? null }, ip: request.ip });
        return fullBooking(request.tenantId, b.id);
      },
    );
  }

  // ---------- the front desk ----------
  app.get('/hotel/front-desk', async (request) => {
    desk(request);
    const today = await hotelDate(db, request.tenantId);
    const rows = (await db.query<BookingRow>(`select ${BOOKING} from ${BOOKING_FROM} where b.tenant_id = $1 and ((b.status = 'booked' and b.arrival <= $2::date) or b.status = 'in_house' or (b.status = 'checked_out' and b.departure = $2::date)) order by r.name nulls last, b.guest_name`, [request.tenantId, today])).rows.map(bookingJson);
    return {
      today,
      arrivals: rows.filter((b) => b.status === 'booked'),
      departures: rows.filter((b) => b.status === 'in_house' && b.departure <= today),
      inHouse: rows.filter((b) => b.status === 'in_house'),
      departed: rows.filter((b) => b.status === 'checked_out'),
      rooms: await roomsJson(request.tenantId),
    };
  });
  // Who is in a room: the till shows the name, the server confirms it with the guest, and only then charges.
  app.get<{ Querystring: { room?: string } }>('/hotel/in-house', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { room: { type: 'string', maxLength: 20 } } } } }, async (request) => {
    anyone(request);
    const rows = (await db.query<BookingRow>(`select ${BOOKING} from ${BOOKING_FROM} where b.tenant_id = $1 and b.status = 'in_house' and ($2::text is null or lower(r.name) = lower($2)) order by r.name`, [request.tenantId, request.query.room?.trim() || null])).rows;
    const folios = rows.length ? (await db.query<{ id: string; booking_id: string; name: string }>('select id, booking_id, name from hotel_folios where booking_id = any($1::uuid[]) order by position', [rows.map((r) => r.id)])).rows : [];
    return { data: rows.map((b) => ({ bookingId: b.id, number: bookingNumber(b.number), room: b.room_name, guest: b.guest_name, customerId: b.customer_id, departure: b.departure, folios: folios.filter((f) => f.booking_id === b.id).map((f) => ({ id: f.id, name: f.name })) })) };
  });

  // ---------- housekeeping ----------
  app.get('/hotel/housekeeping', async (request) => {
    anyone(request);
    const today = await hotelDate(db, request.tenantId);
    const tasks = (await db.query<{ id: string; room_id: string; kind: string; user_id: string | null; user_name: string | null; done_at: Date | string | null }>(
      'select k.id, k.room_id, k.kind, k.user_id, u.name as user_name, k.done_at from hotel_tasks k left join users u on u.id = k.user_id where k.tenant_id = $1 and k.business_date = $2', [request.tenantId, today],
    )).rows;
    const occupied = (await db.query<{ room_id: string; guest_name: string; departure: string }>("select room_id, guest_name, departure::text as departure from hotel_bookings where tenant_id = $1 and status = 'in_house' and room_id is not null", [request.tenantId])).rows;
    const mine = can(request.principal, 'hotel.frontdesk') ? null : request.userId;
    return {
      today,
      rooms: (await roomsJson(request.tenantId)).map((r) => {
        const task = tasks.find((k) => k.room_id === r.id);
        const guest = occupied.find((o) => o.room_id === r.id);
        return { ...r, occupied: Boolean(guest), ...(guest && { departs: guest.departure }), task: task ? { id: task.id, kind: task.kind, userId: task.user_id, userName: task.user_name, doneAt: task.done_at ? new Date(task.done_at).toISOString() : null } : null };
      }).filter((r) => !mine || !r.task?.userId || r.task.userId === mine),
      housekeepers: (await db.query<{ id: string; name: string }>("select id, name from users where tenant_id = $1 and status = 'active' and role = 'housekeeper' order by lower(name)", [request.tenantId])).rows,
    };
  });
  app.post<{ Params: { id: string }; Body: { status: 'clean' | 'dirty' | 'inspected' | 'out_of_order'; note?: string } }>(
    '/hotel/rooms/:id/status',
    { schema: { params: idParams, body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['clean', 'dirty', 'inspected', 'out_of_order'] }, note: { type: 'string', maxLength: 200 } } } } },
    async (request) => {
      if (!can(request.principal, 'hotel.housekeeping')) desk(request);
      const s = request.body.status;
      // Inspecting, and taking a room out of order or back, are a supervisor's.
      if ((s === 'inspected' || s === 'out_of_order') && !can(request.principal, 'hotel.frontdesk')) throw new ApiError(403, 'forbidden', 'The front desk marks a room inspected or out of order');
      const r = await db.query<{ name: string }>('update hotel_rooms set status = $3, status_note = $4, status_at = now(), status_by = $5 where id = $1 and tenant_id = $2 and archived_at is null returning name', [request.params.id, request.tenantId, s, request.body.note?.trim() || null, request.userId || null]);
      if (!r.rows.length) throw notFound('Room');
      if (s === 'clean' || s === 'inspected') await db.query('update hotel_tasks set done_at = coalesce(done_at, now()), done_by = coalesce(done_by, $3) where room_id = $1 and business_date = $2', [request.params.id, await hotelDate(db, request.tenantId), request.userId || null]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.room_status', target: r.rows[0]!.name, details: { status: s }, ip: request.ip });
      return { data: await roomsJson(request.tenantId) };
    },
  );
  app.put<{ Params: { id: string }; Body: { userId: string | null } }>('/hotel/tasks/:id', { schema: { params: idParams, body: { type: 'object', required: ['userId'], additionalProperties: false, properties: { userId: { anyOf: [uuid, { type: 'null' }] } } } } }, async (request) => {
    desk(request);
    if (request.body.userId && !(await db.query("select 1 from users where id = $1 and tenant_id = $2 and status = 'active'", [request.body.userId, request.tenantId])).rows.length) throw new ApiError(422, 'invalid_user', 'Choose one of your staff');
    if (!(await db.query('update hotel_tasks set user_id = $3 where id = $1 and tenant_id = $2 returning id', [request.params.id, request.tenantId, request.body.userId])).rows.length) throw notFound('Task');
    return { ok: true };
  });

  // ---------- the night audit ----------
  app.get('/hotel/audits', async (request) => {
    requirePermission(request, 'reports.view');
    return { today: await hotelDate(db, request.tenantId), data: (await db.query<{ business_date: string; report: unknown; run_at: Date | string }>('select business_date::text as business_date, report, run_at from hotel_audits where tenant_id = $1 order by business_date desc limit 62', [request.tenantId])).rows.map((r) => ({ date: r.business_date, runAt: new Date(r.run_at).toISOString(), ...(r.report as object) })) };
  });
  app.post('/hotel/night-audit', async (request) => {
    desk(request);
    if (!can(request.principal, 'venue.approve')) requirePermission(request, 'business.manage');
    await hotel(request.tenantId);
    const report = await runNightAudit(deps, request.tenantId, request.userId || null, invoiceFolio);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'hotel.night_audit', target: report.date, details: { occupancy: report.occupancyPercent, revenue: report.roomRevenue }, ip: request.ip });
    return report;
  });
}

export interface AuditReport {
  date: string; nextDate: string; roomsAvailable: number; roomsOccupied: number; outOfOrder: number; occupancyPercent: number;
  roomRevenue: string; hotelTax: string; adr: string; revpar: string; arrivals: number; departures: number; inHouse: number; guests: number;
  outletCharges: string; payments: string;
  /** Things the manager should look at before the day is forgotten. */
  flags: string[];
}

/**
 * Close the hotel's day: post tonight's room charge for every guest in
 * house, flag what does not add up, work out the day's figures, set up
 * tomorrow's housekeeping, and move the hotel's date on. Once per date.
 */
export async function runNightAudit(deps: PipelineDeps, tenantId: string, userId: string | null, invoiceFolio: (tenantId: string, b: BookingRow, folioId: string, userId: string | null, tax: TaxValues) => Promise<string | null>): Promise<AuditReport> {
  const db: Database = deps.db;
  const venue = await loadVenue(db, tenantId);
  const date = venue.hotelDate ?? belizeToday();
  const nextDate = addDays(date, 1);
  const tax = await taxRules(db, tenantId, deps.now?.() ?? new Date());
  if ((await db.query('select 1 from hotel_audits where tenant_id = $1 and business_date = $2', [tenantId, date])).rows.length) throw new ApiError(409, 'already_run', `The night audit for ${date} has already run`);
  const flags: string[] = [];
  const inHouse = (await db.query<BookingRow>(`select ${BOOKING} from ${BOOKING_FROM} where b.tenant_id = $1 and b.status = 'in_house' order by r.name`, [tenantId])).rows;
  let revenue = 0;
  await db.transaction(async (tx) => {
    for (const b of inHouse) {
      if (!b.room_id) { flags.push(`${bookingNumber(b.number)} ${b.guest_name} is checked in without a room`); continue; }
      if (b.departure <= date) { flags.push(`Room ${b.room_name}: ${b.guest_name} was due out on ${b.departure} and has not checked out`); }
      // Tonight's rate: as booked; a guest staying past their booking pays the last night's rate until the desk extends it.
      const night = b.nightly.find((n) => n.date === date) ?? (b.departure <= date ? b.nightly[b.nightly.length - 1] : undefined);
      if (!night) continue;
      const folio = (await tx.query<{ id: string }>('select id from hotel_folios where booking_id = $1 order by position limit 1', [b.id])).rows[0]!;
      const posted = await tx.query(
        "insert into hotel_folio_lines (id, tenant_id, booking_id, folio_id, business_date, kind, description, amount_cents, room_id, created_by) values ($1, $2, $3, $4, $5, 'room', $6, $7, $8, $9) on conflict do nothing returning id",
        [randomUUID(), tenantId, b.id, folio.id, date, `Room ${b.room_name}, night of ${date}`, night.cents, b.room_id, userId],
      );
      if (posted.rows.length) revenue += night.cents;
      await tx.query("update hotel_rooms set status = 'dirty', status_at = now(), status_note = null where id = $1 and status <> 'out_of_order'", [b.room_id]);
      await tx.query('insert into hotel_tasks (id, tenant_id, business_date, room_id, kind) values ($1, $2, $3, $4, $5) on conflict do nothing', [randomUUID(), tenantId, nextDate, b.room_id, b.departure <= nextDate ? 'departure' : 'stayover']);
    }
  });
  const rooms = (await db.query<{ id: string; name: string; status: string }>('select id, name, status from hotel_rooms where tenant_id = $1 and archived_at is null', [tenantId])).rows;
  const occupiedRooms = new Set(inHouse.map((b) => b.room_id).filter(Boolean));
  for (const r of rooms.filter((x) => x.status === 'out_of_order' && occupiedRooms.has(x.id))) flags.push(`Room ${r.name} is out of order but has a guest in it`);
  const dueIn = (await db.query<{ number: number; guest_name: string }>("select number, guest_name from hotel_bookings where tenant_id = $1 and status = 'booked' and arrival <= $2::date", [tenantId, date])).rows;
  for (const b of dueIn) flags.push(`${bookingNumber(b.number)} ${b.guest_name} was due in and did not arrive: mark it a no-show or move the booking`);
  const available = rooms.filter((r) => r.status !== 'out_of_order').length;
  const occupied = occupiedRooms.size;
  const day = (await db.query<{ arrivals: number; departures: number }>(
    "select count(*) filter (where (checked_in_at - interval '6 hours')::date <= $2::date and arrival = $2::date and status in ('in_house', 'checked_out'))::int as arrivals, count(*) filter (where status = 'checked_out' and departure = $2::date)::int as departures from hotel_bookings where tenant_id = $1", [tenantId, date],
  )).rows[0]!;
  const money2 = (await db.query<{ charges: unknown; payments: unknown }>(
    "select coalesce(sum(amount_cents) filter (where kind = 'charge'), 0) as charges, coalesce(-sum(amount_cents) filter (where kind in ('payment', 'deposit')), 0) as payments from hotel_folio_lines where tenant_id = $1 and business_date = $2", [tenantId, date],
  )).rows[0]!;
  // The last night of a month: its nights go on an invoice now, so they are in that month's returns.
  if (nextDate.slice(0, 7) !== date.slice(0, 7)) {
    for (const b of inHouse) {
      for (const f of (await db.query<{ id: string }>('select id from hotel_folios where booking_id = $1', [b.id])).rows) {
        try { await invoiceFolio(tenantId, b, f.id, userId, tax); } catch { flags.push(`${bookingNumber(b.number)}: the month-end invoice could not be issued`); }
      }
    }
  }
  const report: AuditReport = {
    date, nextDate, roomsAvailable: available, roomsOccupied: occupied, outOfOrder: rooms.length - available,
    occupancyPercent: available ? Math.round((occupied * 1000) / available) / 10 : 0,
    roomRevenue: money(revenue), hotelTax: money(percentCents(revenue, tax.hotelTaxPercent)),
    adr: money(occupied ? Math.round(revenue / occupied) : 0), revpar: money(available ? Math.round(revenue / available) : 0),
    arrivals: day.arrivals, departures: day.departures, inHouse: inHouse.length, guests: inHouse.reduce((a, b) => a + b.adults + b.children, 0),
    outletCharges: money(toBigInt(money2.charges)), payments: money(toBigInt(money2.payments)), flags,
  };
  await db.query('insert into hotel_audits (tenant_id, business_date, report, run_by) values ($1, $2, $3, $4)', [tenantId, date, JSON.stringify(report), userId]);
  await saveVenue(db, tenantId, { hotelDate: nextDate });
  return report;
}
