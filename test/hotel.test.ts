/**
 * The hotel: rates by season and weekend, availability and clashes, a stay
 * from booking to check-out (deposit, check-in, charges to the room, a room
 * move, the night audit each night, the folio paid in two parts), split
 * folios, housekeeping, and the documents and taxes that come out of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightRate, nightsOf, roomLines } from '../src/api/hotel.ts';
import { call, type VenueCtx, withVenue } from './venue-helpers.ts';

const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const plus = (n: number, from = today()) => new Date(new Date(`${from}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const hotelOn = { hotel: true, restaurant: true };

async function hotelSetup(c: VenueCtx) {
  const type = await call(c, 'POST', '/v1/hotel/room-types', { name: 'Garden room', capacity: 2, rateCents: 20000, minStay: 1, features: ['Fan', 'Garden view'] });
  assert.equal(type.statusCode, 201, type.body);
  const suite = (await call(c, 'POST', '/v1/hotel/room-types', { name: 'Sea suite', capacity: 4, rateCents: 15000, usd: true, minStay: 2 })).json();
  const rooms: Record<string, string> = {};
  for (const [name, t] of [['101', type.json().id], ['102', type.json().id], ['201', suite.id]] as const) {
    const r = await call(c, 'POST', '/v1/hotel/rooms', { name, roomTypeId: t });
    assert.equal(r.statusCode, 201, r.body);
    rooms[name] = r.json().id;
  }
  return { garden: type.json().id as string, suite: suite.id as string, rooms };
}
const doc = async (c: VenueCtx, id: string) => (await call(c, 'GET', `/v1/documents/${id}`)).json();

test('rates: the season that covers the night, weekends their own, US dollars at the venue’s rate; nights grouped on the invoice', () => {
  const type = { rate_cents: 20000, weekend_rate_cents: 24000, usd: false };
  const seasons = [
    { id: 's1', room_type_id: 't', name: 'High', starts_on: '2026-12-15', ends_on: '2027-04-15', rate_cents: 30000, weekend_rate_cents: null, min_stay: 3 },
    { id: 's2', room_type_id: 't', name: 'Christmas', starts_on: '2026-12-22', ends_on: '2027-01-02', rate_cents: 40000, weekend_rate_cents: 45000, min_stay: 5 },
  ];
  // 2026-11-27 is a Friday.
  assert.equal(nightRate(type, seasons, '2026-11-26', 200), 20000);
  assert.equal(nightRate(type, seasons, '2026-11-27', 200), 24000);
  assert.equal(nightRate(type, seasons, '2026-11-29', 200), 20000);
  assert.equal(nightRate(type, seasons, '2026-12-16', 200), 30000, 'in season, a weekday');
  assert.equal(nightRate(type, seasons, '2026-12-18', 200), 30000, 'the season has no weekend rate: its rate');
  assert.equal(nightRate(type, seasons, '2026-12-25', 200), 45000, 'the season that started last wins; a Friday');
  assert.equal(nightRate({ rate_cents: 15000, weekend_rate_cents: null, usd: true }, [], '2026-11-26', 200), 30000, 'US$150 is BZ$300');
  assert.deepEqual(nightsOf('2026-11-30', '2026-12-03'), ['2026-11-30', '2026-12-01', '2026-12-02']);
  const tax = { gstPercent: '12.5', hotelTaxPercent: '9', accommodationGst: 'exempt' as const, accommodationExemptionCode: 'HOTEL', serviceChargeGst: true, serviceChargeHotelTax: false, unverified: [] };
  const lines = roomLines([{ date: '2026-12-01', cents: 20000, room: '101' }, { date: '2026-12-02', cents: 20000, room: '101' }, { date: '2026-12-03', cents: 20000, room: '102' }, { date: '2026-12-04', cents: 24000, room: '102' }], 'Garden room', tax);
  assert.deepEqual(lines.map((l) => [l.quantity, l.unitPrice, l.gstCategory, l.exemptionReasonCode, l.allowanceCharges[0]!.amount]), [['2', '200.00', 'E', 'HOTEL', '36.00'], ['1', '200.00', 'E', 'HOTEL', '18.00'], ['1', '240.00', 'E', 'HOTEL', '21.60']]);
  assert.match(lines[0]!.description, /^Room 101 \(Garden room\), 2 nights from 2026-12-01$/);
  assert.equal(roomLines([{ date: '2026-12-01', cents: 20000, room: '101' }], 'Garden room', { ...tax, accommodationGst: 'standard' })[0]!.gstCategory, 'S');
});

test('a stay: booked with a deposit, checked in, dinner and bar charged to the room, a room move, the night audit each night, checked out paid in two parts', () =>
  withVenue(async (c) => {
    const { garden, suite, rooms } = await hotelSetup(c);
    const arrival = today();
    const departure = plus(3);
    // What is free, and what the stay costs, in both currencies.
    const avail = (await call(c, 'GET', `/v1/hotel/availability?arrival=${arrival}&departure=${departure}`)).json().data;
    const g = avail.find((a: { roomType: { id: string } }) => a.roomType.id === garden);
    assert.deepEqual([g.free.length, g.nightly.length], [2, 3]);
    assert.equal(Number(g.totalUsd) * 2, Number(g.total));
    // The suite is sold for two nights or more.
    assert.equal((await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Short Stay', roomTypeId: suite, arrival, departure: plus(1) })).json().error.code, 'min_stay');

    const booked = await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Maya Young', phone: '610-2222', email: 'maya@example.com', roomTypeId: garden, roomId: rooms['101'], arrival, departure, adults: 2, source: 'website', rateCents: 20000, policy: 'Free cancellation until 7 days before' });
    assert.equal(booked.statusCode, 201, booked.body);
    const id = booked.json().id as string;
    assert.deepEqual([booked.json().number, booked.json().status, booked.json().nights, booked.json().roomTotal, booked.json().room.name], ['H-0001', 'booked', 3, '600.00', '101']);
    // The room is taken for those nights: a second booking of it clashes; the other room of the type is free.
    assert.equal((await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Clash', roomTypeId: garden, roomId: rooms['101'], arrival: plus(2), departure: plus(4) })).json().error.code, 'room_taken');
    const second = await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Other Guest', roomTypeId: garden, arrival: plus(1), departure: plus(2) });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal((await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Third', roomTypeId: garden, arrival: plus(1), departure: plus(2) })).json().error.code, 'sold_out');

    // A deposit of BZ$200: a tax receipt now, exempt like the room it is for.
    const deposit = await call(c, 'POST', `/v1/hotel/bookings/${id}/deposit`, { amount: '200.00', method: 'card' });
    assert.equal(deposit.statusCode, 201, deposit.body);
    const receipt = await doc(c, deposit.json().documentId);
    assert.deepEqual([receipt.type, receipt.totals.payable, receipt.totals.gst, receipt.status], ['02', '200.00', '0.00', 'authorized']);
    assert.equal(deposit.json().depositHeld, '200.00');

    // Check-in: the room must be clean.
    await call(c, 'POST', `/v1/hotel/rooms/${rooms['101']}/status`, { status: 'dirty' });
    assert.equal((await call(c, 'POST', `/v1/hotel/bookings/${id}/check-in`)).json().error.code, 'room_dirty');
    await call(c, 'POST', `/v1/hotel/rooms/${rooms['101']}/status`, { status: 'clean' });
    const inHouse = await call(c, 'POST', `/v1/hotel/bookings/${id}/check-in`);
    assert.equal(inHouse.json().status, 'in_house');
    const desk = (await call(c, 'GET', '/v1/hotel/front-desk')).json();
    assert.deepEqual([desk.inHouse.length, desk.inHouse[0].guest.name, desk.arrivals.length], [1, 'Maya Young', 0]);

    // Dinner in the restaurant, charged to room 101: the server sees whose room it is first.
    const who = (await call(c, 'GET', '/v1/hotel/in-house?room=101')).json().data;
    assert.deepEqual([who.length, who[0].guest, who[0].room], [1, 'Maya Young', '101']);
    const dinner = await call(c, 'POST', '/v1/documents', { type: '02', room: { bookingId: id }, lines: [{ description: 'Dinner for two', quantity: '1', unitCode: 'C62', unitPrice: '120.00', gstCategory: 'S' }], payment: { meansCode: '10' } });
    assert.equal(dinner.statusCode, 201, dinner.body);
    const dinnerDoc = await doc(c, dinner.json().id);
    // It is a tax invoice on her account, not a receipt: nothing was paid at the table.
    assert.deepEqual([dinnerDoc.type, dinnerDoc.totals.payable, dinnerDoc.customer.name, dinnerDoc.payment.balance], ['01', '135.00', 'Maya Young', '135.00']);
    assert.equal((await c.f.db.query<{ d: string }>('select due_date::text as d from documents where id = $1', [dinner.json().id])).rows[0]!.d, departure, 'due at check-out');
    // Nobody who has checked out, or was never in, can be charged.
    assert.equal((await call(c, 'POST', '/v1/documents', { type: '02', room: { bookingId: second.json().id }, lines: [{ description: 'x', quantity: '1', unitCode: 'C62', unitPrice: '1.00', gstCategory: 'S' }], payment: { meansCode: '10' } })).json().error.code, 'not_in_house');

    // Night 1: the audit posts the room, sets up housekeeping, and moves the hotel's day on.
    const night1 = await call(c, 'POST', '/v1/hotel/night-audit');
    assert.equal(night1.statusCode, 200, night1.body);
    assert.deepEqual([night1.json().date, night1.json().nextDate, night1.json().roomsOccupied, night1.json().roomsAvailable, night1.json().roomRevenue, night1.json().adr, night1.json().hotelTax, night1.json().outletCharges], [arrival, plus(1), 1, 3, '200.00', '200.00', '18.00', '135.00']);
    assert.equal(night1.json().occupancyPercent, 33.3);
    assert.equal(Number(night1.json().revpar), 66.67);
    // The other guest was not due until tomorrow: nothing to flag yet.
    assert.deepEqual(night1.json().flags, []);
    // The room is dirty in the morning and on the housekeeper's list as a stayover.
    const hk = (await call(c, 'GET', '/v1/hotel/housekeeping')).json();
    const r101 = hk.rooms.find((r: { name: string }) => r.name === '101');
    assert.deepEqual([hk.today, r101.status, r101.occupied, r101.task.kind], [plus(1), 'dirty', true, 'stayover']);

    // Day 2: a drink at the bar on the room, then she moves to 102 (the guest due tonight has no room yet, and 101 will do for them).
    const bar = await call(c, 'POST', '/v1/documents', { type: '02', room: { bookingId: id }, lines: [{ description: 'Rum punch', quantity: '2', unitCode: 'H87', unitPrice: '8.00', gstCategory: 'S' }], payment: { meansCode: '10' } });
    assert.equal(bar.statusCode, 201, bar.body);
    // The other guest cancels. She moves; the room she leaves needs cleaning.
    assert.equal((await call(c, 'POST', `/v1/hotel/bookings/${second.json().id}/cancel`, { reason: 'Flight cancelled' })).json().status, 'cancelled');
    const moved = await call(c, 'PUT', `/v1/hotel/bookings/${id}`, { roomId: rooms['102'] });
    assert.equal(moved.json().room.name, '102');
    const afterMove = (await call(c, 'GET', '/v1/hotel/rooms')).json().data;
    assert.equal(afterMove.find((r: { name: string }) => r.name === '101').status, 'dirty');

    // Nights 2 and 3. The audit never runs twice for a day.
    const night2 = (await call(c, 'POST', '/v1/hotel/night-audit')).json();
    assert.deepEqual([night2.date, night2.roomRevenue, night2.outletCharges], [plus(1), '200.00', '18.00']);
    const night3 = (await call(c, 'POST', '/v1/hotel/night-audit')).json();
    assert.equal(night3.date, plus(2));
    const audits = (await call(c, 'GET', '/v1/hotel/audits')).json();
    assert.deepEqual([audits.data.length, audits.today], [3, departure]);
    // The folio: three nights (one in 101, two in 102), two outlet charges, the deposit held.
    const folio = (await call(c, 'GET', `/v1/hotel/bookings/${id}`)).json();
    const lines = folio.folios[0].lines as Array<{ kind: string; description: string; amount: string; total: string }>;
    assert.deepEqual(lines.map((l) => l.kind), ['charge', 'room', 'charge', 'room', 'room'], 'by day, in the order they were posted');
    assert.deepEqual(lines.filter((l) => l.kind === 'room').map((l) => [l.amount, l.total]), [['200.00', '218.00'], ['200.00', '218.00'], ['200.00', '218.00']]);
    // 3 x 218.00 + 135.00 + 18.00 = 807.00, less the 200.00 deposit.
    assert.deepEqual([folio.folios[0].balance, folio.depositHeld, folio.balance], ['807.00', '200.00', '607.00']);

    // Check-out: not without the balance; then paid in two parts, card and cash.
    const short = await call(c, 'POST', `/v1/hotel/bookings/${id}/check-out`, { payments: [{ amount: '300.00', method: 'card' }] });
    assert.equal(short.json().error.code, 'balance_due');
    assert.match(short.json().error.message, /BZ\$307\.00 is still owed/);
    const out = await call(c, 'POST', `/v1/hotel/bookings/${id}/check-out`, { payments: [{ amount: '307.00', method: 'cash' }] });
    assert.equal(out.statusCode, 200, out.body);
    assert.deepEqual([out.json().status, out.json().balance, out.json().depositHeld], ['checked_out', '0.00', '0.00']);
    assert.equal((await call(c, 'POST', `/v1/hotel/bookings/${id}/check-out`, {})).json().error.code, 'not_in_house');

    // The documents: a deposit receipt and its credit note; two outlet invoices; one room invoice with the hotel tax as a charge and no GST.
    const docs = (await c.f.db.query<{ id: string; etd_type: string; payable_cents: string; gst_cents: string; status: string }>('select id, etd_type, payable_cents, gst_cents, status from documents where tenant_id = $1 order by created_at', [c.f.tenantA])).rows;
    assert.deepEqual(docs.map((d) => [d.etd_type, Number(d.payable_cents), d.status]), [['02', 20000, 'authorized'], ['01', 13500, 'authorized'], ['01', 1800, 'authorized'], ['01', 65400, 'authorized'], ['04', 20000, 'authorized']]);
    const roomInvoice = await doc(c, docs[3]!.id);
    assert.deepEqual([roomInvoice.totals.lineExtension, roomInvoice.totals.gst, roomInvoice.totals.payable, roomInvoice.payment.balance, roomInvoice.payment.status], ['654.00', '0.00', '654.00', '0.00', 'paid']);
    assert.deepEqual(roomInvoice.lines.map((l: { description: string; quantity: string }) => [l.description.replace(/ from .*/, ''), Number(l.quantity)]), [['Room 101 (Garden room), 1 night', 1], ['Room 102 (Garden room), 2 nights', 2]]);
    // Every invoice of the stay is paid: nothing is left owing anywhere.
    const owed = (await call(c, 'GET', '/v1/receivables/invoices')).json().data;
    assert.equal(owed.length, 0);
    // GST collected is the outlets' only: 15.00 + 2.00. The hotel tax is 9% of 600.00 = 54.00, apart.
    assert.equal(docs.filter((d) => d.etd_type === '01').reduce((a, d) => a + Number(d.gst_cents), 0), 1700);
    // The room she left is dirty, she has one visit, and the day's departures show her.
    assert.equal((await call(c, 'GET', '/v1/hotel/rooms')).json().data.find((r: { name: string }) => r.name === '102').status, 'dirty');
    assert.equal((await c.f.db.query<{ visits: number }>('select visits from venue_guests where name = $1', ['Maya Young'])).rows[0]!.visits, 1);
    assert.equal((await call(c, 'GET', '/v1/hotel/front-desk')).json().departed.length, 1);
  }, hotelOn));

test('split folios, a part payment during the stay, an early departure, a no-show that keeps its deposit, and who may', () =>
  withVenue(async (c) => {
    const { garden, rooms } = await hotelSetup(c);
    const b = (await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Dev Patel', roomTypeId: garden, roomId: rooms['101'], arrival: today(), departure: plus(4), source: 'agent', groupName: 'Reef Tours' })).json();
    await call(c, 'POST', `/v1/hotel/bookings/${b.id}/check-in`);
    // The company pays the room; he pays his extras.
    const split = (await call(c, 'POST', `/v1/hotel/bookings/${b.id}/folios`, { name: 'Extras' })).json();
    const extras = split.folios.find((f: { name: string }) => f.name === 'Extras');
    assert.equal(split.folios.length, 2);
    await call(c, 'POST', `/v1/hotel/bookings/${b.id}/extras`, { description: 'Laundry', amount: '20.00', folioId: extras.id });
    // A charge from the bar goes to Extras by itself.
    const bar = await call(c, 'POST', '/v1/documents', { type: '02', room: { bookingId: b.id }, lines: [{ description: 'Beer', quantity: '2', unitCode: 'H87', unitPrice: '6.00', gstCategory: 'S' }], payment: { meansCode: '10' } });
    assert.equal(bar.statusCode, 201, bar.body);
    await call(c, 'POST', '/v1/hotel/night-audit');
    let folio = (await call(c, 'GET', `/v1/hotel/bookings/${b.id}`)).json();
    const byName = (name: string) => folio.folios.find((f: { name: string }) => f.name === name);
    // Room: one night with hotel tax. Extras: laundry 20.00 + GST 2.50, and the bar's 13.50.
    assert.deepEqual([byName('Room').balance, byName('Extras').balance, folio.balance], ['218.00', '36.00', '254.00']);
    // He pays his extras so far: the laundry goes on an invoice now, and both are paid.
    const part = await call(c, 'POST', `/v1/hotel/bookings/${b.id}/payments`, { payments: [{ amount: '36.00', method: 'cash', folioId: extras.id }] });
    assert.equal(part.statusCode, 200, part.body);
    folio = part.json();
    assert.deepEqual([byName('Room').balance, byName('Extras').balance], ['218.00', '0.00']);
    assert.equal((await call(c, 'POST', `/v1/hotel/bookings/${b.id}/payments`, { payments: [{ amount: '500.00', method: 'cash', folioId: extras.id }] })).json().error.code, 'too_much');
    // He leaves after one night instead of four: only the night stayed is charged; the company's folio is left on its account.
    const out = await call(c, 'POST', `/v1/hotel/bookings/${b.id}/check-out`, { leaveBalance: true });
    assert.equal(out.statusCode, 200, out.body);
    assert.deepEqual([out.json().status, out.json().nights, out.json().balance], ['checked_out', 1, '218.00']);
    const owed = (await call(c, 'GET', '/v1/receivables/invoices')).json().data;
    assert.deepEqual(owed.map((o: { balance: string }) => o.balance), ['218.00'], 'the room invoice is owed by the account');

    // A booking for today that never arrives: the audit flags it; marked a no-show, its deposit is kept.
    const ghost = (await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'No Show', roomTypeId: garden, arrival: plus(1), departure: plus(2) })).json();
    await call(c, 'POST', `/v1/hotel/bookings/${ghost.id}/deposit`, { amount: '50.00', method: 'cash' });
    const flagged = (await call(c, 'POST', '/v1/hotel/night-audit')).json();
    assert.ok(flagged.flags.some((f: string) => /No Show was due in and did not arrive/.test(f)), JSON.stringify(flagged.flags));
    const gone = await call(c, 'POST', `/v1/hotel/bookings/${ghost.id}/no-show`, { reason: 'Never came' });
    assert.equal(gone.json().status, 'no_show');
    assert.equal((await c.f.db.query<{ status: string }>("select status from venue_deposits where ref_id = $1", [ghost.id])).rows[0]!.status, 'kept');
    // A cancelled booking whose deposit goes back: a credit note against its receipt.
    const cancel = (await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Change Of Plan', roomTypeId: garden, arrival: plus(5), departure: plus(7) })).json();
    await call(c, 'POST', `/v1/hotel/bookings/${cancel.id}/deposit`, { amount: '80.00', method: 'cash' });
    await call(c, 'POST', `/v1/hotel/bookings/${cancel.id}/cancel`, { refundDeposit: true });
    const dep = (await c.f.db.query<{ status: string; credit_document_id: string }>("select status, credit_document_id from venue_deposits where ref_id = $1", [cancel.id])).rows[0]!;
    assert.equal(dep.status, 'refunded');
    assert.equal((await doc(c, dep.credit_document_id)).type, '04');

    // Housekeeping from a phone: a housekeeper marks a room clean, and cannot do anything else.
    const hk = await c.person('Hilda', 'housekeeper');
    const cleaned = await call(c, 'POST', `/v1/hotel/rooms/${rooms['101']}/status`, { status: 'clean' }, hk.headers);
    assert.equal(cleaned.json().data.find((r: { name: string }) => r.name === '101').status, 'clean');
    assert.equal((await call(c, 'POST', `/v1/hotel/rooms/${rooms['101']}/status`, { status: 'out_of_order' }, hk.headers)).statusCode, 403);
    assert.equal((await call(c, 'GET', '/v1/hotel/front-desk', undefined, hk.headers)).statusCode, 403);
    assert.equal((await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'x', roomTypeId: garden, arrival: plus(9), departure: plus(10) }, hk.headers)).statusCode, 403);
    assert.equal((await call(c, 'GET', '/v1/hotel/housekeeping', undefined, hk.headers)).statusCode, 200);
    // A server cannot run the audit or set up rooms; a business without the hotel on has none of it.
    const server = await c.person('Ana', 'server');
    assert.equal((await call(c, 'POST', '/v1/hotel/night-audit', undefined, server.headers)).statusCode, 403);
    await call(c, 'PUT', '/v1/venue/settings', { hotel: false });
    assert.equal((await call(c, 'POST', '/v1/hotel/room-types', { name: 'x', rateCents: 1 })).json().error.code, 'hotel_off');
  }, hotelOn));
