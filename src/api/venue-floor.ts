/**
 * Hospitality, front of house and the books: reservations and their
 * timeline, the waitlist, guest records, deposits, the day's close, the
 * server checkout, tip pooling, the reports, and the dated tax rules.
 *
 *   GET  /v1/venue/reservations?date=        the day's bookings, with the waitlist
 *   POST /v1/venue/reservations              PUT /v1/venue/reservations/:id
 *   POST /v1/venue/reservations/:id/seat | cancel | no-show | deposit | apply-deposit | message
 *   POST /v1/venue/waitlist                  POST /v1/venue/waitlist/:id/notify | seat | left
 *   GET  /v1/venue/guests?q=                 GET|PUT /v1/venue/guests/:id
 *   GET  /v1/venue/day                       POST /v1/venue/day/close
 *   GET  /v1/venue/checkout?userId&date      a server's checkout report
 *   GET  /v1/venue/tips?from&to              tips by server and the pool's distribution
 *   GET  /v1/venue/reports?from&to           sales by area, category, item, hour and server; covers; voids, comps, discounts; tenders; taxes
 *   GET|POST /v1/venue/tax-rules             dated tax configuration
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { type Mailer, simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { whatsappLink, whatsappNumber } from '../receivables/whatsapp.ts';
import { centsText } from '../venue/bill.ts';
import type { Check, CheckItem } from '../venue/check.ts';
import { applyOps } from '../venue/service.ts';
import { expectedMinutes, loadVenue, openBusinessDate, saveVenue, type VenueSettings } from '../venue/settings.ts';
import { TAX_KEYS, type TaxKey, taxRuleList, taxRules, validTaxValue } from '../venue/tax-rules.ts';
import type { ServerContext } from './context.ts';
import { issueFromBody } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission, type Role } from './permissions.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const addDay = (s: string, n = 1) => new Date(new Date(`${s}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** A Belize calendar day as a UTC range. */
const dayRange = (date: string) => [`${date}T06:00:00.000Z`, `${addDay(date)}T06:00:00.000Z`] as const;
const belizeTime = (d: Date | string) => new Date(new Date(d).getTime() - 6 * 3600_000).toISOString().slice(11, 16);
const belizeDay = (d: Date | string) => new Date(new Date(d).getTime() - 6 * 3600_000).toISOString().slice(0, 10);

interface ReservationRow {
  id: string; guest_id: string | null; name: string; phone: string | null; email: string | null; party_size: number; starts_at: Date | string; duration_min: number; table_ids: string[];
  status: 'booked' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'; occasion: string | null; allergy: string | null; notes: string | null; check_id: string | null; cancel_reason: string | null;
  deposit_cents: unknown; deposit_status: string | null;
}
const RESERVATION = `v.id, v.guest_id, v.name, v.phone, v.email, v.party_size, v.starts_at, v.duration_min, v.table_ids, v.status, v.occasion, v.allergy, v.notes, v.check_id, v.cancel_reason,
  (select d.amount_cents from venue_deposits d where d.ref_id = v.id and d.kind = 'table' and d.status <> 'refunded' order by d.created_at limit 1) as deposit_cents,
  (select d.status from venue_deposits d where d.ref_id = v.id and d.kind = 'table' order by d.created_at desc limit 1) as deposit_status`;
const reservationJson = (v: ReservationRow) => ({
  id: v.id, guestId: v.guest_id, name: v.name, phone: v.phone, email: v.email, partySize: v.party_size, startsAt: iso(v.starts_at)!, endsAt: new Date(new Date(v.starts_at).getTime() + v.duration_min * 60_000).toISOString(),
  durationMin: v.duration_min, tableIds: v.table_ids, status: v.status, occasion: v.occasion, allergy: v.allergy, notes: v.notes, checkId: v.check_id, cancelReason: v.cancel_reason,
  deposit: v.deposit_cents === null ? null : { amount: centsText(Number(v.deposit_cents)), status: v.deposit_status },
});

/** Find the guest by phone or email, or make a record of them. */
async function guestFor(db: Queryable, tenantId: string, g: { name: string; phone?: string | null; email?: string | null; allergy?: string | null }): Promise<string> {
  const phone = g.phone?.trim() || null;
  const email = g.email?.trim().toLowerCase() || null;
  const found = phone || email ? (await db.query<{ id: string }>(
    'select id from venue_guests where tenant_id = $1 and (($2::text is not null and phone = $2) or ($3::text is not null and lower(email) = $3)) order by created_at limit 1', [tenantId, phone, email],
  )).rows[0] : undefined;
  if (found) {
    if (g.allergy?.trim()) await db.query("update venue_guests set allergies = case when coalesce(allergies, '') ilike '%' || $2 || '%' then allergies else trim(both ', ' from coalesce(allergies, '') || ', ' || $2) end where id = $1", [found.id, g.allergy.trim()]);
    return found.id;
  }
  const id = randomUUID();
  await db.query('insert into venue_guests (id, tenant_id, name, phone, email, allergies) values ($1, $2, $3, $4, $5, $6)', [id, tenantId, g.name.trim(), phone, email, g.allergy?.trim() || null]);
  return id;
}

export function registerVenueFloorRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' }) as const;
  const opt = (max: number) => ({ type: 'string', maxLength: max }) as const;
  const floor = (request: FastifyRequest) => { if (!can(request.principal, 'venue.floor')) requirePermission(request, 'venue.orders'); };
  const host = (request: FastifyRequest) => requirePermission(request, 'venue.floor');
  const now = () => deps.now?.() ?? new Date();
  const actor = async (request: FastifyRequest, internal = false) => {
    const me = (await db.query<{ name: string }>('select name from users where id = $1', [request.userId])).rows[0];
    if (!me) throw new ApiError(403, 'forbidden', 'This is done by people, not API keys');
    const role = request.principal as Role;
    // Seating a party opens its check: a host may do that much.
    return { userId: request.userId, name: me.name, deviceId: request.posDevice?.id ?? null, mayApprove: can(role, 'venue.approve'), mayOrder: can(role, 'venue.orders') || can(role, 'venue.floor'), mayKitchen: false, internal };
  };

  // ---------- reservations ----------
  const loadReservation = async (tenantId: string, id: string) => {
    const v = (await db.query<ReservationRow>(`select ${RESERVATION} from venue_reservations v where v.id = $1 and v.tenant_id = $2`, [id, tenantId])).rows[0];
    if (!v) throw notFound('Reservation');
    return v;
  };
  /** No table is promised to two parties at once. */
  const clash = async (tenantId: string, tableIds: string[], startsAt: Date, durationMin: number, except?: string) => {
    if (!tableIds.length) return;
    const end = new Date(startsAt.getTime() + durationMin * 60_000);
    const other = (await db.query<{ name: string; starts_at: Date | string; table_ids: string[] }>(
      `select name, starts_at, table_ids from venue_reservations v where tenant_id = $1 and table_ids && $2::text[]
         and (status in ('booked', 'confirmed') or (status = 'seated' and exists (select 1 from venue_checks c where c.id = v.check_id and c.status in ('open', 'paid'))))
         and starts_at < $4 and starts_at + duration_min * interval '1 minute' > $3 and ($5::uuid is null or id <> $5) order by starts_at limit 1`,
      [tenantId, tableIds, startsAt.toISOString(), end.toISOString(), except ?? null],
    )).rows[0];
    if (other) throw new ApiError(409, 'clash', `That table is booked for ${other.name} at ${belizeTime(other.starts_at)}`);
  };

  const reservationBody = {
    type: 'object', required: ['name', 'partySize', 'startsAt'], additionalProperties: false,
    properties: {
      name: text(120), phone: opt(40), email: opt(254), partySize: { type: 'integer', minimum: 1, maximum: 200 }, startsAt: { type: 'string', format: 'date-time' },
      durationMin: { type: 'integer', minimum: 15, maximum: 720 }, tableIds: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', maxLength: 40 } },
      occasion: opt(80), allergy: opt(200), notes: opt(500), status: { type: 'string', enum: ['booked', 'confirmed'] },
    },
  } as const;
  type ReservationBody = { name: string; phone?: string; email?: string; partySize: number; startsAt: string; durationMin?: number; tableIds?: string[]; occasion?: string; allergy?: string; notes?: string; status?: 'booked' | 'confirmed' };

  const businessName = async (tenantId: string) => (await db.query<{ name: string; email: string; slug: string }>('select coalesce(trade_name, legal_name) as name, email, slug from tenants where id = $1', [tenantId])).rows[0]!;
  /** A confirmation or a reminder by email, when the guest gave one and the server can send. */
  const sendConfirmation = async (tenantId: string, v: ReservationRow, reminder: boolean) => {
    if (!v.email || !ctx.mailConfigured || !ctx.mailer) return false;
    await emailReservation(db, ctx.mailer, tenantId, v, reminder);
    return true;
  };

  app.get<{ Querystring: { date?: string } }>('/venue/reservations', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { date: dateSchema } } } }, async (request) => {
    floor(request);
    const date = request.query.date ?? belizeDay(now());
    const [from, to] = dayRange(date);
    const rows = (await db.query<ReservationRow>(`select ${RESERVATION} from venue_reservations v where v.tenant_id = $1 and v.starts_at >= $2 and v.starts_at < $3 order by v.starts_at`, [request.tenantId, from, to])).rows;
    const waiting = (await db.query<{ id: string; name: string; phone: string | null; party_size: number; quoted_min: number; notes: string | null; status: string; added_at: Date | string; notified_at: Date | string | null }>(
      "select id, name, phone, party_size, quoted_min, notes, status, added_at, notified_at from venue_waitlist where tenant_id = $1 and status in ('waiting', 'notified') order by added_at", [request.tenantId],
    )).rows;
    return {
      date, reservations: rows.map(reservationJson),
      waitlist: waiting.map((w) => ({ id: w.id, name: w.name, phone: w.phone, partySize: w.party_size, quotedMin: w.quoted_min, notes: w.notes, status: w.status, addedAt: iso(w.added_at)!, notifiedAt: iso(w.notified_at), waitedMin: Math.round((now().getTime() - new Date(w.added_at).getTime()) / 60_000) })),
    };
  });

  app.post<{ Body: ReservationBody }>('/venue/reservations', { schema: { body: reservationBody } }, async (request, reply) => {
    host(request);
    const venue = await loadVenue(db, request.tenantId);
    const b = request.body;
    const startsAt = new Date(b.startsAt);
    if (startsAt.getTime() < now().getTime() - 3 * 3600_000) throw new ApiError(422, 'invalid_reservation', 'That time has passed');
    const duration = b.durationMin ?? expectedMinutes(venue, b.partySize);
    await clash(request.tenantId, b.tableIds ?? [], startsAt, duration);
    const id = randomUUID();
    const guestId = await guestFor(db, request.tenantId, { name: b.name, phone: b.phone, email: b.email, allergy: b.allergy });
    await db.query('insert into venue_reservations (id, tenant_id, guest_id, name, phone, email, party_size, starts_at, duration_min, table_ids, status, occasion, allergy, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
      [id, request.tenantId, guestId, b.name.trim(), b.phone?.trim() || null, b.email?.trim() || null, b.partySize, startsAt.toISOString(), duration, b.tableIds ?? [], b.status ?? 'booked', b.occasion?.trim() || null, b.allergy?.trim() || null, b.notes?.trim() || null, request.userId || null]);
    const v = await loadReservation(request.tenantId, id);
    const emailed = await sendConfirmation(request.tenantId, v, false).catch(() => false);
    return reply.code(201).send({ ...reservationJson(v), confirmationEmailed: emailed });
  });

  app.put<{ Params: { id: string }; Body: Partial<ReservationBody> }>('/venue/reservations/:id', { schema: { params: idParams, body: { ...reservationBody, required: [] } } }, async (request) => {
    host(request);
    const cur = await loadReservation(request.tenantId, request.params.id);
    if (cur.status !== 'booked' && cur.status !== 'confirmed') throw new ApiError(409, 'closed', 'This reservation is finished');
    const b = request.body;
    const startsAt = new Date(b.startsAt ?? cur.starts_at);
    const duration = b.durationMin ?? cur.duration_min;
    const tables = b.tableIds ?? cur.table_ids;
    await clash(request.tenantId, tables, startsAt, duration, cur.id);
    await db.query('update venue_reservations set name = $2, phone = $3, email = $4, party_size = $5, starts_at = $6, duration_min = $7, table_ids = $8, status = $9, occasion = $10, allergy = $11, notes = $12 where id = $1',
      [cur.id, b.name?.trim() ?? cur.name, b.phone ?? cur.phone, b.email ?? cur.email, b.partySize ?? cur.party_size, startsAt.toISOString(), duration, tables, b.status ?? cur.status, b.occasion ?? cur.occasion, b.allergy ?? cur.allergy, b.notes ?? cur.notes]);
    return reservationJson(await loadReservation(request.tenantId, cur.id));
  });

  // A message for WhatsApp or SMS, written; whoever is at the desk sends it from their phone.
  app.post<{ Params: { id: string }; Body: { reminder?: boolean } | undefined }>('/venue/reservations/:id/message', { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { reminder: { type: 'boolean' } } } } }, async (request) => {
    host(request);
    const v = await loadReservation(request.tenantId, request.params.id);
    const number = whatsappNumber(v.phone);
    if (!number) throw new ApiError(422, 'no_phone', 'This booking has no phone number');
    const body = confirmationText((await businessName(request.tenantId)).name, v, request.body?.reminder === true);
    return { phone: `+${number}`, text: body, whatsapp: whatsappLink(number, body), sms: `sms:+${number}?body=${encodeURIComponent(body)}` };
  });

  /** Open a check for a party at a table, as the person seating them. */
  const seat = async (request: FastifyRequest, p: { tableId: string; tableName: string; partySize: number; name: string; serverId?: string; guestId?: string | null; reservationId?: string; allergy?: string | null }) => {
    const checkId = randomUUID();
    const done = await applyOps(db, request.tenantId, await actor(request), [{
      id: randomUUID(), checkId, type: 'open', at: now().toISOString(),
      payload: { kind: 'table', tableId: p.tableId, tableName: p.tableName, partySize: p.partySize, name: p.name, ...(p.serverId && { server: { id: p.serverId } }), ...(p.guestId && { guestId: p.guestId }), ...(p.reservationId && { reservationId: p.reservationId }), ...(p.allergy && { allergy: p.allergy }) },
    }], { now: now(), approvers: () => false });
    const r = done.results[0]!;
    if (!r.ok) throw new ApiError(409, r.code ?? 'refused', r.reason ?? 'The table could not be opened');
    return checkId;
  };
  const seatBody = { type: 'object', required: ['tableId', 'tableName'], additionalProperties: false, properties: { tableId: { type: 'string', minLength: 1, maxLength: 40 }, tableName: text(40), serverId: uuid, partySize: { type: 'integer', minimum: 1, maximum: 200 } } } as const;
  type SeatBody = { tableId: string; tableName: string; serverId?: string; partySize?: number };

  app.post<{ Params: { id: string }; Body: SeatBody }>('/venue/reservations/:id/seat', { schema: { params: idParams, body: seatBody } }, async (request) => {
    floor(request);
    const v = await loadReservation(request.tenantId, request.params.id);
    if (v.status !== 'booked' && v.status !== 'confirmed') throw new ApiError(409, 'closed', v.status === 'seated' ? 'This party is already seated' : 'This reservation is finished');
    const guest = v.guest_id ? (await db.query<{ allergies: string | null }>('select allergies from venue_guests where id = $1', [v.guest_id])).rows[0] : undefined;
    // What the booking says, and anything else on the guest's record (not the same thing twice).
    const known = guest?.allergies && !(v.allergy ?? '').toLowerCase().includes(guest.allergies.toLowerCase()) ? guest.allergies : null;
    const allergy = [v.allergy, known].filter(Boolean).join('; ') || null;
    const checkId = await seat(request, { tableId: request.body.tableId, tableName: request.body.tableName, partySize: request.body.partySize ?? v.party_size, name: v.name, serverId: request.body.serverId, guestId: v.guest_id, reservationId: v.id, allergy });
    await db.query("update venue_reservations set status = 'seated', check_id = $2, table_ids = array[$3::text] where id = $1", [v.id, checkId, request.body.tableId]);
    if (v.guest_id) await db.query('update venue_guests set visits = visits + 1, last_visit = $2 where id = $1', [v.guest_id, belizeDay(now())]);
    return { ...reservationJson(await loadReservation(request.tenantId, v.id)), checkId };
  });

  for (const [path, status] of [['cancel', 'cancelled'], ['no-show', 'no_show']] as const) {
    app.post<{ Params: { id: string }; Body: { reason?: string; refundDeposit?: boolean } | undefined }>(
      `/venue/reservations/:id/${path}`,
      { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { reason: opt(300), refundDeposit: { type: 'boolean' } } } } },
      async (request) => {
        host(request);
        const v = await loadReservation(request.tenantId, request.params.id);
        if (v.status !== 'booked' && v.status !== 'confirmed') throw new ApiError(409, 'closed', 'Only a booking that has not been seated');
        for (const d of (await db.query<{ id: string; document_id: string; amount_cents: unknown }>("select id, document_id, amount_cents from venue_deposits where ref_id = $1 and kind = 'table' and status = 'held'", [v.id])).rows) {
          if (request.body?.refundDeposit) {
            const net = Number((await db.query<{ c: unknown }>('select line_extension_cents as c from documents where id = $1', [d.document_id])).rows[0]!.c);
            const credit = await issueFromBody(deps, request.tenantId, {
              type: '04', reference: { documentId: d.document_id, reason: 'Booking cancelled: deposit returned' },
              lines: [{ description: `Deposit for a table for ${v.name} returned`, quantity: '1', unitCode: 'C62', unitPrice: centsText(net), gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Deposit returned' },
            }, request.userId || null, { accountLimit: 'skip' });
            await db.query("update venue_deposits set status = 'refunded', credit_document_id = $2, settled_at = now() where id = $1", [d.id, credit.documentId]);
          } else await db.query("update venue_deposits set status = 'kept', settled_at = now() where id = $1", [d.id]);
        }
        await db.query('update venue_reservations set status = $2, cancelled_at = now(), cancel_reason = $3 where id = $1', [v.id, status, request.body?.reason?.trim() || null]);
        if (status === 'no_show' && v.guest_id) await db.query('update venue_guests set no_shows = no_shows + 1 where id = $1', [v.guest_id]);
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `venue.reservation_${status}`, target: v.name, details: { reason: request.body?.reason ?? null }, ip: request.ip });
        return reservationJson(await loadReservation(request.tenantId, v.id));
      },
    );
  }

  // A deposit for a table: a tax receipt now (GST in it), taken off the bill when they eat.
  app.post<{ Params: { id: string }; Body: { amount: string; method: 'cash' | 'card' | 'bank_transfer' | 'online' } }>(
    '/venue/reservations/:id/deposit',
    { schema: { params: idParams, body: { type: 'object', required: ['amount', 'method'], additionalProperties: false, properties: { amount: { type: 'string', pattern: '^\\d{1,7}(\\.\\d{1,2})?$' }, method: { type: 'string', enum: ['cash', 'card', 'bank_transfer', 'online'] } } } } },
    async (request, reply) => {
      host(request);
      requirePermission(request, 'documents.issue');
      const v = await loadReservation(request.tenantId, request.params.id);
      if (v.status !== 'booked' && v.status !== 'confirmed') throw new ApiError(409, 'closed', 'Only a booking that has not been seated');
      if (v.deposit_cents !== null && v.deposit_status === 'held') throw new ApiError(409, 'has_deposit', 'This booking already has a deposit');
      // The amount is what the guest hands over, GST included: the line is that amount before GST.
      const tax = await taxRules(db, request.tenantId, now());
      const total = Math.round(Number(request.body.amount) * 100);
      const [whole, frac = ''] = tax.gstPercent.split('.');
      const rate = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
      const net = Math.round((total * 100000) / (100000 + rate));
      const means = { cash: '10', card: '48', bank_transfer: '30', online: '68' }[request.body.method];
      const result = await issueFromBody(deps, request.tenantId, {
        type: '02', lines: [{ description: `Deposit for a table for ${v.party_size} on ${longWhen(v.starts_at)}, ${v.name}`.slice(0, 200), quantity: '1', unitCode: 'C62', unitPrice: centsText(net), gstCategory: 'S' }],
        payment: { meansCode: means, terms: 'Deposit' },
      }, request.userId || null, { deviceId: request.posDevice?.id ?? null });
      if (result.status === 'rejected') throw new ApiError(409, 'rejected', 'BTS rejected the deposit receipt');
      const paid = Number((await db.query<{ c: unknown }>('select payable_cents as c from documents where id = $1', [result.documentId])).rows[0]!.c);
      await db.query("insert into venue_deposits (id, tenant_id, kind, ref_id, amount_cents, method, document_id, created_by) values ($1, $2, 'table', $3, $4, $5, $6, $7)", [randomUUID(), request.tenantId, v.id, paid, request.body.method, result.documentId, request.userId || null]);
      return reply.code(201).send({ documentId: result.documentId, ...reservationJson(await loadReservation(request.tenantId, v.id)) });
    },
  );
  // When the party's bill is made up: the deposit comes off it (before GST, which its own receipt already carries).
  app.post<{ Params: { id: string } }>('/venue/reservations/:id/apply-deposit', { schema: { params: idParams } }, async (request) => {
    floor(request);
    const v = await loadReservation(request.tenantId, request.params.id);
    const d = (await db.query<{ id: string; document_id: string }>("select id, document_id from venue_deposits where ref_id = $1 and kind = 'table' and status = 'held'", [v.id])).rows[0];
    if (!d || !v.check_id) throw new ApiError(409, 'no_deposit', v.check_id ? 'This booking has no deposit to use' : 'Seat the party first');
    const net = Number((await db.query<{ c: unknown }>('select line_extension_cents as c from documents where id = $1', [d.document_id])).rows[0]!.c);
    const done = await applyOps(db, request.tenantId, await actor(request, true), [{ id: randomUUID(), checkId: v.check_id, type: 'deposit', at: now().toISOString(), payload: { cents: net, documentId: d.document_id, reason: 'Deposit paid when booking' } }], { now: now(), approvers: () => false });
    if (!done.results[0]!.ok) throw new ApiError(409, 'refused', done.results[0]!.reason ?? 'The deposit could not be taken off');
    await db.query("update venue_deposits set status = 'applied', settled_at = now() where id = $1", [d.id]);
    return { applied: centsText(net), ...reservationJson(await loadReservation(request.tenantId, v.id)) };
  });

  // ---------- the waitlist ----------
  app.post<{ Body: { name: string; phone?: string; partySize: number; quotedMin?: number; notes?: string } }>(
    '/venue/waitlist',
    { schema: { body: { type: 'object', required: ['name', 'partySize'], additionalProperties: false, properties: { name: text(120), phone: opt(40), partySize: { type: 'integer', minimum: 1, maximum: 200 }, quotedMin: { type: 'integer', minimum: 0, maximum: 600 }, notes: opt(300) } } } },
    async (request, reply) => {
      floor(request);
      const b = request.body;
      const id = randomUUID();
      const guestId = b.phone?.trim() ? await guestFor(db, request.tenantId, { name: b.name, phone: b.phone }) : null;
      await db.query('insert into venue_waitlist (id, tenant_id, guest_id, name, phone, party_size, quoted_min, notes) values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, request.tenantId, guestId, b.name.trim(), b.phone?.trim() || null, b.partySize, b.quotedMin ?? 15, b.notes?.trim() || null]);
      return reply.code(201).send({ id });
    },
  );
  const waiting = async (tenantId: string, id: string) => {
    const w = (await db.query<{ id: string; guest_id: string | null; name: string; phone: string | null; party_size: number; status: string }>('select id, guest_id, name, phone, party_size, status from venue_waitlist where id = $1 and tenant_id = $2', [id, tenantId])).rows[0];
    if (!w) throw notFound('Party');
    if (w.status !== 'waiting' && w.status !== 'notified') throw new ApiError(409, 'closed', 'This party is no longer waiting');
    return w;
  };
  app.post<{ Params: { id: string } }>('/venue/waitlist/:id/notify', { schema: { params: idParams } }, async (request) => {
    floor(request);
    const w = await waiting(request.tenantId, request.params.id);
    await db.query("update venue_waitlist set status = 'notified', notified_at = now() where id = $1", [w.id]);
    const number = whatsappNumber(w.phone);
    const body = `${w.name}, your table at ${(await businessName(request.tenantId)).name} is ready. Please come to the host.`;
    return { status: 'notified', ...(number && { phone: `+${number}`, text: body, whatsapp: whatsappLink(number, body), sms: `sms:+${number}?body=${encodeURIComponent(body)}` }) };
  });
  app.post<{ Params: { id: string }; Body: SeatBody }>('/venue/waitlist/:id/seat', { schema: { params: idParams, body: seatBody } }, async (request) => {
    floor(request);
    const w = await waiting(request.tenantId, request.params.id);
    const guest = w.guest_id ? (await db.query<{ allergies: string | null }>('select allergies from venue_guests where id = $1', [w.guest_id])).rows[0] : undefined;
    const checkId = await seat(request, { tableId: request.body.tableId, tableName: request.body.tableName, partySize: request.body.partySize ?? w.party_size, name: w.name, serverId: request.body.serverId, guestId: w.guest_id, allergy: guest?.allergies ?? null });
    await db.query("update venue_waitlist set status = 'seated', ended_at = now(), check_id = $2 where id = $1", [w.id, checkId]);
    if (w.guest_id) await db.query('update venue_guests set visits = visits + 1, last_visit = $2 where id = $1', [w.guest_id, belizeDay(now())]);
    return { status: 'seated', checkId };
  });
  app.post<{ Params: { id: string } }>('/venue/waitlist/:id/left', { schema: { params: idParams } }, async (request) => {
    floor(request);
    const w = await waiting(request.tenantId, request.params.id);
    await db.query("update venue_waitlist set status = 'left', ended_at = now() where id = $1", [w.id]);
    return { status: 'left' };
  });

  // ---------- guests ----------
  const guestJson = (g: { id: string; name: string; phone: string | null; email: string | null; allergies: string | null; preferences: string | null; notes: string | null; visits: number; no_shows: number; last_visit: string | null }) =>
    ({ id: g.id, name: g.name, phone: g.phone, email: g.email, allergies: g.allergies, preferences: g.preferences, notes: g.notes, visits: g.visits, noShows: g.no_shows, lastVisit: g.last_visit });
  const GUEST = 'id, name, phone, email, allergies, preferences, notes, visits, no_shows, last_visit::text as last_visit';
  app.get<{ Querystring: { q?: string } }>('/venue/guests', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: opt(100) } } } }, async (request) => {
    floor(request);
    const q = request.query.q?.trim();
    const rows = (await db.query<Parameters<typeof guestJson>[0]>(
      `select ${GUEST} from venue_guests where tenant_id = $1 and ($2::text is null or name ilike '%' || $2 || '%' or phone ilike '%' || $2 || '%' or email ilike '%' || $2 || '%') order by last_visit desc nulls last, lower(name) limit 50`, [request.tenantId, q || null],
    )).rows;
    return { data: rows.map(guestJson) };
  });
  app.get<{ Params: { id: string } }>('/venue/guests/:id', { schema: { params: idParams } }, async (request) => {
    floor(request);
    const g = (await db.query<Parameters<typeof guestJson>[0]>(`select ${GUEST} from venue_guests where id = $1 and tenant_id = $2`, [request.params.id, request.tenantId])).rows[0];
    if (!g) throw notFound('Guest');
    const visits = (await db.query<{ number: number; business_date: string; state: Check }>("select number, business_date::text as business_date, state from venue_checks where tenant_id = $1 and state ->> 'guestId' = $2 order by opened_at desc limit 20", [request.tenantId, g.id])).rows;
    const bookings = (await db.query<{ starts_at: Date | string; party_size: number; status: string; occasion: string | null }>('select starts_at, party_size, status, occasion from venue_reservations where guest_id = $1 order by starts_at desc limit 20', [g.id])).rows;
    const stays = (await db.query<{ arrival: string; departure: string; status: string; room: string | null }>('select b.arrival::text as arrival, b.departure::text as departure, b.status, r.name as room from hotel_bookings b left join hotel_rooms r on r.id = b.room_id where b.guest_id = $1 order by b.arrival desc limit 20', [g.id])).rows;
    return {
      ...guestJson(g),
      history: visits.map((v) => ({ date: v.business_date, table: v.state.tableName ?? v.state.name, partySize: v.state.partySize, ordered: v.state.items.filter((i) => i.status !== 'void').slice(0, 12).map((i) => i.name) })),
      reservations: bookings.map((b) => ({ at: iso(b.starts_at), partySize: b.party_size, status: b.status, occasion: b.occasion })),
      stays,
    };
  });
  app.put<{ Params: { id: string }; Body: { name?: string; phone?: string; email?: string; allergies?: string; preferences?: string; notes?: string } }>(
    '/venue/guests/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { name: text(120), phone: opt(40), email: opt(254), allergies: opt(300), preferences: opt(500), notes: opt(1000) } } } },
    async (request) => {
      floor(request);
      const b = request.body;
      const r = await db.query<Parameters<typeof guestJson>[0]>(
        `update venue_guests set name = coalesce($3, name), phone = coalesce($4, phone), email = coalesce($5, email), allergies = coalesce($6, allergies), preferences = coalesce($7, preferences), notes = coalesce($8, notes) where id = $1 and tenant_id = $2 returning ${GUEST}`,
        [request.params.id, request.tenantId, b.name?.trim() ?? null, b.phone ?? null, b.email ?? null, b.allergies ?? null, b.preferences ?? null, b.notes ?? null],
      );
      if (!r.rows.length) throw notFound('Guest');
      return guestJson(r.rows[0]!);
    },
  );

  // ---------- reports ----------
  const reportQuery = { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema, serverId: uuid } } as const;
  app.get<{ Querystring: { from: string; to: string; serverId?: string } }>('/venue/reports', { schema: { querystring: reportQuery } }, async (request) => {
    requirePermission(request, 'reports.view');
    if (request.query.from > request.query.to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
    return venueReport(db, request.tenantId, request.query.from, request.query.to, request.query.serverId);
  });
  app.get<{ Querystring: { from: string; to: string } }>('/venue/tips', { schema: { querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema } } } }, async (request) => {
    requirePermission(request, 'reports.view');
    return tipReport(db, request.tenantId, await loadVenue(db, request.tenantId), request.query.from, request.query.to);
  });
  // A server's checkout: their own, or anyone's for a supervisor.
  app.get<{ Querystring: { userId?: string; date?: string } }>('/venue/checkout', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { userId: uuid, date: dateSchema } } } }, async (request) => {
    const userId = request.query.userId ?? request.userId;
    if (userId !== request.userId && !can(request.principal, 'venue.approve')) requirePermission(request, 'reports.view');
    else if (!can(request.principal, 'venue.orders')) requirePermission(request, 'reports.view');
    const venue = await loadVenue(db, request.tenantId);
    return serverCheckout(db, request.tenantId, userId, request.query.date ?? openBusinessDate(venue, now()));
  });

  // ---------- the end of the day ----------
  const dayState = async (tenantId: string, venue: VenueSettings) => {
    const date = openBusinessDate(venue, now());
    const open = (await db.query<{ number: number; state: Check }>("select number, state from venue_checks where tenant_id = $1 and status in ('open', 'paid') order by opened_at", [tenantId])).rows;
    const shifts = (await db.query<{ id: string; number: number; register: string; opened_by: string }>('select s.id, s.number, r.name as register, u.name as opened_by from register_shifts s join registers r on r.id = s.register_id join users u on u.id = s.opened_by where s.tenant_id = $1 and s.closed_at is null order by s.opened_at', [tenantId])).rows;
    const stuck = Number((await db.query<{ n: unknown }>("select count(*) as n from venue_tickets where tenant_id = $1 and status in ('queued', 'failed') and created_at > now() - interval '24 hours'", [tenantId])).rows[0]!.n);
    return {
      businessDate: date, closedThrough: venue.closedThrough,
      openTables: open.filter((c) => c.state.kind === 'table').map((c) => ({ id: c.state.id, number: c.number, table: c.state.tableName, server: c.state.server.name, status: c.state.status, openedAt: c.state.openedAt })),
      openTabs: open.filter((c) => c.state.kind !== 'table').map((c) => ({ id: c.state.id, number: c.number, name: c.state.name ?? 'Tab', server: c.state.server.name, openedAt: c.state.openedAt })),
      openShifts: shifts.map((s) => ({ id: s.id, number: s.number, register: s.register, openedBy: s.opened_by })),
      ticketsNotPrinted: stuck,
    };
  };
  app.get('/venue/day', async (request) => {
    if (!can(request.principal, 'venue.approve')) requirePermission(request, 'reports.view');
    return dayState(request.tenantId, await loadVenue(db, request.tenantId));
  });
  app.post<{ Body: { carryOver?: boolean } | undefined }>('/venue/day/close', { schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { carryOver: { type: 'boolean' } } } } }, async (request) => {
    requirePermission(request, 'venue.approve');
    const venue = await loadVenue(db, request.tenantId);
    const state = await dayState(request.tenantId, venue);
    // Shifts are closed first, each with its blind count: the day report needs their figures.
    if (state.openShifts.length) throw new ApiError(409, 'open_shifts', `${state.openShifts.length === 1 ? 'A shift is' : `${state.openShifts.length} shifts are`} still open: close ${state.openShifts.length === 1 ? 'it' : 'them'} first (${state.openShifts.map((s) => s.register).join(', ')})`);
    const open = [...state.openTables.filter((t) => t.status === 'open'), ...state.openTabs];
    if (open.length && !request.body?.carryOver) throw new ApiError(409, 'open_checks', `${open.length} ${open.length === 1 ? 'table or tab is' : 'tables and tabs are'} still open. Close them, or carry them over to tomorrow.`);
    const date = state.businessDate;
    const next = addDay(date);
    const report = await venueReport(db, request.tenantId, date, date);
    await db.transaction(async (tx) => {
      // Tables paid and not yet cleaned are simply closed; open ones carried over belong to tomorrow.
      await tx.query("update venue_checks set status = 'closed', closed_at = now(), state = jsonb_set(state, '{status}', '\"closed\"'), seq = (select venue_seq + 1 from tenants where id = $1) where tenant_id = $1 and status = 'paid'", [request.tenantId]);
      await tx.query("update venue_checks set business_date = $2::date, state = jsonb_set(state, '{businessDate}', to_jsonb($3::text)), seq = (select venue_seq + 1 from tenants where id = $1) where tenant_id = $1 and status = 'open'", [request.tenantId, next, next]);
      await tx.query('update tenants set venue_seq = venue_seq + 1 where id = $1', [request.tenantId]);
      await tx.query('insert into venue_days (tenant_id, business_date, closed_by, report) values ($1, $2, $3, $4) on conflict (tenant_id, business_date) do update set report = excluded.report, closed_at = now(), closed_by = excluded.closed_by', [request.tenantId, date, request.userId || null, JSON.stringify(report)]);
    });
    await saveVenue(db, request.tenantId, { closedThrough: date, menuOverride: null });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'venue.day_closed', target: date, details: { carriedOver: open.length }, ip: request.ip });
    return { closed: date, businessDate: next, carriedOver: open.length, report };
  });

  // ---------- tax rules ----------
  app.get('/venue/tax-rules', async (request) => {
    requirePermission(request, 'reports.view');
    return { data: await taxRuleList(db, request.tenantId, now()) };
  });
  app.post<{ Body: { key: TaxKey; value: string; from: string; note?: string } }>(
    '/venue/tax-rules',
    { schema: { body: { type: 'object', required: ['key', 'value', 'from'], additionalProperties: false, properties: { key: { type: 'string', enum: [...TAX_KEYS] }, value: { type: 'string', maxLength: 20 }, from: dateSchema, note: opt(300) } } } },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      if (!validTaxValue(b.key, b.value)) throw new ApiError(422, 'invalid_tax_rule', 'That is not a value this rule can have');
      await db.query('insert into venue_tax_rules (id, tenant_id, key, value, valid_from, note, created_by) values ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), request.tenantId, b.key, b.value, b.from, b.note?.trim() || null, request.userId || null]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'venue.tax_rule', target: b.key, details: { value: b.value, from: b.from, note: b.note ?? null }, ip: request.ip });
      return reply.code(201).send({ data: await taxRuleList(db, request.tenantId, now()) });
    },
  );
}

// ---------- the figures ----------

const live = (i: CheckItem) => i.status !== 'void';
/** What an item has brought in so far, from what its payments recorded: before GST, without the service charge. */
const paidNet = (i: CheckItem) => i.paid.reduce((a, p) => a + (p.grossCents ?? 0) - (p.allowCents ?? 0), 0);
const paidService = (i: CheckItem) => i.paid.reduce((a, p) => a + (p.serviceCents ?? 0), 0);
const fullValue = (i: CheckItem) => (i.unitCents + i.modifiers.reduce((a, m) => a + m.priceCents, 0)) * i.quantity;
const bump = <K>(m: Map<K, { count: number; cents: number }>, k: K, cents: number, count = 1) => { const v = m.get(k) ?? { count: 0, cents: 0 }; v.count += count; v.cents += cents; m.set(k, v); };
const rows = <K extends string>(m: Map<K, { count: number; cents: number }>) => [...m.entries()].map(([name, v]) => ({ name, count: v.count, amount: centsText(v.cents) })).sort((a, b) => Number(b.amount) - Number(a.amount));

async function checksIn(db: Queryable, tenantId: string, from: string, to: string, serverId?: string) {
  return (await db.query<{ number: number; state: Check; closed_at: Date | string | null }>(
    'select number, state, closed_at from venue_checks where tenant_id = $1 and business_date between $2::date and $3::date and ($4::uuid is null or server_id = $4) order by opened_at limit 20000', [tenantId, from, to, serverId ?? null],
  )).rows;
}

/** Sales and service figures for a range of business days, from the checks themselves, tied back to the tax documents they were paid on. */
export async function venueReport(db: Queryable, tenantId: string, from: string, to: string, serverId?: string) {
  const checks = await checksIn(db, tenantId, from, to, serverId);
  const plans = (await db.query<{ area: string; items: Array<{ id: string }> }>('select area, items from venue_floor_plans where tenant_id = $1', [tenantId])).rows;
  const areaOf = (c: Check) => (c.kind !== 'table' ? (c.kind === 'tab' ? 'Bar tabs' : 'Quick sales') : plans.find((p) => p.items.some((i) => i.id === c.tableId))?.area ?? 'Other');
  const byArea = new Map<string, { count: number; cents: number }>();
  const byCategory = new Map<string, { count: number; cents: number }>();
  const byItem = new Map<string, { count: number; cents: number; itemId: string | null }>();
  const byHour = new Map<string, { count: number; cents: number }>();
  const byServer = new Map<string, { count: number; cents: number }>();
  const voids = new Map<string, { count: number; cents: number }>();
  const comps = new Map<string, { count: number; cents: number }>();
  const discounts = new Map<string, { count: number; cents: number }>();
  const tips = new Map<string, { count: number; cents: number }>();
  const docs = new Set<string>();
  let covers = 0; let tableChecks = 0; let turnMin = 0; let turned = 0; let net = 0; let service = 0;
  for (const { state: c, closed_at } of checks) {
    if (c.status === 'merged') continue;
    const mine = c.items.filter(live).reduce((a, i) => a + paidNet(i), 0);
    if (c.kind === 'table') {
      covers += c.partySize;
      tableChecks += 1;
      if (closed_at) { turnMin += (new Date(closed_at).getTime() - new Date(c.openedAt).getTime()) / 60_000; turned += 1; }
    }
    bump(byArea, areaOf(c), mine);
    bump(byServer, c.server.name, mine);
    for (const i of c.items) {
      if (i.voided?.afterSend) bump(voids, `${i.voided.by.name}: ${i.voided.reason}`, fullValue(i));
      if (!live(i)) continue;
      const n = paidNet(i);
      net += n;
      service += paidService(i);
      bump(byCategory, i.category ?? 'No category', n, i.quantity);
      const item = byItem.get(i.name) ?? { count: 0, cents: 0, itemId: i.itemId };
      item.count += i.quantity; item.cents += n;
      byItem.set(i.name, item);
      if (i.sentAt ?? i.addedAt) bump(byHour, `${belizeTime(i.sentAt ?? i.addedAt).slice(0, 2)}:00`, n, i.quantity);
      if (i.comp) bump(comps, `${i.comp.by.name}: ${i.comp.reason}`, fullValue(i));
      if (i.discount) bump(discounts, `${i.discount.by.name}: ${i.discount.reason}`, i.discount.percent ? Math.round((fullValue(i) * i.discount.percent) / 100) : i.discount.cents ?? 0);
      for (const p of i.paid) docs.add(p.documentId);
    }
    for (const t of c.tips) bump(tips, t.server.name, t.cents);
  }
  // The documents those payments went on: what was taken, how, and the GST on them.
  const ids = [...docs].filter((d) => /^[0-9a-f-]{36}$/i.test(d));
  const issued = ids.length ? (await db.query<{ id: string; etd_type: string; payable_cents: unknown; gst_cents: unknown; line_extension_cents: unknown; payment_means: string | null; tenders: Array<{ means: string; cents: string | number }> | null; status: string }>(
    'select id, etd_type, payable_cents, gst_cents, line_extension_cents, payment_means, tenders, status from documents where tenant_id = $1 and id = any($2::uuid[])', [tenantId, ids],
  )).rows : [];
  const MEANS: Record<string, string> = { '10': 'Cash', '48': 'Card', '30': 'Transfer', '68': 'Wallet', '20': 'Cheque', '1': 'Gift card' };
  const tenders = new Map<string, { count: number; cents: number }>();
  let gst = 0; let documentsNet = 0;
  for (const d of issued) {
    if (d.status === 'rejected' || d.status === 'cancelled') continue;
    gst += Number(d.gst_cents);
    documentsNet += Number(d.line_extension_cents);
    if (d.etd_type === '01') bump(tenders, 'Charged to a room or account', Number(d.payable_cents));
    else if (d.tenders?.length) for (const part of d.tenders) bump(tenders, MEANS[part.means] ?? 'Other', Number(part.cents));
    else bump(tenders, MEANS[d.payment_means ?? ''] ?? 'Other', Number(d.payable_cents));
  }
  // What each item costs to make: its recipe at today's average costs, or its own average cost.
  const itemIds = [...new Set([...byItem.values()].map((v) => v.itemId).filter((x): x is string => Boolean(x)))];
  const costs = itemIds.length ? (await db.query<{ id: string; cost: string | null }>(
    `select i.id, coalesce((select sum(c.quantity * m.average_cost) from item_components c join items m on m.id = c.component_id where c.item_id = i.id), i.average_cost)::text as cost from items i where i.tenant_id = $1 and i.id = any($2::uuid[])`, [tenantId, itemIds],
  )).rows : [];
  const hotel = (await db.query<{ report: { roomsAvailable: number; roomsOccupied: number; roomRevenue: string; hotelTax: string } }>('select report from hotel_audits where tenant_id = $1 and business_date between $2::date and $3::date', [tenantId, from, to])).rows.map((r) => r.report);
  const roomNights = hotel.reduce((a, h) => a + h.roomsOccupied, 0);
  const available = hotel.reduce((a, h) => a + h.roomsAvailable, 0);
  const roomRevenue = hotel.reduce((a, h) => a + Math.round(Number(h.roomRevenue) * 100), 0);
  return {
    period: { from, to },
    sales: { net: centsText(net), serviceCharge: centsText(service), checks: checks.filter((c) => c.state.status !== 'merged').length },
    covers: { covers, tables: tableChecks, averagePerCover: centsText(covers ? Math.round(net / covers) : 0), averageTurnMinutes: turned ? Math.round(turnMin / turned) : null },
    byArea: rows(byArea), byCategory: rows(byCategory), byServer: rows(byServer),
    byHour: [...byHour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([hour, v]) => ({ hour, items: v.count, amount: centsText(v.cents) })),
    byItem: [...byItem.entries()].map(([name, v]) => {
      const unitCost = v.itemId ? costs.find((c) => c.id === v.itemId)?.cost : null;
      const cost = unitCost === null || unitCost === undefined ? null : Math.round(Number(unitCost) * 100 * v.count);
      return { name, quantity: v.count, amount: centsText(v.cents), cost: cost === null ? null : centsText(cost), margin: cost === null ? null : centsText(v.cents - cost), marginPercent: cost === null || !v.cents ? null : Math.round(((v.cents - cost) * 1000) / v.cents) / 10 };
    }).sort((a, b) => Number(b.amount) - Number(a.amount)),
    voids: rows(voids), comps: rows(comps), discounts: rows(discounts),
    tips: { total: centsText([...tips.values()].reduce((a, v) => a + v.cents, 0)), byServer: rows(tips) },
    tenders: rows(tenders),
    taxes: { gst: centsText(gst), documents: issued.filter((d) => d.status !== 'rejected' && d.status !== 'cancelled').length, documentsNet: centsText(documentsNet), hotelTax: centsText(hotel.reduce((a, h) => a + Math.round(Number(h.hotelTax) * 100), 0)) },
    hotel: hotel.length ? { nights: hotel.length, roomNights, occupancyPercent: available ? Math.round((roomNights * 1000) / available) / 10 : 0, roomRevenue: centsText(roomRevenue), adr: centsText(roomNights ? Math.round(roomRevenue / roomNights) : 0), revpar: centsText(available ? Math.round(roomRevenue / available) : 0) } : null,
  };
}

/** What a server hands in at the end of their shift. */
export async function serverCheckout(db: Queryable, tenantId: string, userId: string, date: string) {
  const who = (await db.query<{ name: string }>('select name from users where id = $1 and tenant_id = $2', [userId, tenantId])).rows[0];
  if (!who) throw notFound('Person');
  const report = await venueReport(db, tenantId, date, date, userId);
  const checks = await checksIn(db, tenantId, date, date, userId);
  const open = checks.filter((c) => c.state.status === 'open');
  const cash = Math.round(Number(report.tenders.find((t) => t.name === 'Cash')?.amount ?? 0) * 100);
  // Tips left on cards and wallets are the server's: paid to them out of the cash they hold.
  const tipsOwed = checks.flatMap((c) => c.state.tips).filter((t) => t.means !== '10').reduce((a, t) => a + t.cents, 0);
  return {
    server: { id: userId, name: who.name }, businessDate: date,
    sales: report.sales, covers: report.covers, tenders: report.tenders, tips: report.tips, voids: report.voids, comps: report.comps, discounts: report.discounts,
    openChecks: open.map((c) => ({ id: c.state.id, number: c.number, name: c.state.tableName ?? c.state.name ?? 'Tab' })),
    cashTaken: centsText(cash), tipsToPayOut: centsText(tipsOwed), cashDue: centsText(cash - tipsOwed),
  };
}

/** Tips by who served, and how the pool is shared by the venue's rule. Figures only: paying staff is not this system's job. */
export async function tipReport(db: Queryable, tenantId: string, venue: VenueSettings, from: string, to: string) {
  const checks = await checksIn(db, tenantId, from, to);
  const taken = new Map<string, number>();
  for (const c of checks) for (const t of c.state.tips) taken.set(t.server.id, (taken.get(t.server.id) ?? 0) + t.cents);
  const pool = [...taken.values()].reduce((a, v) => a + v, 0);
  const staff = (await db.query<{ id: string; name: string; role: string }>("select id, name, role from users where tenant_id = $1 and status = 'active'", [tenantId])).rows;
  // Hours from the time clock, by the Belize day they were worked.
  const hours = new Map((await db.query<{ user_id: string; h: string }>(
    `select user_id, (sum(extract(epoch from (coalesce(clock_out, now()) - clock_in))) / 3600)::text as h from time_entries
     where tenant_id = $1 and (clock_in - interval '6 hours')::date between $2::date and $3::date group by user_id`, [tenantId, from, to],
  )).rows.map((r) => [r.user_id, Math.round(Number(r.h) * 100) / 100]));
  const { method, weights } = venue.tipPool;
  // Each person's weight in the pool.
  const weight = (p: { id: string; role: string }): number => {
    const h = hours.get(p.id) ?? 0;
    if (method === 'hours') return Object.keys(weights).length && !(p.role in weights) ? 0 : h;
    if (method === 'points') return (weights[p.role] ?? 0) * h;
    return 0;
  };
  const shares = new Map<string, number>();
  if (method === 'role') {
    // Each role's percent of the pool, split evenly among those of the role who worked (clocked in), or all of them if nobody clocked in.
    for (const [role, percent] of Object.entries(weights)) {
      const all = staff.filter((p) => p.role === role);
      const worked = all.filter((p) => (hours.get(p.id) ?? 0) > 0);
      const among = worked.length ? worked : all;
      const slice = Math.floor((pool * percent) / 100);
      among.forEach((p, n) => shares.set(p.id, (shares.get(p.id) ?? 0) + Math.floor(slice / among.length) + (n < slice % among.length ? 1 : 0)));
    }
  } else if (method === 'hours' || method === 'points') {
    const total = staff.reduce((a, p) => a + weight(p), 0);
    if (total > 0) {
      let left = pool;
      const in_ = staff.filter((p) => weight(p) > 0);
      in_.forEach((p, n) => { const s = n === in_.length - 1 ? left : Math.floor((pool * weight(p)) / total); left -= s; shares.set(p.id, s); });
    }
  } else for (const [id, cents] of taken) shares.set(id, cents);
  const shared = [...shares.values()].reduce((a, v) => a + v, 0);
  return {
    period: { from, to }, method, pool: centsText(pool), shared: centsText(shared), notShared: centsText(pool - shared),
    people: staff.filter((p) => taken.has(p.id) || shares.has(p.id) || hours.has(p.id)).map((p) => ({ id: p.id, name: p.name, role: p.role, hours: hours.get(p.id) ?? 0, tipsTaken: centsText(taken.get(p.id) ?? 0), share: centsText(shares.get(p.id) ?? 0) }))
      .sort((a, b) => Number(b.share) - Number(a.share)),
  };
}

const longWhen = (d: Date | string) => `${new Date(new Date(d).getTime() - 6 * 3600_000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} at ${belizeTime(d)}`;
const confirmationText = (biz: string, v: { name: string; party_size: number; starts_at: Date | string }, reminder = false) =>
  `${reminder ? 'A reminder of' : 'We have'} your table at ${biz}: ${v.party_size} ${v.party_size === 1 ? 'guest' : 'guests'}, ${longWhen(v.starts_at)}, in the name of ${v.name}. If your plans change, please let us know.`;

/** A confirmation or a reminder of a table booking, by email. */
async function emailReservation(db: Queryable, mailer: Mailer, tenantId: string, v: Pick<ReservationRow, 'id' | 'name' | 'email' | 'party_size' | 'starts_at'>, reminder: boolean): Promise<void> {
  const biz = (await db.query<{ name: string; email: string }>('select coalesce(trade_name, legal_name) as name, email from tenants where id = $1', [tenantId])).rows[0]!;
  const line = confirmationText(biz.name, v, reminder);
  await mailer.send({ type: 'reservation', tenantId, to: v.email!, subject: `${biz.name}: your table on ${longWhen(v.starts_at)}`, text: `${line}

${biz.name}`, html: simpleHtml({ heading: reminder ? 'See you soon' : 'Your table is booked', paragraphs: [line], footer: [biz.name] }), replyTo: biz.email });
  await db.query(`update venue_reservations set ${reminder ? 'reminder_sent_at' : 'confirmation_sent_at'} = now() where id = $1`, [v.id]);
}

/** The day before: guests with a table tomorrow and an email get one reminder (housekeeping). */
export async function runReservationReminders(db: Queryable, mailer: Mailer, at = new Date()): Promise<number> {
  const due = (await db.query<{ tenant_id: string; id: string; name: string; email: string; party_size: number; starts_at: Date | string }>(
    `select tenant_id, id, name, email, party_size, starts_at from venue_reservations where status in ('booked', 'confirmed') and email is not null and reminder_sent_at is null and starts_at > $1 and starts_at < $2 limit 500`,
    [new Date(at.getTime() + 2 * 3600_000).toISOString(), new Date(at.getTime() + 26 * 3600_000).toISOString()],
  )).rows;
  let n = 0;
  for (const v of due) { try { await emailReservation(db, mailer, v.tenant_id, v, true); n++; } catch { /* the next run tries again */ } }
  return n;
}
