/**
 * Front of house, end to end over the API: the restaurant scenario (a booked
 * party of six with a deposit and an allergy, three courses, a table move, a
 * void after sending, a three-way split paid in cash, by card and to a
 * room) and the bar scenario (a tab through the end of happy hour, moved to
 * a table, closed with a tip, the bartender cashed out); then the waitlist,
 * guest records, the day's close past midnight, tip pooling and tax rules.
 */

import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billOneShare, type BillContext, documentLines, paymentOf, wholeBill } from '../src/venue/bill.ts';
import { call, check, menuItem, ops, type VenueCtx, withVenue } from './venue-helpers.ts';

const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() - 6 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
const stock = async (c: VenueCtx, id: string) => (await call(c, 'GET', `/v1/inventory/${id}`)).json().stock as number;
const track = async (c: VenueCtx, id: string, quantity: string) => assert.equal((await call(c, 'PUT', `/v1/inventory/${id}/settings`, { track: true, quantity })).statusCode, 200);

test('restaurant: a booked six with a deposit and an allergy, three courses, a move, a void after sending, split three ways: cash, card and to a room', () =>
  withVenue(async (c) => {
    // The venue: a kitchen and a bar, a 10% service charge for parties of six or more, and one guest in the hotel.
    await call(c, 'PUT', '/v1/venue/settings', { restaurant: true, hotel: true, serviceCharge: 'party', servicePartySize: 6 });
    const kitchen = (await call(c, 'POST', '/v1/venue/stations', { name: 'Kitchen', categories: ['Starters', 'Mains', 'Desserts'] })).json();
    await call(c, 'POST', '/v1/venue/stations', { name: 'Bar', categories: ['Drinks'] });
    const wine = await menuItem(c, 'House wine', '14.00', 'Drinks');
    const ceviche = await menuItem(c, 'Shrimp ceviche', '18.00', 'Starters');
    const snapper = await menuItem(c, 'Snapper', '36.00', 'Mains');
    const steak = await menuItem(c, 'Steak', '48.50', 'Mains');
    const flan = await menuItem(c, 'Flan', '9.00', 'Desserts');
    for (const id of [wine, ceviche, snapper, steak, flan]) await track(c, id, '50');
    const cooking = (await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Cooking', minChoices: 1, maxChoices: 1, options: [{ name: 'Medium rare' }, { name: 'Well done' }] })).json().data[0];
    await call(c, 'PUT', `/v1/venue/items/${steak}`, { modifierGroupIds: [cooking.id], course: 2 });
    await call(c, 'PUT', `/v1/venue/items/${ceviche}`, { allergens: ['crustaceans'], course: 1 });
    await call(c, 'PUT', `/v1/venue/items/${wine}`, { course: 0 });
    await call(c, 'PUT', `/v1/venue/items/${flan}`, { course: 3 });
    const type = (await call(c, 'POST', '/v1/hotel/room-types', { name: 'Garden room', rateCents: 20000 })).json();
    const room = (await call(c, 'POST', '/v1/hotel/rooms', { name: '7', roomTypeId: type.id })).json();
    const stay = (await call(c, 'POST', '/v1/hotel/bookings', { guestName: 'Ines Cho', roomTypeId: type.id, roomId: room.id, arrival: today(), departure: plus(2) })).json();
    await call(c, 'POST', `/v1/hotel/bookings/${stay.id}/check-in`);
    const hattie = await c.person('Hattie', 'host');
    const ana = await c.person('Ana', 'server');
    await c.person('Sam', 'supervisor', '4821');

    // The booking: six at 7 pm on tables 5 and 6, a birthday, one guest allergic to shellfish, BZ$100 deposit.
    const at = new Date(Date.now() + 3600_000).toISOString();
    const booked = await call(c, 'POST', '/v1/venue/reservations', { name: 'Carla Mena', phone: '610-5555', partySize: 6, startsAt: at, tableIds: ['t5', 't6'], occasion: 'Birthday', allergy: 'One guest: shellfish' }, hattie.headers);
    assert.equal(booked.statusCode, 201, booked.body);
    const res = booked.json();
    assert.equal(res.durationMin, 105, 'a party of six is expected to stay 105 minutes');
    // The tables are hers for that time: another booking on table 5 clashes; one after she is due to leave does not.
    const clash = await call(c, 'POST', '/v1/venue/reservations', { name: 'Other', partySize: 2, startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), tableIds: ['t5'] }, hattie.headers);
    assert.equal(clash.json().error.code, 'clash');
    assert.match(clash.json().error.message, /booked for Carla Mena/);
    assert.equal((await call(c, 'POST', '/v1/venue/reservations', { name: 'Later', partySize: 2, startsAt: new Date(Date.now() + 4 * 3600_000).toISOString(), tableIds: ['t5'] }, hattie.headers)).statusCode, 201);
    // A host takes no money; a manager takes the deposit: a tax receipt for BZ$100.00 with its GST inside.
    assert.equal((await call(c, 'POST', `/v1/venue/reservations/${res.id}/deposit`, { amount: '100.00', method: 'card' }, hattie.headers)).statusCode, 403);
    const deposit = await call(c, 'POST', `/v1/venue/reservations/${res.id}/deposit`, { amount: '100.00', method: 'card' });
    assert.equal(deposit.statusCode, 201, deposit.body);
    const depositDoc = (await call(c, 'GET', `/v1/documents/${deposit.json().documentId}`)).json();
    assert.deepEqual([depositDoc.type, depositDoc.totals.payable, depositDoc.totals.lineExtension, depositDoc.totals.gst], ['02', '100.00', '88.89', '11.11']);
    // A message for WhatsApp is written for whoever confirms.
    assert.match((await call(c, 'POST', `/v1/venue/reservations/${res.id}/message`, undefined, hattie.headers)).json().whatsapp, /^https:\/\/wa\.me\/5016105555\?text=We%20have%20your%20table/);

    // They arrive: the host seats them at table 5, with Ana. The allergy and the guest come with the check.
    const seated = await call(c, 'POST', `/v1/venue/reservations/${res.id}/seat`, { tableId: 't5', tableName: 'Table 5', serverId: ana.id }, hattie.headers);
    assert.equal(seated.statusCode, 200, seated.body);
    const id = seated.json().checkId as string;
    let state = await check(c, id);
    assert.deepEqual([state.tableName, state.partySize, state.server.name, state.allergy, state.reservationId, state.openedBy.name], ['Table 5', 6, 'Ana', 'One guest: shellfish', res.id, 'Hattie']);

    // Three courses by seat; the mains wait until the starters are cleared.
    const item = (itemId: string, seat: number, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), itemId, seat, ...extra });
    const order = [
      ...[1, 2, 3, 4, 5, 6].map((s) => item(wine, s)),
      item(ceviche, 1), item(ceviche, 2), item(ceviche, 3),
      item(snapper, 1), item(snapper, 2), item(snapper, 3), item(snapper, 4),
      item(steak, 5, { modifiers: [{ groupId: cooking.id, optionId: cooking.options[0].id }], note: 'no butter' }), item(steak, 6, { modifiers: [{ groupId: cooking.id, optionId: cooking.options[1].id }] }),
    ];
    const first = await ops(c, ana.headers, [{ checkId: id, type: 'add', payload: { items: order } }, { checkId: id, type: 'holdCourse', payload: { course: 2 } }, { checkId: id, type: 'fire' }]);
    assert.equal(first.results[2]!.sent.length, 9, 'drinks and starters go; the mains are held');
    // The kitchen's ticket for the starters carries the allergy and which dish has the allergen.
    const tickets = (await call(c, 'GET', '/v1/venue/changes')).json().tickets as Array<{ stationId: string; kind: string; body: { allergy: string; items: Array<{ name: string; allergens: string[]; seat: number; course: number; modifiers: string[]; note: string | null }> } }>;
    const starters = tickets.find((t) => t.stationId === kitchen.id)!;
    assert.deepEqual([starters.body.allergy, starters.body.items.length, starters.body.items[0]!.allergens, starters.body.items.map((i) => i.seat)], ['One guest: shellfish', 3, ['crustaceans'], [1, 2, 3]]);
    // They move to the patio; then the mains are fired, and desserts ordered.
    assert.ok((await ops(c, ana.headers, [{ checkId: id, type: 'move', payload: { tableId: 'p2', tableName: 'Patio 2' } }])).results[0]!.ok);
    const mains = await ops(c, ana.headers, [{ checkId: id, type: 'served', payload: { course: 1 } }, { checkId: id, type: 'fire', payload: { course: 2 } }]);
    assert.equal(mains.results[1]!.sent.length, 6);
    const after = (await call(c, 'GET', '/v1/venue/changes')).json().tickets as typeof tickets;
    const mainsTicket = after.find((t) => t.stationId === kitchen.id && t.body.items.some((i) => i.name === 'Steak'))!;
    assert.deepEqual(mainsTicket.body.items.filter((i) => i.name === 'Steak').map((i) => [i.seat, i.modifiers, i.note]), [[5, ['Medium rare'], 'no butter'], [6, ['Well done'], null]]);
    assert.equal((mainsTicket.body as unknown as { table: string }).table, 'Patio 2', 'the ticket says where they are now');
    const desserts = [item(flan, 1), item(flan, 2)];
    await ops(c, ana.headers, [{ checkId: id, type: 'add', payload: { items: desserts } }, { checkId: id, type: 'fire' }]);
    // Seat 4 never got their snapper: voided after sending, with a supervisor's PIN and a reason; the kitchen is told.
    const lost = order[9]!.id;
    assert.equal((await ops(c, ana.headers, [{ checkId: id, type: 'void', payload: { itemIds: [lost], reason: 'Guest left early' } }])).results[0]!.code, 'approval_needed');
    const sam = (await call(c, 'POST', '/v1/venue/approve', { pin: '4821' }, ana.headers)).json();
    assert.ok((await ops(c, ana.headers, [{ checkId: id, type: 'void', payload: { itemIds: [lost], reason: 'Guest left early', approvedBy: sam } }])).results[0]!.ok);

    // The bill: service charge for the six; the deposit comes off before GST.
    await ops(c, ana.headers, [{ checkId: id, type: 'requestBill' }]);
    const applied = await call(c, 'POST', `/v1/venue/reservations/${res.id}/apply-deposit`, undefined, ana.headers);
    assert.equal(applied.json().applied, '88.89');
    assert.equal((await call(c, 'POST', `/v1/venue/reservations/${res.id}/apply-deposit`, undefined, ana.headers)).json().error.code, 'no_deposit', 'once');
    const venue = (await call(c, 'GET', '/v1/venue')).json();
    const ctx: BillContext = { servicePercent: '10', gstPercent: venue.taxes.gstPercent, periods: [] };
    state = await check(c, id);
    const whole = wholeBill(state, ctx);
    // 6 wine 84.00 + 3 ceviche 54.00 + 3 snapper 108.00 + 2 steak 97.00 + 2 flan 18.00 = 361.00; service 36.10; deposit -88.89; GST on 308.21 = 38.53.
    assert.deepEqual([whole.subtotalCents, whole.serviceCents, whole.allowCents, whole.gstCents, whole.totalCents], [36100, 3610, 8889, 3853, 34674]);

    // Split three ways, each on a document of its own: cash (handed over in US dollars), card, and Ines's room.
    const live = state.items.filter((i) => i.status !== 'void').map((i) => i.id);
    await ops(c, ana.headers, [{ checkId: id, type: 'share', payload: { itemIds: live, ways: 3 } }]);
    const pays = [
      { payment: { meansCode: '10', terms: 'Cash' } },
      { payment: { meansCode: '48', terms: 'Card' }, tip: { amount: '10.00', meansCode: '48' } },
      { payment: { meansCode: '10' }, room: { bookingId: stay.id } },
    ];
    const issued: Array<{ id: string; type: string; payable: string; gst: string }> = [];
    for (const p of pays) {
      const part = billOneShare(await check(c, id), ctx);
      const doc = await call(c, 'POST', '/v1/documents', { type: '02', lines: documentLines(part, '10'), ...p }, ana.headers);
      assert.equal(doc.statusCode, 201, doc.body);
      const full = (await call(c, 'GET', `/v1/documents/${doc.json().id}`)).json();
      assert.equal(full.totals.payable, (part.totalCents / 100).toFixed(2), 'the device and the server agree to the cent');
      assert.equal(full.status, 'authorized');
      issued.push({ id: doc.json().id, type: full.type, payable: full.totals.payable, gst: full.totals.gst });
      const paid = await ops(c, ana.headers, [{ checkId: id, type: 'pay', payload: { documentId: doc.json().id, items: paymentOf(part), ...(p.tip && { tipCents: 1000, tipMeans: '48' }) } }]);
      assert.ok(paid.results[0]!.ok);
    }
    // Two receipts and an invoice on Ines's account; together they are the bill, to the cent, and so is their GST.
    assert.deepEqual(issued.map((d) => d.type), ['02', '02', '01']);
    assert.equal(Math.round(issued.reduce((a, d) => a + Number(d.payable) * 100, 0)), whole.totalCents);
    assert.equal(Math.round(issued.reduce((a, d) => a + Number(d.gst) * 100, 0)), whole.gstCents);
    state = await check(c, id);
    assert.equal(state.status, 'paid');
    // US dollars: the cash part is BZ$115.47; the guest hands over US$60, which is BZ$120.00: BZ$4.53 change.
    assert.equal(venue.venue.usdRateCents, 200);
    assert.equal(issued[0]!.payable, '115.47');
    assert.equal(60 * venue.venue.usdRateCents - Math.round(Number(issued[0]!.payable) * 100), 453);
    // The room's folio has the charge; it is owed until check-out.
    const folio = (await call(c, 'GET', `/v1/hotel/bookings/${stay.id}`)).json();
    assert.equal(folio.folios[0].lines.find((l: { kind: string }) => l.kind === 'charge').total, issued[2]!.payable);

    // Stock moved once for each thing served: 6 wines, 3 ceviches, 3 snappers (not the voided one), 2 steaks, 2 flans.
    assert.deepEqual([await stock(c, wine), await stock(c, ceviche), await stock(c, snapper), await stock(c, steak), await stock(c, flan)], [44, 47, 47, 48, 48]);
    // The reports agree with the documents.
    await ops(c, ana.headers, [{ checkId: id, type: 'clean' }]);
    const report = (await call(c, 'GET', `/v1/venue/reports?from=${state.businessDate}&to=${state.businessDate}`)).json();
    assert.deepEqual([report.covers.covers, report.covers.tables, report.sales.serviceCharge, report.taxes.documents, report.taxes.gst], [6, 1, '36.10', 3, (whole.gstCents / 100).toFixed(2)]);
    assert.equal(report.sales.net, ((whole.subtotalCents - whole.allowCents) / 100).toFixed(2));
    assert.equal(Math.round(Number(report.taxes.documentsNet) * 100), whole.subtotalCents - whole.allowCents + whole.serviceCents, 'what the checks say was sold is what the documents say');
    assert.deepEqual(report.tenders.map((t: { name: string }) => t.name).sort(), ['Card', 'Cash', 'Charged to a room or account']);
    assert.deepEqual(report.voids.map((v: { name: string; amount: string }) => [v.name, v.amount]), [['Ana: Guest left early', '36.00']]);
    assert.deepEqual(report.tips, { total: '10.00', byServer: [{ name: 'Ana', count: 1, amount: '10.00' }] });
    assert.equal(report.byItem.find((i: { name: string }) => i.name === 'Snapper').quantity, 3);
    assert.equal(report.byServer[0].name, 'Ana');
    // Ana's checkout: what she sold and took, and the cash she hands in less the card tip she is owed.
    const out = (await call(c, 'GET', '/v1/venue/checkout', undefined, ana.headers)).json();
    assert.deepEqual([out.server.name, out.cashTaken, out.tipsToPayOut, out.cashDue, out.openChecks.length], ['Ana', issued[0]!.payable, '10.00', (Number(issued[0]!.payable) - 10).toFixed(2), 0]);
    // The guest record remembers the visit and the allergy for next time.
    const guest = (await call(c, 'GET', '/v1/venue/guests?q=Carla', undefined, hattie.headers)).json().data[0];
    assert.deepEqual([guest.visits, guest.allergies], [1, 'One guest: shellfish']);
    const history = (await call(c, 'GET', `/v1/venue/guests/${guest.id}`, undefined, hattie.headers)).json();
    assert.deepEqual([history.history.length, history.history[0].table, history.reservations[0].occasion], [1, 'Patio 2', 'Birthday']);
  }));

test('bar: a tab through the end of happy hour, moved to a table, closed with a tip; the bartender cashes out', () =>
  withVenue(async (c) => {
    const rum = await menuItem(c, 'Rum, bottle', '60.00', 'Stock');
    const punch = await menuItem(c, 'Rum punch', '8.00', 'Drinks');
    const beer = await menuItem(c, 'Belikin', '6.00', 'Drinks');
    await track(c, rum, '10');
    await track(c, beer, '48');
    await call(c, 'PUT', `/v1/items/${punch}/components`, { components: [{ itemId: rum, quantity: '0.06' }] });
    // Happy hour every day, 4 to 6 pm: a quarter off drinks, and two-for-one on beer.
    const happy = await call(c, 'POST', '/v1/venue/periods', { kind: 'promotion', name: 'Happy hour', startsMin: 16 * 60, endsMin: 18 * 60, rules: [{ kind: 'percent', percent: 25, categories: ['Drinks'] }, { kind: 'twoForOne', itemIds: [beer] }] });
    assert.equal(happy.statusCode, 201, happy.body);
    const bo = await c.person('Bo', 'bartender');
    // Yesterday evening, by the clock of the device that rang it up (Belize is UTC-6).
    const yesterday = plus(-1);
    const at = (hhmm: string) => new Date(new Date(`${yesterday}T${hhmm}:00.000Z`).getTime() + 6 * 3600_000).toISOString();
    const tab = randomUUID();
    const [p1, b1, p2, b2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const rounds = await ops(c, bo.headers, [
      { checkId: tab, type: 'open', at: at('17:40'), payload: { kind: 'tab', name: 'Maria' } },
      // 5:40 pm, in happy hour: two punches and two beers.
      { checkId: tab, type: 'add', at: at('17:40'), payload: { items: [{ id: p1, itemId: punch, quantity: 2 }, { id: b1, itemId: beer, quantity: 2 }] } },
      { checkId: tab, type: 'fire', at: at('17:40') },
      // 6:05 pm: the same round again, at full price.
      { checkId: tab, type: 'add', at: at('18:05'), payload: { items: [{ id: p2, itemId: punch, quantity: 2 }, { id: b2, itemId: beer, quantity: 2 }] } },
      { checkId: tab, type: 'fire', at: at('18:05') },
    ]);
    assert.ok(rounds.results.every((r) => r.ok), JSON.stringify(rounds.results));
    let state = await check(c, tab);
    const price = (id: string) => { const i = state.items.find((x) => x.id === id)!; return [i.unitCents, i.promo ?? null, i.tags.length]; };
    assert.deepEqual([price(p1), price(b1), price(p2), price(b2)], [[600, 'Happy hour', 0], [450, 'Happy hour', 1], [800, null, 0], [600, null, 0]]);
    assert.deepEqual([state.kind, state.name, state.businessDate], ['tab', 'Maria', yesterday]);
    // She takes a table: the tab becomes the table's check, with everything on it.
    assert.ok((await ops(c, bo.headers, [{ checkId: tab, type: 'move', payload: { tableId: 'b4', tableName: 'Booth 4' } }])).results[0]!.ok);
    state = await check(c, tab);
    assert.deepEqual([state.kind, state.tableName, state.items.length], ['table', 'Booth 4', 4]);
    // The bill: of the two happy-hour beers, one is free; the later round is at full price.
    const periods = (await call(c, 'GET', '/v1/venue/periods')).json().data;
    const ctx: BillContext = { servicePercent: null, gstPercent: '12.5', periods };
    const bill = wholeBill(state, ctx);
    // 2 x 6.00 + 2 x 4.50 + 2 x 8.00 + 2 x 6.00 = 49.00; one 4.50 beer free; GST on 44.50 = 5.56.
    assert.deepEqual([bill.subtotalCents, bill.allowCents, bill.gstCents, bill.totalCents], [4900, 450, 556, 5006]);
    assert.equal(bill.lines.find((l) => l.checkItemId === b1)!.allowReason, 'Happy hour');
    // Bo opens a shift, takes the card with a BZ$7 tip, and the tab closes.
    const shift = (await call(c, 'POST', '/v1/shifts', { openingFloat: '100.00' }, bo.headers)).json().shift;
    const receipt = await call(c, 'POST', '/v1/documents', { type: '02', lines: documentLines(bill, null), payment: { meansCode: '48', terms: 'Card' }, tip: { amount: '7.00', meansCode: '48' } }, bo.headers);
    assert.equal(receipt.statusCode, 201, receipt.body);
    assert.equal(receipt.json().totals.payable, '50.06');
    await ops(c, bo.headers, [{ checkId: tab, type: 'pay', payload: { documentId: receipt.json().id, items: paymentOf(bill), tipCents: 700, tipMeans: '48' } }, { checkId: tab, type: 'clean' }]);
    state = await check(c, tab);
    assert.equal(state.status, 'closed');
    // Stock: four punches poured 0.24 of a bottle; four beers left the fridge (the free one too).
    assert.deepEqual([await stock(c, rum), await stock(c, beer)], [9.76, 44]);
    // His checkout for that business day, and the drawer: nothing in cash, a BZ$7 tip to pay him.
    const out = (await call(c, 'GET', `/v1/venue/checkout?date=${yesterday}`, undefined, bo.headers)).json();
    assert.deepEqual([out.sales.net, out.tips.total, out.cashTaken, out.tipsToPayOut, out.tenders.map((t: { name: string; amount: string }) => [t.name, t.amount])], ['44.50', '7.00', '0.00', '7.00', [['Card', '50.06']]]);
    const closed = await call(c, 'POST', `/v1/shifts/${shift.id}/close`, { countedCash: '100.00' }, bo.headers);
    assert.equal(closed.statusCode, 200, closed.body);
    const z = closed.json().report;
    assert.deepEqual([z.tips.total, z.takings.card], ['7.00', '50.06']);
    // A server sees their own checkout only; a supervisor anyone's.
    const other = await c.person('Ana', 'server');
    assert.equal((await call(c, 'GET', `/v1/venue/checkout?userId=${bo.id}`, undefined, other.headers)).statusCode, 403);
  }));

test('the waitlist, tabs left open at the day’s close, the business day past midnight, tip pooling and dated tax rules', () =>
  withVenue(async (c) => {
    const beer = await menuItem(c, 'Belikin', '6.00', 'Drinks');
    const hattie = await c.person('Hattie', 'host');
    const bo = await c.person('Bo', 'bartender');
    const ana = await c.person('Ana', 'server');
    // A walk-in party waits, is told the table is ready, and is seated from the list.
    const w = await call(c, 'POST', '/v1/venue/waitlist', { name: 'Pat', phone: '622-1000', partySize: 3, quotedMin: 20 }, hattie.headers);
    assert.equal(w.statusCode, 201, w.body);
    const listed = (await call(c, 'GET', '/v1/venue/reservations', undefined, hattie.headers)).json();
    assert.deepEqual(listed.waitlist.map((x: { name: string; partySize: number; quotedMin: number; status: string }) => [x.name, x.partySize, x.quotedMin, x.status]), [['Pat', 3, 20, 'waiting']]);
    const told = (await call(c, 'POST', `/v1/venue/waitlist/${w.json().id}/notify`, undefined, hattie.headers)).json();
    assert.match(told.whatsapp, /^https:\/\/wa\.me\/5016221000\?text=Pat%2C%20your%20table/);
    const sat = await call(c, 'POST', `/v1/venue/waitlist/${w.json().id}/seat`, { tableId: 't2', tableName: 'Table 2', serverId: ana.id }, hattie.headers);
    assert.equal(sat.statusCode, 200, sat.body);
    assert.deepEqual([(await check(c, sat.json().checkId)).partySize, (await check(c, sat.json().checkId)).server.name], [3, 'Ana']);
    assert.equal((await call(c, 'POST', `/v1/venue/waitlist/${w.json().id}/left`, undefined, hattie.headers)).statusCode, 409);
    // A party that gives up is taken off; a table already taken cannot be given twice.
    const w2 = (await call(c, 'POST', '/v1/venue/waitlist', { name: 'Quinn', partySize: 2 }, hattie.headers)).json();
    assert.equal((await call(c, 'POST', `/v1/venue/waitlist/${w2.id}/seat`, { tableId: 't2', tableName: 'Table 2' }, hattie.headers)).json().error.code, 'table_taken');
    assert.equal((await call(c, 'POST', `/v1/venue/waitlist/${w2.id}/left`, undefined, hattie.headers)).json().status, 'left');

    // A bar tab is still open at closing time: the close says so, by name, and will not go on without a decision.
    const tab = randomUUID();
    await ops(c, bo.headers, [{ checkId: tab, type: 'open', payload: { kind: 'tab', name: 'Room 12' } }, { checkId: tab, type: 'add', payload: { items: [{ id: randomUUID(), itemId: beer }] } }, { checkId: tab, type: 'fire' }]);
    const day = (await call(c, 'GET', '/v1/venue/day')).json();
    assert.deepEqual([day.openTabs.map((t: { name: string; server: string }) => [t.name, t.server]), day.openTables.length], [[['Room 12', 'Bo']], 1]);
    assert.equal((await call(c, 'POST', '/v1/venue/day/close', undefined, bo.headers)).statusCode, 403, 'a bartender does not close the day');
    const refused = await call(c, 'POST', '/v1/venue/day/close');
    assert.equal(refused.json().error.code, 'open_checks');
    // An open shift stops it too.
    const shift = (await call(c, 'POST', '/v1/shifts', { openingFloat: '50.00' }, bo.headers)).json().shift;
    assert.equal((await call(c, 'POST', '/v1/venue/day/close', { carryOver: true })).json().error.code, 'open_shifts');
    await call(c, 'POST', `/v1/shifts/${shift.id}/close`, { countedCash: '50.00' }, bo.headers);
    // Carried over: the day closes with its report, and the open checks belong to tomorrow.
    const closed = await call(c, 'POST', '/v1/venue/day/close', { carryOver: true });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.deepEqual([closed.json().closed, closed.json().carriedOver, closed.json().report.period.from], [day.businessDate, 2, day.businessDate]);
    assert.notEqual((await check(c, tab)).businessDate, day.businessDate);
    // After the close, whatever is rung up tonight belongs to the next business day, not the one just closed.
    const late = randomUUID();
    await ops(c, bo.headers, [{ checkId: late, type: 'open', payload: { kind: 'quick' } }]);
    assert.equal((await check(c, late)).businessDate, closed.json().businessDate);
    assert.equal((await call(c, 'GET', '/v1/venue/day')).json().businessDate, closed.json().businessDate);

    // Tips: Bo took BZ$30 and Ana BZ$10; they and the kitchen share by the venue's rule.
    const kit = await c.person('Kit', 'kitchen');
    for (const [who, cents] of [[bo, 3000], [ana, 1000]] as const) {
      const id = randomUUID();
      const itemId = randomUUID();
      await ops(c, who.headers, [{ checkId: id, type: 'open', payload: { kind: 'quick' } }, { checkId: id, type: 'add', payload: { items: [{ id: itemId, itemId: beer }] } }, { checkId: id, type: 'pay', payload: { documentId: randomUUID(), items: [{ itemId, shares: 1, grossCents: 600, allowCents: 0, serviceCents: 0 }], tipCents: cents, tipMeans: '48' } }]);
    }
    const hours = async (userId: string, h: number) => c.f.db.query('insert into time_entries (id, tenant_id, user_id, clock_in, clock_out) values ($1, $2, $3, $4, $5)', [randomUUID(), c.f.tenantA, userId, new Date(Date.now() - h * 3600_000).toISOString(), new Date().toISOString()]);
    await hours(bo.id, 8); await hours(ana.id, 4); await hours(kit.id, 4);
    const range = `from=${plus(-1)}&to=${plus(2)}`;
    const tips = async () => (await call(c, 'GET', `/v1/venue/tips?${range}`)).json();
    const share = (t: { people: Array<{ name: string; share: string }> }) => Object.fromEntries(t.people.map((p) => [p.name, p.share]));
    // No pooling: each keeps what they took.
    assert.deepEqual(share(await tips()), { Bo: '30.00', Ana: '10.00', Kit: '0.00' });
    // By hours: 8, 4 and 4 of 16 hours of BZ$40.
    await call(c, 'PUT', '/v1/venue/settings', { tipPool: { method: 'hours', weights: {} } });
    assert.deepEqual(share(await tips()), { Bo: '20.00', Ana: '10.00', Kit: '10.00' });
    // By role: 50% to bartenders, 30% to servers, 20% to the kitchen.
    await call(c, 'PUT', '/v1/venue/settings', { tipPool: { method: 'role', weights: { bartender: 50, server: 30, kitchen: 20 } } });
    assert.deepEqual(share(await tips()), { Bo: '20.00', Ana: '12.00', Kit: '8.00' });
    // By points: 3 a bartender's hour, 2 a server's, 1 the kitchen's: 24, 8 and 4 of 36.
    await call(c, 'PUT', '/v1/venue/settings', { tipPool: { method: 'points', weights: { bartender: 3, server: 2, kitchen: 1 } } });
    const points = await tips();
    assert.deepEqual([share(points), points.pool, points.shared, points.notShared], [{ Bo: '26.66', Ana: '8.88', Kit: '4.46' }, '40.00', '40.00', '0.00']);

    // Tax rules are dated configuration: a new hotel tax from a day on; the old one until then; what is unverified says so.
    const rules = (await call(c, 'GET', '/v1/venue/tax-rules')).json().data as Array<{ key: string; value: string; verified: boolean; source: string }>;
    assert.deepEqual(rules.find((r) => r.key === 'hotelTaxPercent')!.value, '9');
    assert.ok(rules.some((r) => !r.verified) && rules.every((r) => r.source.length > 10));
    assert.equal((await call(c, 'POST', '/v1/venue/tax-rules', { key: 'hotelTaxPercent', value: 'lots', from: today() })).statusCode, 422);
    assert.equal((await call(c, 'POST', '/v1/venue/tax-rules', { key: 'hotelTaxPercent', value: '12.5', from: plus(30), note: 'SI of 2027' }, ana.headers)).statusCode, 403);
    await call(c, 'POST', '/v1/venue/tax-rules', { key: 'hotelTaxPercent', value: '12.5', from: plus(30), note: 'SI of 2027' });
    assert.equal((await call(c, 'GET', '/v1/venue')).json().taxes.hotelTaxPercent, '9', 'not yet');
    const now = await call(c, 'POST', '/v1/venue/tax-rules', { key: 'hotelTaxPercent', value: '10', from: today(), note: 'Test' });
    assert.deepEqual([now.json().data.find((r: { key: string }) => r.key === 'hotelTaxPercent').value, (await call(c, 'GET', '/v1/venue')).json().taxes.hotelTaxPercent], ['10', '10']);
  }));
