/**
 * The hospitality module over its API: off for a shop; setup (floor plans,
 * menus by the clock, stations, modifiers, allergens, sold out); orders by
 * operations from several people; supervisor approval; kitchen tickets that
 * fail, are retried and re-routed; the kitchen screen; paying, and stock.
 */

import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser, setPin } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { billOfItems, documentLines, paymentOf, wholeBill } from '../src/venue/bill.ts';
import type { Check } from '../src/venue/check.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
type Headers = Record<string, string>;
export interface VenueCtx { f: PipelineFixture; app: FastifyInstance; owner: Headers; login: (email: string) => Promise<Headers>; person: (name: string, role: string, pin?: string) => Promise<{ id: string; headers: Headers }> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

export async function withVenue(fn: (c: VenueCtx) => Promise<void>, kinds: Record<string, unknown> | null = { restaurant: true, bar: true }) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const person = async (name: string, role: string, pin?: string) => {
    const email = `${name.toLowerCase()}@biz.example`;
    const u = await createUser(f.db, { tenantId: f.tenantA, name, email, role: role as 'server', password: PASSWORD });
    if (pin) await setPin(f.db, f.tenantA, u.id, pin);
    return { id: u.id, headers: await login(email) };
  };
  try {
    const owner = await login('olive@biz.example');
    if (kinds) assert.equal((await app.inject({ method: 'PUT', url: '/v1/venue/settings', headers: owner, payload: kinds })).statusCode, 200);
    await fn({ f, app, owner, login, person });
  } finally {
    await app.close();
    await f.close();
  }
}

export const call = (c: VenueCtx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = c.owner) => c.app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
export async function menuItem(c: VenueCtx, name: string, price: string, category: string, extra: Record<string, unknown> = {}) {
  const r = await call(c, 'POST', '/v1/items', { name, unitCode: 'H87', unitPrice: price, gstCategory: 'S', category, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
/** Send operations as one person; returns each one's result. */
export async function ops(c: VenueCtx, headers: Headers, list: Array<{ checkId: string; type: string; payload?: Record<string, unknown>; id?: string; at?: string }>) {
  const r = await call(c, 'POST', '/v1/venue/ops', { ops: list.map((o) => ({ id: o.id ?? randomUUID(), checkId: o.checkId, type: o.type, at: o.at ?? new Date().toISOString(), payload: o.payload ?? {} })) }, headers);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { results: Array<{ id: string; ok: boolean; reason?: string; code?: string; duplicate?: boolean; sent: string[] }>; seq: number };
}
export const check = async (c: VenueCtx, id: string) => (await call(c, 'GET', `/v1/venue/checks/${id}`)).json() as Check & { number: number };

test('a shop sees none of it; a venue switches it on by kind', () =>
  withVenue(async (c) => {
    const me = (await call(c, 'GET', '/v1/venue')).json();
    assert.deepEqual([me.on, me.venue.restaurant, me.venue.bar, me.venue.hotel], [false, false, false, false]);
    assert.equal((await call(c, 'POST', '/v1/venue/ops', { ops: [{ id: randomUUID(), checkId: randomUUID(), type: 'open', at: new Date().toISOString(), payload: { kind: 'tab', name: 'x' } }] })).json().error.code, 'venue_off');
    // Selling as a shop is what it was.
    const soap = await menuItem(c, 'Soap', '4.00', 'Home');
    assert.equal((await call(c, 'POST', '/v1/documents', { type: '02', lines: [{ itemId: soap, quantity: '1' }], payment: { meansCode: '10', terms: 'Cash' } })).statusCode, 201);
    // A cashier cannot switch it on; the owner can, one kind or several.
    const cashier = await c.person('Cash', 'cashier');
    assert.equal((await call(c, 'PUT', '/v1/venue/settings', { restaurant: true }, cashier.headers)).statusCode, 403);
    const saved = (await call(c, 'PUT', '/v1/venue/settings', { restaurant: true, hotel: true, serviceCharge: 'party', servicePartySize: 6, dayEndsHour: 3, hotelDate: '2020-01-01' })).json();
    assert.deepEqual([saved.restaurant, saved.bar, saved.hotel, saved.serviceCharge, saved.dayEndsHour, saved.hotelDate], [true, false, true, 'party', 3, null]);
    assert.equal((await call(c, 'GET', '/v1/venue')).json().on, true);
  }, null));

test('setup: floor plans with layouts, menus by the clock, stations with a fallback, modifiers, allergens, sold out', () =>
  withVenue(async (c) => {
    // A dining room, then an event layout copied from it, with the same tables.
    const tables = [{ id: 't1', type: 'table', name: 'T1', shape: 'round', seats: 4, x: 100, y: 100, w: 90, h: 90 }, { id: 't2', type: 'table', name: 'T2', shape: 'rect', seats: 6, x: 300, y: 100, w: 160, h: 90 }, { id: 'w1', type: 'wall', x: 0, y: 0, w: 1000, h: 12 }, { id: 'bad', type: 'table', name: '' }];
    const dining = await call(c, 'POST', '/v1/venue/floor', { area: 'Dining room', items: tables });
    assert.equal(dining.statusCode, 201, dining.body);
    assert.deepEqual(dining.json().data[0].items.map((i: { id: string; type: string; seats: number }) => [i.id, i.type, i.seats]), [['t1', 'table', 4], ['t2', 'table', 6], ['w1', 'wall', 0]]);
    const event = await call(c, 'POST', '/v1/venue/floor', { area: 'Dining room', layout: 'Event', copyFrom: dining.json().id });
    assert.equal(event.json().data.length, 2);
    assert.equal((await call(c, 'POST', '/v1/venue/floor', { area: 'dining room' })).statusCode, 409);
    const moved = await call(c, 'PUT', `/v1/venue/floor/${event.json().id}`, { items: [{ ...tables[0], x: 500, y: 500 }, { id: 's1', type: 'stool', name: 'Bar 1', x: 50, y: 900, w: 40, h: 40 }] });
    assert.deepEqual(moved.json().data.find((p: { layout: string }) => p.layout === 'Event').items.map((i: { id: string; x: number; seats: number }) => [i.id, i.x, i.seats]), [['t1', 500, 4], ['s1', 50, 1]]);

    // Stations: the grill falls back to the kitchen's printer.
    const kitchen = (await call(c, 'POST', '/v1/venue/stations', { name: 'Hot kitchen', categories: ['Mains', 'Starters'] })).json();
    const grill = await call(c, 'POST', '/v1/venue/stations', { name: 'Grill', categories: [], fallbackId: kitchen.id, screen: true, targetMin: 15 });
    assert.equal(grill.statusCode, 201, grill.body);
    assert.equal((await call(c, 'PUT', `/v1/venue/stations/${grill.json().id}`, { name: 'Grill', fallbackId: grill.json().id })).statusCode, 422);
    const bar = (await call(c, 'POST', '/v1/venue/stations', { name: 'Bar', categories: ['Drinks'] })).json();

    // The menu: a steak with a required choice, two sides, and add-ons; routed to the grill and the kitchen.
    const fries = await menuItem(c, 'Fries', '6.00', 'Sides');
    const steak = await menuItem(c, 'Steak', '45.00', 'Mains');
    const beer = await menuItem(c, 'Belikin', '6.00', 'Drinks');
    const cooking = await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Cooking', minChoices: 1, maxChoices: 1, options: [{ name: 'Rare' }, { name: 'Medium', isDefault: true }, { name: 'Well done' }] });
    assert.equal(cooking.statusCode, 201, cooking.body);
    const sides = await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Sides', minChoices: 0, maxChoices: 2, options: [{ name: 'Rice and beans' }, { name: 'Fries', priceCents: 200, itemId: fries }] });
    assert.equal((await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Bad', minChoices: 3, maxChoices: 2, options: [{ name: 'x' }] })).statusCode, 422);
    assert.equal((await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Bad', minChoices: 2, maxChoices: 2, options: [{ name: 'x' }] })).statusCode, 422);
    const tagged = await call(c, 'PUT', `/v1/venue/items/${steak}`, { allergens: ['milk'], dietary: ['gluten-free'], course: 2, stationIds: [grill.json().id, kitchen.id], modifierGroupIds: [cooking.json().id, sides.json().id] });
    assert.deepEqual([tagged.json().allergens, tagged.json().stationIds.length, tagged.json().modifierGroupIds.length, tagged.json().course], [['milk'], 2, 2, 2]);
    assert.equal((await call(c, 'PUT', `/v1/venue/items/${steak}`, { allergens: ['kryptonite'] })).statusCode, 400);
    // A choice keeps its id when the group is edited; one left out is retired.
    const group = cooking.json().data.find((g: { name: string }) => g.name === 'Cooking');
    const edited = await call(c, 'PUT', `/v1/venue/modifier-groups/${group.id}`, { name: 'Cooking', minChoices: 1, maxChoices: 1, options: [{ id: group.options[0].id, name: 'Rare' }, { id: group.options[1].id, name: 'Medium', isDefault: true }] });
    assert.deepEqual(edited.json().data.find((g: { name: string }) => g.name === 'Cooking').options.map((o: { id: string; name: string }) => o.id), [group.options[0].id, group.options[1].id]);

    // Dinner has its own beer price; happy hour takes a quarter off drinks.
    const dinner = await call(c, 'POST', '/v1/venue/periods', { kind: 'menu', name: 'Dinner', startsMin: 17 * 60, endsMin: 22 * 60, prices: { [beer]: 700 } });
    assert.equal(dinner.statusCode, 201, dinner.body);
    const happy = await call(c, 'POST', '/v1/venue/periods', { kind: 'promotion', name: 'Happy hour', days: [1, 2, 3, 4, 5], startsMin: 16 * 60, endsMin: 18 * 60, rules: [{ kind: 'percent', percent: 25, categories: ['Drinks'] }, { kind: 'nonsense' }, { kind: 'twoForOne', itemIds: [beer] }] });
    assert.deepEqual(happy.json().data.find((p: { name: string }) => p.name === 'Happy hour').rules.map((r: { kind: string }) => r.kind), ['percent', 'twoForOne']);

    // Everything a device needs comes in one answer.
    const all = (await call(c, 'GET', '/v1/venue')).json();
    assert.deepEqual([all.on, all.floor.length, all.stations.length, all.periods.length, all.modifierGroups.length, all.taxes.gstPercent, all.taxes.hotelTaxPercent], [true, 2, 3, 2, 2, '12.5', '9']);
    assert.ok(all.taxes.unverified.length >= 1, 'what could not be verified is said so');
    const onMenu = all.items.find((i: { id: string }) => i.id === steak);
    assert.deepEqual([onMenu.priceCents, onMenu.allergens, onMenu.soldOut], [4500, ['milk'], false]);
    assert.deepEqual(all.items.find((i: { id: string }) => i.id === beer).stationIds, [bar.id], 'by its category');

    // "86": three steaks left, counted down as they are ordered; then sold out on every device.
    const kitchenHand = await c.person('Kit', 'kitchen');
    assert.equal((await call(c, 'POST', `/v1/venue/items/${steak}/availability`, { remaining: 3 }, kitchenHand.headers)).json().remaining, 3);
    const server = await c.person('Ana', 'server');
    const id = randomUUID();
    const before = (await call(c, 'GET', '/v1/venue/changes')).json().seq;
    await ops(c, server.headers, [{ checkId: id, type: 'open', payload: { kind: 'table', tableId: 't1', tableName: 'T1', partySize: 2 } }, { checkId: id, type: 'add', payload: { items: [{ id: randomUUID(), itemId: steak, quantity: 3, modifiers: [{ groupId: group.id, optionId: group.options[0].id }] }] } }]);
    const changes = (await call(c, 'GET', `/v1/venue/changes?since=${before}`)).json();
    assert.deepEqual(changes.soldOut.find((s: { id: string }) => s.id === steak), { id: steak, soldOut: true, remaining: 0 });
    assert.equal((await call(c, 'POST', `/v1/venue/items/${steak}/availability`, { soldOut: false })).json().soldOut, false);
    // A plan with a party on one of its tables is not deleted.
    assert.equal((await call(c, 'DELETE', `/v1/venue/floor/${dining.json().id}`)).json().error.code, 'tables_open');
    // Who may: a server sets nothing up.
    assert.equal((await call(c, 'POST', '/v1/venue/stations', { name: 'Mine' }, server.headers)).statusCode, 403);
    assert.equal((await call(c, 'POST', '/v1/venue/periods', { kind: 'menu', name: 'x', startsMin: 0, endsMin: 60 }, server.headers)).statusCode, 403);
  }));

test('service: two servers on a table, prices from the menu, approval by PIN, tickets per station that fail and are re-routed, the kitchen screen', () =>
  withVenue(async (c) => {
    const kitchen = (await call(c, 'POST', '/v1/venue/stations', { name: 'Kitchen', categories: ['Mains'], screen: true })).json();
    const bar = (await call(c, 'POST', '/v1/venue/stations', { name: 'Bar', categories: ['Drinks'], fallbackId: kitchen.id })).json();
    const snapper = await menuItem(c, 'Snapper', '32.00', 'Mains');
    const beer = await menuItem(c, 'Belikin', '6.00', 'Drinks');
    const temp = (await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Style', minChoices: 1, maxChoices: 1, options: [{ name: 'Grilled' }, { name: 'Fried', priceCents: 150 }] })).json();
    const style = temp.data[0];
    await call(c, 'PUT', `/v1/venue/items/${snapper}`, { allergens: ['fish'], modifierGroupIds: [style.id] });
    const ana = await c.person('Ana', 'server');
    const ben = await c.person('Ben', 'server');
    const sam = await c.person('Sam', 'supervisor', '4821');
    const kit = await c.person('Kit', 'kitchen');
    const id = randomUUID();

    await ops(c, ana.headers, [{ checkId: id, type: 'open', payload: { kind: 'table', tableId: 't7', tableName: 'Table 7', partySize: 2, allergy: 'Seat 2: shellfish' } }]);
    // The table is hers; a second party cannot be opened on it.
    assert.equal((await ops(c, ben.headers, [{ checkId: randomUUID(), type: 'open', payload: { kind: 'table', tableId: 't7', tableName: 'Table 7' } }])).results[0]!.code, 'table_taken');
    // A snapper needs its style; the price is the menu's, whatever the device says.
    const [a1, a2, b1] = [randomUUID(), randomUUID(), randomUUID()];
    const missing = await ops(c, ana.headers, [{ checkId: id, type: 'add', payload: { items: [{ id: a1, itemId: snapper, quantity: 1 }] } }]);
    assert.deepEqual([missing.results[0]!.ok, missing.results[0]!.reason], [false, 'Snapper: Style: choose one']);
    // Both servers add at the same moment; both send.
    const [fromAna, fromBen] = await Promise.all([
      ops(c, ana.headers, [{ checkId: id, type: 'add', payload: { items: [{ id: a1, itemId: snapper, quantity: 1, seat: 1, unitCents: 1, name: 'Free fish', modifiers: [{ groupId: style.id, optionId: style.options[1].id, priceCents: -5000 }] }, { id: a2, itemId: beer, quantity: 2, seat: 1, course: 0 }] } }, { checkId: id, type: 'fire' }]),
      ops(c, ben.headers, [{ checkId: id, type: 'add', payload: { items: [{ id: b1, itemId: beer, quantity: 1, seat: 2, course: 0 }] } }, { checkId: id, type: 'fire' }]),
    ]);
    const sent = [...fromAna.results, ...fromBen.results].flatMap((r) => r.sent).sort();
    assert.deepEqual(sent, [a1, a2, b1].sort(), 'each item sent once, between the two of them');
    let state = await check(c, id);
    assert.equal(state.items.length, 3);
    const fish = state.items.find((i) => i.id === a1)!;
    assert.deepEqual([fish.name, fish.unitCents, fish.modifiers[0]!.priceCents, fish.allergens, fish.stationIds], ['Snapper', 3200, 150, ['fish'], [kitchen.id]]);
    assert.ok(state.number >= 1);
    // The same operations again (the answer was lost): nothing new.
    const retry = await ops(c, ana.headers, [{ id: fromAna.results[0]!.id, checkId: id, type: 'add', payload: { items: [{ id: randomUUID(), itemId: beer }] } }]);
    assert.ok(retry.results[0]!.duplicate);
    assert.equal((await check(c, id)).items.length, 3);

    // Tickets: the kitchen got the fish with its allergy line; the bar got the beers, once each.
    const tickets = (await call(c, 'GET', '/v1/venue/changes')).json().tickets as Array<{ id: string; stationId: string; status: string; kind: string; body: { table: string; allergy: string; items: Array<{ name: string; quantity: number; modifiers: string[]; allergens: string[]; seat: number }> } }>;
    const forKitchen = tickets.filter((t) => t.stationId === kitchen.id);
    const forBar = tickets.filter((t) => t.stationId === bar.id);
    assert.deepEqual(forKitchen.map((t) => [t.status, t.body.table, t.body.allergy, t.body.items.map((i) => [i.name, i.modifiers, i.allergens])]), [['screen', 'Table 7', 'Seat 2: shellfish', [['Snapper', ['Fried'], ['fish']]]]]);
    assert.equal(forBar.reduce((a, t) => a + t.body.items.reduce((n, i) => n + i.quantity, 0), 0), 3);
    assert.ok(forBar.every((t) => t.status === 'queued'));

    // The bar printer is out of paper: the server sees it at once, retries, then re-routes to the fallback.
    const stuck = forBar[0]!;
    assert.deepEqual([(await call(c, 'POST', `/v1/venue/tickets/${stuck.id}/failed`, { error: 'Out of paper' }, ana.headers)).json().status], ['failed']);
    const seen = (await call(c, 'GET', '/v1/venue/changes', undefined, ana.headers)).json().tickets.find((t: { id: string }) => t.id === stuck.id);
    assert.deepEqual([seen.status, seen.error, seen.attempts], ['failed', 'Out of paper', 1]);
    assert.equal((await call(c, 'POST', `/v1/venue/tickets/${stuck.id}/retry`, undefined, ana.headers)).json().status, 'queued');
    await call(c, 'POST', `/v1/venue/tickets/${stuck.id}/failed`, {}, ana.headers);
    const rerouted = (await call(c, 'POST', `/v1/venue/tickets/${stuck.id}/reroute`, undefined, ana.headers)).json();
    assert.deepEqual([rerouted.stationId, rerouted.status], [kitchen.id, 'queued']);
    assert.equal((await call(c, 'POST', `/v1/venue/tickets/${stuck.id}/printed`, undefined, ana.headers)).json().status, 'printed');

    // Voiding the fish after it was sent: a server cannot, without a supervisor's PIN.
    const refused = await ops(c, ana.headers, [{ checkId: id, type: 'void', payload: { itemIds: [a1], reason: 'Changed mind' } }]);
    assert.equal(refused.results[0]!.code, 'approval_needed');
    assert.equal((await call(c, 'POST', '/v1/venue/approve', { pin: '0000' }, ana.headers)).statusCode, 401);
    const approved = await call(c, 'POST', '/v1/venue/approve', { pin: '4821' }, ana.headers);
    assert.deepEqual(approved.json(), { id: sam.id, name: 'Sam' });
    // Naming someone who is not a supervisor does not work either.
    assert.equal((await ops(c, ana.headers, [{ checkId: id, type: 'void', payload: { itemIds: [a1], reason: 'x', approvedBy: { id: ben.id, name: 'Ben' } } }])).results[0]!.code, 'approval_needed');
    const voided = await ops(c, ana.headers, [{ checkId: id, type: 'void', payload: { itemIds: [a1], reason: 'Changed mind', approvedBy: approved.json() } }]);
    assert.ok(voided.results[0]!.ok);
    state = await check(c, id);
    assert.deepEqual([state.items.find((i) => i.id === a1)!.voided!.approvedBy!.name, state.items.find((i) => i.id === a1)!.voided!.by.name], ['Sam', 'Ana']);
    // The kitchen is told to stop, on a ticket of its own.
    const after = (await call(c, 'GET', '/v1/venue/changes')).json().tickets as typeof tickets;
    assert.ok(after.some((t) => t.stationId === kitchen.id && t.kind === 'void' && t.body.items[0]!.name === 'Snapper'));
    // Every attempt is in the log, refused ones too.
    const log = (await c.f.db.query<{ type: string; ok: boolean; reason: string | null }>("select type, ok, reason from venue_ops where check_id = $1 and type = 'void' order by received_at", [id])).rows;
    assert.deepEqual(log.map((l) => l.ok), [false, false, true]);

    // The kitchen screen: bumping an order tells the floor it is ready; a bumped order can be brought back.
    const more = randomUUID();
    await ops(c, ben.headers, [{ checkId: id, type: 'add', payload: { items: [{ id: more, itemId: snapper, modifiers: [{ groupId: style.id, optionId: style.options[0].id }] }] } }, { checkId: id, type: 'fire' }]);
    const card = ((await call(c, 'GET', '/v1/venue/changes', undefined, kit.headers)).json().tickets as typeof tickets).find((t) => t.kind === 'order' && t.body.items.some((i) => i.modifiers.includes('Grilled')))!;
    const bumped = await call(c, 'POST', `/v1/venue/tickets/${card.id}/bump`, undefined, kit.headers);
    assert.ok(bumped.json().bumpedAt);
    assert.equal((await check(c, id)).items.find((i) => i.id === more)!.status, 'ready');
    assert.equal((await call(c, 'POST', `/v1/venue/tickets/${card.id}/recall`, undefined, kit.headers)).json().bumpedAt, null);
    // The kitchen takes no orders; a host neither.
    assert.equal((await ops(c, kit.headers, [{ checkId: id, type: 'add', payload: { items: [{ id: randomUUID(), itemId: beer }] } }])).results[0]!.code, 'forbidden');
    const host = await c.person('Hattie', 'host');
    assert.equal((await ops(c, host.headers, [{ checkId: id, type: 'fire' }])).results[0]!.code, 'forbidden');
  }));

test('paying: a shared bottle and a side that is stock come off once; recipes deduct by the measure; waste has its own reason', () =>
  withVenue(async (c) => {
    const track = async (id: string, quantity: string) => assert.equal((await call(c, 'PUT', `/v1/inventory/${id}/settings`, { track: true, quantity })).statusCode, 200);
    const stock = async (id: string) => (await call(c, 'GET', `/v1/inventory/${id}`)).json().stock as number;
    // Rum by the bottle in stock; a rum punch pours 0.06 of a bottle. Fries are stock, and a choice on the burger.
    const rum = await menuItem(c, 'Rum, bottle', '60.00', 'Stock');
    const punch = await menuItem(c, 'Rum punch', '8.00', 'Drinks');
    const fries = await menuItem(c, 'Fries', '6.00', 'Sides');
    const burger = await menuItem(c, 'Burger', '18.00', 'Mains');
    const wine = await menuItem(c, 'Wine, bottle', '89.90', 'Drinks');
    for (const [id, q] of [[rum, '10'], [fries, '20'], [burger, '20'], [wine, '6']] as const) await track(id, q);
    assert.equal((await call(c, 'PUT', `/v1/items/${punch}/components`, { components: [{ itemId: rum, quantity: '0.06' }] })).statusCode, 200);
    const sides = (await call(c, 'POST', '/v1/venue/modifier-groups', { name: 'Side', minChoices: 0, maxChoices: 1, options: [{ name: 'Fries', priceCents: 200, itemId: fries }] })).json().data[0];
    await call(c, 'PUT', `/v1/venue/items/${burger}`, { modifierGroupIds: [sides.id] });
    const ana = await c.person('Ana', 'server');
    const id = randomUUID();
    const [p, b, w] = [randomUUID(), randomUUID(), randomUUID()];
    await ops(c, ana.headers, [
      { checkId: id, type: 'open', payload: { kind: 'table', tableId: 't1', tableName: 'T1', partySize: 2 } },
      { checkId: id, type: 'add', payload: { items: [{ id: p, itemId: punch, quantity: 3, seat: 1 }, { id: b, itemId: burger, quantity: 2, seat: 2, modifiers: [{ groupId: sides.id, optionId: sides.options[0].id }] }, { id: w, itemId: wine, seat: 0 }] } },
      { checkId: id, type: 'fire' },
      { checkId: id, type: 'share', payload: { itemIds: [w], ways: 2 } },
    ]);
    const ctx = { servicePercent: null, gstPercent: '12.5', periods: [] };
    const one = wholeBill(await check(c, id), ctx);
    // Each guest pays their own and half the wine, on a receipt of their own.
    const totals: string[] = [];
    for (const mine of [p, b]) {
      const part = billOfItems(await check(c, id), ctx, [{ itemId: mine, shares: 1 }, { itemId: w, shares: 1 }]);
      const receipt = await call(c, 'POST', '/v1/documents', { type: '02', lines: documentLines(part, null), payment: { meansCode: '10', terms: 'Cash' } }, ana.headers);
      assert.equal(receipt.statusCode, 201, receipt.body);
      // What the server works out is what the device showed.
      assert.equal(receipt.json().totals.payable, (part.totalCents / 100).toFixed(2));
      totals.push(receipt.json().totals.payable);
      const paid = await ops(c, ana.headers, [{ checkId: id, type: 'pay', payload: { documentId: receipt.json().id, items: paymentOf(part), summary: 'Cash' } }]);
      assert.ok(paid.results[0]!.ok);
    }
    assert.equal(Math.round(totals.reduce((a, t) => a + Number(t) * 100, 0)), one.totalCents, 'two receipts, the bill to the cent');
    assert.equal((await check(c, id)).status, 'paid');
    // Stock: 3 punches poured 0.18 of a bottle; 2 burgers and their 2 fries; one bottle of wine, once.
    assert.deepEqual([await stock(rum), await stock(burger), await stock(fries), await stock(wine)], [9.82, 18, 18, 5]);
    // A dropped bottle is spillage, in the history as that.
    const kit = await c.person('Kit', 'kitchen');
    const spilt = await call(c, 'POST', '/v1/venue/waste', { itemId: rum, quantity: '1', reason: 'spillage', note: 'Dropped behind the bar' }, kit.headers);
    assert.equal(spilt.json().stock, 8.82);
    assert.equal((await call(c, 'GET', `/v1/inventory/${rum}`)).json().movements[0].reason, 'spillage');
    assert.equal((await call(c, 'POST', '/v1/venue/waste', { itemId: punch, quantity: '1', reason: 'waste', note: 'x' }, kit.headers)).json().error.code, 'not_tracked');
  }));
