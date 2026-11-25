/**
 * Charging a sale to a hotel room. The sale becomes a tax invoice on the
 * account of the guest staying in that room, due at check-out, and a line on
 * their folio (ETD-MAPPING.md: the supply is documented when it is made).
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../api/errors.ts';
import { loadVenue } from './settings.ts';

export interface RoomCharge { bookingId: string; folioId: string; customerId: string; room: string; payment: { meansCode: string; dueDate: string; terms: string } }

export async function roomChargeTerms(db: Queryable, tenantId: string, body: { type: string; room?: { bookingId: string; folioId?: string } }): Promise<RoomCharge> {
  const b = (await db.query<{ id: string; status: string; customer_id: string | null; departure: string; room: string | null }>(
    'select b.id, b.status, b.customer_id, b.departure::text as departure, r.name as room from hotel_bookings b left join hotel_rooms r on r.id = b.room_id where b.id = $1 and b.tenant_id = $2', [body.room!.bookingId, tenantId],
  )).rows[0];
  if (!b) throw new ApiError(422, 'invalid_room_charge', 'That stay is not one of yours');
  if (b.status !== 'in_house' || !b.customer_id) throw new ApiError(409, 'not_in_house', 'Only a guest who is checked in can charge to their room');
  if (body.type !== '01' && body.type !== '02') throw new ApiError(422, 'invalid_room_charge', 'Only a sale is charged to a room');
  // The folio named, or the stay's "Extras" folio when it has one (the room is someone else's bill), else its first.
  const folios = (await db.query<{ id: string; name: string }>('select id, name from hotel_folios where booking_id = $1 order by position', [b.id])).rows;
  const folio = folios.find((f) => f.id === body.room!.folioId) ?? folios.find((f) => f.name.toLowerCase() === 'extras') ?? folios[0];
  if (!folio) throw new ApiError(422, 'invalid_room_charge', 'That stay has no folio');
  const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  return { bookingId: b.id, folioId: folio.id, customerId: b.customer_id, room: b.room ?? '', payment: { meansCode: '30', dueDate: b.departure < today ? today : b.departure, terms: `Charged to room ${b.room ?? ''}, due at check-out` } };
}

export async function postRoomCharge(db: Queryable, tenantId: string, room: RoomCharge, documentId: string, userId: string | null): Promise<void> {
  const doc = (await db.query<{ payable_cents: unknown; series_number: number; serial: string }>('select payable_cents, series_number, serial::text as serial from documents where id = $1 and tenant_id = $2', [documentId, tenantId])).rows[0]!;
  const venue = await loadVenue(db, tenantId);
  const date = venue.hotelDate ?? new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  await db.query(
    "insert into hotel_folio_lines (id, tenant_id, booking_id, folio_id, business_date, kind, description, amount_cents, document_id, created_by) values ($1, $2, $3, $4, $5, 'charge', $6, $7, $8, $9)",
    [randomUUID(), tenantId, room.bookingId, room.folioId, date, `Restaurant and bar, invoice ${String(doc.series_number).padStart(3, '0')}-${doc.serial.padStart(9, '0')}`, Number(doc.payable_cents), documentId, userId],
  );
}
