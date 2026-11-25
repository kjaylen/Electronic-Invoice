/**
 * The hospitality module's pure parts: a check as a fold of operations
 * (courses, table operations, voids, two people at once), menus and
 * promotions by the clock, modifier rules, bills and their splits, and the
 * business date past midnight.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billBySeat, billOfItems, billOneShare, type BillContext, type BillPart, checkAmounts, documentLines, exactStep, paymentOf, percentCents, serviceApplies, wholeBill } from '../src/venue/bill.ts';
import { apply, type Check, fullyPaid, memoryStore, needsApproval, type Op, tableState } from '../src/venue/check.ts';
import { billPromotions, currentMenu, defaultModifiers, type ModifierGroup, modifierProblem, type Period, periodRuns, priceNow, resolveModifiers } from '../src/venue/pricing.ts';
import { belizeClock, businessDate, expectedMinutes, venueSettings } from '../src/venue/settings.ts';

const ana = { id: 'u-ana', name: 'Ana' };
const ben = { id: 'u-ben', name: 'Ben' };
const sup = { id: 'u-sup', name: 'Sam' };
let n = 0;
const op = (checkId: string, type: Op['type'], payload: Record<string, unknown> = {}, by = ana, at = `2026-11-27T19:${String(10 + (n % 50)).padStart(2, '0')}:00.000Z`): Op => ({ id: `op-${++n}`, checkId, type, at, by, payload });
const item = (id: string, name: string, unitCents: number, extra: Record<string, unknown> = {}) => ({ id, itemId: `cat-${name}`, name, unitCents, quantity: 1, gst: 'S', course: 2, seat: 1, ...extra });
const ctx: BillContext = { servicePercent: null, gstPercent: '12.5', periods: [] };

function table(id = 'c1', partySize = 4) {
  const store = memoryStore();
  const r = apply(store, op(id, 'open', { kind: 'table', tableId: 't4', tableName: 'Table 4', partySize, businessDate: '2026-11-27' }));
  assert.ok(r.ok);
  return store;
}
const get = (store: ReturnType<typeof memoryStore>, id = 'c1') => store.get(id) as Check;
const sumParts = (parts: BillPart[]) => parts.reduce((a, p) => a + p.totalCents, 0);
/** Pay a part: record it on the check as the receipt would. */
const pay = (store: ReturnType<typeof memoryStore>, part: BillPart, documentId: string, checkId = 'c1') => apply(store, op(checkId, 'pay', { documentId, items: paymentOf(part) }));

test('a check: opened, ordered by seat and course, sent once, held courses wait for the server', () => {
  const store = table();
  assert.equal(tableState(get(store)), 'seated');
  assert.ok(apply(store, op('c1', 'add', { items: [item('i1', 'Rum punch', 800, { course: 0, seat: 1 }), item('i2', 'Ceviche', 1400, { course: 1, seat: 2 }), item('i3', 'Snapper', 3200, { seat: 1 }), item('i4', 'Stew chicken', 2200, { seat: 2, note: 'no onions' })] })).ok);
  assert.equal(tableState(get(store)), 'ordered');
  // Mains are held; "send" takes the drinks and starters only.
  apply(store, op('c1', 'holdCourse', { course: 2 }));
  const first = apply(store, op('c1', 'fire'));
  assert.deepEqual(first.sent, ['i1', 'i2']);
  assert.equal(tableState(get(store)), 'sent');
  // Sending again sends nothing: nothing is doubled.
  assert.deepEqual(apply(store, op('c1', 'fire')).sent, []);
  // The server fires the mains.
  assert.deepEqual(apply(store, op('c1', 'fire', { course: 2 })).sent, ['i3', 'i4']);
  assert.deepEqual(get(store).heldCourses, []);
  // The kitchen says ready; the server serves; the floor shows the stage reached.
  apply(store, op('c1', 'ready', { itemIds: ['i3', 'i4'] }, ben));
  assert.equal(get(store).items.find((i) => i.id === 'i3')!.status, 'ready');
  apply(store, op('c1', 'served', { course: 2 }));
  assert.equal(tableState(get(store)), 'mains');
  apply(store, op('c1', 'requestBill'));
  assert.equal(tableState(get(store)), 'bill');
  // An item sent cannot be changed, only voided; one not yet sent can.
  assert.match(apply(store, op('c1', 'edit', { itemId: 'i4', quantity: 2 })).reason!, /already sent/);
  apply(store, op('c1', 'add', { items: [item('i5', 'Flan', 900, { course: 3 })] }));
  assert.ok(apply(store, op('c1', 'edit', { itemId: 'i5', quantity: 2, seat: 2, note: 'two spoons' })).ok);
  assert.deepEqual([get(store).items.find((i) => i.id === 'i5')!.quantity, get(store).items.find((i) => i.id === 'i5')!.seat], [2, 2]);
  // Seat can change after sending (who gets it), the dish cannot.
  assert.ok(apply(store, op('c1', 'edit', { itemId: 'i4', seat: 3 })).ok);
});

test('two servers on one table: nothing is lost, nothing goes to the kitchen twice, whatever the order', () => {
  const ops: Op[] = [
    op('c1', 'open', { kind: 'table', tableId: 't1', tableName: 'Table 1', partySize: 2 }),
    op('c1', 'add', { items: [item('a1', 'Beer', 600), item('a2', 'Nachos', 1500)] }, ana),
    op('c1', 'add', { items: [item('b1', 'Beer', 600), item('b2', 'Wings', 1800)] }, ben),
    op('c1', 'fire', {}, ana),
    op('c1', 'fire', {}, ben),
    op('c1', 'add', { items: [item('a3', 'Water', 300)] }, ana),
    op('c1', 'fire', {}, ben),
  ];
  // The server's order, and a device that heard Ben before Ana.
  const orders = [ops, [ops[0]!, ops[2]!, ops[1]!, ops[4]!, ops[3]!, ops[5]!, ops[6]!]];
  for (const order of orders) {
    const store = memoryStore();
    const sent: string[] = [];
    for (const o of order) sent.push(...apply(store, o).sent);
    // Every operation again, as a retry after a lost answer: nothing changes.
    const version = get(store).version;
    for (const o of order) {
      const again = apply(store, o);
      assert.ok(again.duplicate);
      assert.deepEqual(again.sent, []);
    }
    assert.equal(get(store).version, version);
    assert.deepEqual(get(store).items.map((i) => i.id).sort(), ['a1', 'a2', 'a3', 'b1', 'b2']);
    assert.deepEqual(sent.sort(), ['a1', 'a2', 'a3', 'b1', 'b2'], 'each item sent exactly once');
    assert.ok(get(store).items.every((i) => i.status === 'sent'));
  }
  // The same item id arriving twice (a retried add under a new operation id) is still one item.
  const store = memoryStore();
  apply(store, ops[0]!);
  apply(store, op('c1', 'add', { items: [item('x1', 'Beer', 600)] }));
  apply(store, op('c1', 'add', { items: [item('x1', 'Beer', 600)] }));
  assert.equal(get(store).items.length, 1);
});

test('voids, comps, discounts and price changes: what needs a supervisor, and what is written down', () => {
  const store = table();
  apply(store, op('c1', 'add', { items: [item('i1', 'Lobster', 6000), item('i2', 'Beer', 600), item('i3', 'Soup', 1000)] }));
  // Before sending: off it comes, no approval, no reason.
  const remove = op('c1', 'void', { itemIds: ['i3'] });
  assert.equal(needsApproval(get(store), remove, 10), false);
  assert.ok(apply(store, remove).ok);
  apply(store, op('c1', 'fire'));
  // After sending: a supervisor and a reason; the kitchen is told.
  const voidAfter = op('c1', 'void', { itemIds: ['i2'], reason: 'Dropped', approvedBy: sup });
  assert.equal(needsApproval(get(store), voidAfter, 10), true);
  assert.match(apply(store, op('c1', 'void', { itemIds: ['i2'] })).reason!, /why/);
  const voided = apply(store, voidAfter);
  assert.deepEqual(voided.voided, ['i2']);
  const beer = get(store).items.find((i) => i.id === 'i2')!;
  assert.deepEqual([beer.status, beer.voided!.reason, beer.voided!.afterSend, beer.voided!.approvedBy!.name, beer.voided!.by.name], ['void', 'Dropped', true, 'Sam', 'Ana']);
  // Discounts up to the limit are the server's; over it, a supervisor's. Comps and price changes always.
  assert.equal(needsApproval(get(store), op('c1', 'discount', { itemIds: ['i1'], percent: 10, reason: 'Regular' }), 10), false);
  assert.equal(needsApproval(get(store), op('c1', 'discount', { itemIds: ['i1'], percent: 15, reason: 'Regular' }), 10), true);
  assert.equal(needsApproval(get(store), op('c1', 'discount', { itemIds: ['i1'], cents: 700, reason: 'Regular' }), 10), true);
  assert.equal(needsApproval(get(store), op('c1', 'comp', { itemIds: ['i1'], reason: 'Birthday' }), 10), true);
  assert.equal(needsApproval(get(store), op('c1', 'price', { itemId: 'i1', unitCents: 5000, reason: 'Small one' }), 10), true);
  assert.equal(needsApproval(get(store), op('c1', 'service', { on: false }), 10), true);
  assert.match(apply(store, op('c1', 'comp', { itemIds: ['i1'] })).reason!, /why/);
  apply(store, op('c1', 'discount', { itemIds: ['i1'], percent: 15, reason: 'Regular', approvedBy: sup }));
  assert.equal(wholeBill(get(store), ctx).allowCents, 900);
  apply(store, op('c1', 'comp', { itemIds: ['i1'], reason: 'Birthday', approvedBy: sup }));
  const bill = wholeBill(get(store), ctx);
  assert.deepEqual([bill.subtotalCents, bill.allowCents, bill.totalCents, bill.lines[0]!.allowReason], [6000, 6000, 0, 'Complimentary: Birthday']);
  // Every one of them is in the check's own log, with who and why.
  const log = get(store).events.map((e) => [e.type, e.by.name, e.approvedBy?.name ?? '', e.note ?? '']);
  assert.ok(log.some((e) => e[0] === 'voided' && e[2] === 'Sam' && e[3] === 'Dropped'));
  assert.ok(log.some((e) => e[0] === 'comped' && e[2] === 'Sam' && e[3] === 'Birthday'));
  assert.ok(log.some((e) => e[0] === 'discounted' && /15%: Regular/.test(e[3]!)));
});

test('table operations: move, transfer to another server, items to another table, a tab to a table, merge', () => {
  const store = memoryStore();
  apply(store, op('c1', 'open', { kind: 'table', tableId: 't1', tableName: 'Table 1', partySize: 2 }));
  apply(store, op('c2', 'open', { kind: 'table', tableId: 't2', tableName: 'Table 2', partySize: 3 }, ben));
  apply(store, op('tab', 'open', { kind: 'tab', name: 'Maria' }, ben));
  apply(store, op('c1', 'add', { items: [item('a1', 'Beer', 600), item('a2', 'Fries', 900)] }));
  apply(store, op('tab', 'add', { items: [item('m1', 'Mojito', 1200), item('m2', 'Mojito', 1200)] }, ben));
  apply(store, op('c1', 'fire'));
  // The party moves: same check, another table; what was sent stays sent.
  assert.ok(apply(store, op('c1', 'move', { tableId: 't9', tableName: 'Patio 3' })).ok);
  assert.deepEqual([get(store).tableId, get(store).tableName, get(store).items[0]!.status], ['t9', 'Patio 3', 'sent']);
  // Another server takes the table.
  apply(store, op('c1', 'transfer', { server: ben }));
  assert.equal(get(store).server.name, 'Ben');
  // One item goes to table 2; both checks change in the one operation, once.
  const moved = op('c1', 'moveItems', { itemIds: ['a2'], toCheckId: 'c2' });
  const r = apply(store, moved);
  assert.deepEqual(r.touched.sort(), ['c1', 'c2']);
  assert.deepEqual([get(store).items.map((i) => i.id), get(store, 'c2').items.map((i) => i.id)], [['a1'], ['a2']]);
  assert.ok(apply(store, moved).duplicate);
  assert.equal(get(store, 'c2').items.length, 1);
  // Maria's bar tab follows her to table 2.
  apply(store, op('tab', 'merge', { toCheckId: 'c2' }, ben));
  assert.equal(get(store, 'tab').status, 'merged');
  assert.deepEqual([get(store, 'c2').items.map((i) => i.id), get(store, 'c2').partySize], [['a2', 'm1', 'm2'], 4]);
  assert.match(apply(store, op('tab', 'add', { items: [item('m3', 'Mojito', 1200)] })).reason!, /merged/);
  // Splitting a table: a new check takes some of the items.
  apply(store, op('c3', 'open', { kind: 'table', tableId: 't3', tableName: 'Table 3', partySize: 1 }));
  apply(store, op('c2', 'moveItems', { itemIds: ['m2'], toCheckId: 'c3' }));
  assert.deepEqual(get(store, 'c3').items.map((i) => i.id), ['m2']);
  // Nothing was lost on the way: every item is on exactly one open check.
  const everywhere = store.all().filter((c) => c.status === 'open').flatMap((c) => c.items.map((i) => i.id)).sort();
  assert.deepEqual(everywhere, ['a1', 'a2', 'm1', 'm2']);
});

test('menus by the clock, happy hour that starts and stops by itself, two for one and bundles', () => {
  const periods: Period[] = [
    { id: 'p-b', kind: 'menu', name: 'Breakfast', days: [0, 1, 2, 3, 4, 5, 6], startsMin: 6 * 60, endsMin: 11 * 60, categories: ['Breakfast', 'Drinks'], prices: {}, rules: [], active: true, position: 0 },
    { id: 'p-d', kind: 'menu', name: 'Dinner', days: [0, 1, 2, 3, 4, 5, 6], startsMin: 17 * 60, endsMin: 22 * 60, categories: [], prices: { beer: 700 }, rules: [], active: true, position: 1 },
    { id: 'p-l', kind: 'menu', name: 'Late night', days: [5, 6], startsMin: 22 * 60, endsMin: 2 * 60, categories: ['Drinks'], prices: {}, rules: [], active: true, position: 2 },
    { id: 'hh', kind: 'promotion', name: 'Happy hour', days: [1, 2, 3, 4, 5], startsMin: 16 * 60, endsMin: 18 * 60, categories: [], prices: {}, active: true, position: 0,
      rules: [{ kind: 'percent', percent: 25, categories: ['Drinks'], itemIds: [] }, { kind: 'price', itemId: 'rum', priceCents: 500 }, { kind: 'twoForOne', categories: [], itemIds: ['mojito'] }, { kind: 'bundle', name: 'Burger and beer', itemIds: ['burger', 'beer'], priceCents: 2000 }] },
  ];
  assert.equal(currentMenu(periods, 7 * 60, 3)?.name, 'Breakfast');
  assert.equal(currentMenu(periods, 12 * 60, 3), null, 'between periods: the whole catalog');
  assert.equal(currentMenu(periods, 12 * 60, 3, 'p-d')?.name, 'Dinner', 'a manager can override');
  // Friday's late night runs into Saturday morning; Sunday's small hours belong to Saturday.
  assert.ok(periodRuns(periods[2]!, 23 * 60, 5) && periodRuns(periods[2]!, 60, 6) && periodRuns(periods[2]!, 60, 0));
  assert.ok(!periodRuns(periods[2]!, 60, 5) && !periodRuns(periods[2]!, 3 * 60, 6));
  const beer = { id: 'beer', category: 'Drinks', priceCents: 600 };
  // 5:59 pm: happy hour price. 6:00 pm: it has stopped, and dinner's price is in force.
  assert.deepEqual(priceNow(beer, periods, 17 * 60 + 59, 5), { priceCents: 525, promo: 'Happy hour', tags: ['hh:3'] });
  assert.deepEqual(priceNow(beer, periods, 18 * 60, 5), { priceCents: 700, tags: [] });
  assert.deepEqual(priceNow(beer, periods, 16 * 60 + 30, 6), { priceCents: 600, tags: [] }, 'not on Saturday');
  assert.equal(priceNow({ id: 'rum', category: 'Spirits', priceCents: 900 }, periods, 16 * 60, 1).priceCents, 500);
  // Two for one: of three mojitos ordered in happy hour, one is free; one ordered after it is not part of it.
  const units = [0, 1, 2].map((k) => ({ key: `m${k}`, itemId: 'mojito', unitCents: 1200, tags: ['hh:2'] }));
  const off = billPromotions([...units, { key: 'late', itemId: 'mojito', unitCents: 1200, tags: [] }], periods);
  assert.deepEqual([...off.entries()], [['m1', { cents: 1200, name: 'Happy hour' }]]);
  // A bundle: burger 1800 + beer 525 for 2000; the saving is spread, to the cent.
  const bundle = billPromotions([{ key: 'b', itemId: 'burger', unitCents: 1800, tags: ['hh:3'] }, { key: 'r', itemId: 'beer', unitCents: 525, tags: ['hh:3'] }], periods);
  assert.equal([...bundle.values()].reduce((a, v) => a + v.cents, 0), 325);
  assert.equal(bundle.get('r')!.name, 'Burger and beer');
  // On a check: the price is the one when ordered; the free one shows as an allowance.
  const store = table();
  apply(store, op('c1', 'add', { items: [item('i1', 'Mojito', 1200, { itemId: 'mojito', tags: ['hh:2'], quantity: 3 }), item('i2', 'Mojito', 1200, { itemId: 'mojito' })] }));
  const bill = wholeBill(get(store), { ...ctx, periods });
  assert.deepEqual([bill.subtotalCents, bill.allowCents, bill.lines[0]!.allowReason], [4800, 1200, 'Happy hour']);
});

test('modifier rules: required, at least and at most, defaults, and prices from the menu not the device', () => {
  const groups: ModifierGroup[] = [
    { id: 'temp', name: 'Cooking', minChoices: 1, maxChoices: 1, options: [{ id: 'rare', name: 'Rare', priceCents: 0, isDefault: false }, { id: 'med', name: 'Medium', priceCents: 0, isDefault: true }] },
    { id: 'sides', name: 'Sides', minChoices: 2, maxChoices: 2, options: [{ id: 'rice', name: 'Rice and beans', priceCents: 0, isDefault: true }, { id: 'slaw', name: 'Coleslaw', priceCents: 0, isDefault: true }, { id: 'fries', name: 'Fries', priceCents: 200, isDefault: false, itemId: 'cat-fries' }] },
    { id: 'extra', name: 'Add-ons', minChoices: 0, maxChoices: 3, options: [{ id: 'bacon', name: 'Bacon', priceCents: 350, isDefault: false }, { id: 'noon', name: 'No onions', priceCents: 0, isDefault: false }] },
  ];
  assert.deepEqual(defaultModifiers(groups).map((m) => m.name), ['Medium', 'Rice and beans', 'Coleslaw']);
  const pick = (...pairs: string[]) => pairs.map((p) => ({ groupId: p.split(':')[0]!, optionId: p.split(':')[1]! }));
  assert.equal(modifierProblem(groups, pick('temp:med', 'sides:rice', 'sides:fries', 'extra:bacon')), null);
  assert.equal(modifierProblem(groups, pick('sides:rice', 'sides:fries')), 'Cooking: choose one');
  assert.equal(modifierProblem(groups, pick('temp:med', 'temp:rare', 'sides:rice', 'sides:fries')), 'Cooking: only one');
  assert.equal(modifierProblem(groups, pick('temp:med', 'sides:rice')), 'Sides: choose at least 2');
  assert.equal(modifierProblem(groups, pick('temp:med', 'sides:rice', 'sides:slaw', 'sides:fries')), 'Sides: at most 2');
  assert.equal(modifierProblem(groups, pick('temp:med', 'sides:rice', 'sides:rice')), 'Sides: each choice once');
  assert.equal(modifierProblem(groups, pick('temp:med', 'sides:rice', 'sides:slaw', 'extra:cheese')), 'That choice is not on this item');
  const resolved = resolveModifiers(groups, pick('temp:rare', 'sides:rice', 'sides:fries', 'extra:bacon'));
  assert.deepEqual(resolved.map((m) => [m.name, m.priceCents, m.itemId ?? null]), [['Rare', 0, null], ['Rice and beans', 0, null], ['Fries', 200, 'cat-fries'], ['Bacon', 350, null]]);
  // On the check the modifiers are in the line's price.
  const store = table();
  apply(store, op('c1', 'add', { items: [item('i1', 'Steak', 4500, { modifiers: resolved, quantity: 2 })] }));
  const bill = wholeBill(get(store), ctx);
  assert.deepEqual([bill.lines[0]!.description, bill.lines[0]!.unitCents, bill.subtotalCents], ['Steak (Rare, Rice and beans, Fries, Bacon)', 5050, 10100]);
});

test('the service charge rule, and GST to the cent', () => {
  assert.equal(percentCents(2463, '12.5'), 308);
  assert.equal(percentCents(4, '12.5'), 1, 'half a cent goes up');
  assert.equal(percentCents(1999, '10'), 200);
  assert.equal(exactStep('12.5'), 8);
  assert.equal(exactStep('10'), 10);
  const store = table('c1', 4);
  const check = get(store);
  assert.equal(serviceApplies(check, { serviceCharge: 'off', servicePartySize: 6 }), false);
  assert.equal(serviceApplies(check, { serviceCharge: 'all', servicePartySize: 6 }), true);
  assert.equal(serviceApplies(check, { serviceCharge: 'party', servicePartySize: 6 }), false);
  assert.equal(serviceApplies({ ...check, partySize: 6 }, { serviceCharge: 'party', servicePartySize: 6 }), true);
  // Someone's decision on the check wins: taken off (with permission), or added for a small party.
  assert.equal(serviceApplies({ ...check, serviceCharge: false }, { serviceCharge: 'all', servicePartySize: 6 }), false);
  assert.equal(serviceApplies({ ...check, serviceCharge: true }, { serviceCharge: 'party', servicePartySize: 6 }), true);
  // 10% on what is charged after discounts; GST on both.
  apply(store, op('c1', 'add', { items: [item('i1', 'Snapper', 3333), item('i2', 'Juice', 450, { gst: 'Z' })] }));
  apply(store, op('c1', 'discount', { itemIds: ['i1'], percent: 10, reason: 'Local' }));
  const bill = wholeBill(get(store), { ...ctx, servicePercent: '10' });
  // Snapper 33.33 - 3.33 = 30.00, service 3.00; juice 4.50, service 0.45. GST 12.5% of 33.00 = 4.13 (4.125 up).
  assert.deepEqual([bill.subtotalCents, bill.allowCents, bill.serviceCents, bill.gstCents, bill.totalCents], [3783, 333, 345, 413, 4208]);
  assert.deepEqual(documentLines(bill, '10').map((l) => (l.allowanceCharges as Array<{ isCharge: boolean; amount: string }>).filter((a) => a.isCharge).map((a) => a.amount)), [['3.00'], ['0.45']]);
  // When the tax rules say the service charge carries no GST: the same charge, GST on the food only (12.5% of 30.00),
  // and on the receipt it is one exempt line, not a charge on each line.
  const untaxed = { ...ctx, servicePercent: '10', serviceUntaxed: { exemptionReasonCode: 'SERVICE' } };
  const plain = wholeBill(get(store), untaxed);
  assert.deepEqual([plain.subtotalCents, plain.allowCents, plain.serviceCents, plain.gstCents, plain.totalCents], [3783, 333, 345, 375, 4170]);
  const lines = documentLines(plain, '10', untaxed.serviceUntaxed);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2], { description: 'Service charge 10%', quantity: '1', unitCode: 'C62', unitPrice: '3.45', gstCategory: 'E', exemptionReasonCode: 'SERVICE' });
  assert.ok(lines.slice(0, 2).every((l) => !(l.allowanceCharges as Array<{ isCharge: boolean }> | undefined)?.some((a) => a.isCharge)));
});

test('splitting a bill: by seat, by item, a shared item, and evenly: the parts add up to the bill exactly', () => {
  // By seat, with a bottle shared by the table of three.
  const store = table('c1', 3);
  apply(store, op('c1', 'add', { items: [
    item('s1', 'Snapper', 3295, { seat: 1 }), item('s2', 'Stew chicken', 2150, { seat: 2 }), item('s3', 'Lobster', 6475, { seat: 3 }),
    item('w', 'Wine, bottle', 8990, { seat: 0, course: 0 }), item('d', 'Juice', 450, { seat: 2, gst: 'Z', course: 0 }),
  ] }));
  const service = { ...ctx, servicePercent: '10' };
  const whole = wholeBill(get(store), service);
  apply(store, op('c1', 'share', { itemIds: ['w'], ways: 3 }));
  assert.equal(wholeBill(get(store), service).totalCents, whole.totalCents, 'sharing changes nothing of the total');
  // Each guest: their seat's items and a third of the wine.
  const paidTotals: number[] = [];
  for (const seat of [1, 2, 3]) {
    const check = get(store);
    const mine = check.items.filter((i) => i.seat === seat).map((i) => ({ itemId: i.id, shares: 1 }));
    const part = billOfItems(check, service, [...mine, { itemId: 'w', shares: 1 }], `Seat ${seat}`);
    if (seat < 3) assert.equal(part.lines.filter((l) => l.gst === 'S').reduce((a, l) => a + l.netCents, 0) % 8, 0, 'not the last part: its GST has nothing to round');
    paidTotals.push(part.totalCents);
    assert.ok(pay(store, part, `doc-${seat}`).ok);
  }
  assert.equal(paidTotals.reduce((a, b) => a + b, 0), whole.totalCents, 'three receipts, the same total as one');
  assert.equal(get(store).status, 'paid');
  assert.ok(get(store).items.every(fullyPaid));
  assert.equal(tableState(get(store)), 'paid');
  // The wine's three slices are the bottle, to the cent.
  const wine = get(store).items.find((i) => i.id === 'w')!;
  assert.equal(wine.paid.reduce((a, p) => a + p.grossCents!, 0), 8990);
  assert.equal(wine.paid.reduce((a, p) => a + p.serviceCents!, 0), 899);
  apply(store, op('c1', 'clean'));
  assert.equal(tableState(get(store)), 'free');

  // Evenly, many bills: every way from 2 to 7, awkward prices, with and without the service charge.
  let seed = 7;
  const rand = (max: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % max;
  for (let round = 0; round < 150; round++) {
    const ways = 2 + rand(6);
    const s = memoryStore();
    apply(s, op('e', 'open', { kind: 'table', tableId: 't', tableName: 'T', partySize: ways }));
    const count = 1 + rand(7);
    apply(s, op('e', 'add', { items: Array.from({ length: count }, (_, k) => item(`x${k}`, `Dish ${k}`, 95 + rand(9000), { quantity: 1 + rand(3), gst: rand(5) === 0 ? 'Z' : 'S' })) }));
    if (rand(3) === 0) apply(s, op('e', 'discount', { itemIds: ['x0'], percent: 5 + rand(40), reason: 'Promo' }));
    const c: BillContext = { ...ctx, servicePercent: rand(2) ? '10' : null, serviceUntaxed: rand(2) ? { exemptionReasonCode: 'SERVICE' } : null };
    const one = wholeBill(s.get('e')!, c);
    apply(s, op('e', 'share', { itemIds: s.get('e')!.items.map((i) => i.id), ways }));
    const parts: BillPart[] = [];
    for (let k = 0; k < ways; k++) {
      const part = billOneShare(s.get('e')!, c);
      parts.push(part);
      assert.ok(pay(s, part, `d${k}`, 'e').ok);
    }
    assert.equal(parts.reduce((a, p) => a + p.subtotalCents - p.allowCents + p.serviceCents, 0), one.subtotalCents - one.allowCents + one.serviceCents, 'before GST, to the cent');
    assert.equal(sumParts(parts), one.totalCents, `round ${round}: ${ways} ways`);
    assert.ok(s.get('e')!.items.every(fullyPaid));
    // Even means even: no part more than a few cents from another, except the last by what the others left.
    const first = parts.slice(0, -1).map((p) => p.totalCents);
    assert.ok(Math.max(...first) - Math.min(...first) <= 8 + 2 * count, 'the parts that are not last are within a few cents of each other');
    assert.ok(Math.abs(parts[parts.length - 1]!.totalCents - first[0]!) <= 9 * ways + count * ways);
  }

  // By seat with whole items only: each receipt is right by itself, and nothing before GST moves between them.
  const t = table('c9', 2);
  apply(t, op('c9', 'add', { items: [item('a', 'Soup', 1111, { seat: 1 }), item('b', 'Salad', 1333, { seat: 2 })] }));
  const seats = billBySeat(t.get('c9')!, ctx);
  assert.deepEqual(seats.map((p) => [p.label, p.subtotalCents, p.gstCents]), [['Seat 1', 1111, 139], ['Seat 2', 1333, 167]]);
  // A payment that arrives twice (the till retried) counts once; paying more shares than are left takes only what is left.
  const again = billOfItems(t.get('c9')!, ctx, [{ itemId: 'a', shares: 1 }]);
  pay(t, again, 'doc-a', 'c9');
  apply(t, op('c9', 'pay', { documentId: 'doc-a', items: paymentOf(again) }));
  assert.equal(t.get('c9')!.items.find((i) => i.id === 'a')!.paid.length, 1);
  assert.match(apply(t, op('c9', 'void', { itemIds: ['a'], reason: 'x' })).reason!, /already paid/);
  assert.equal(checkAmounts(t.get('c9')!, ctx).get('b')!.grossCents, 1333);
});

test('the business date: sales after midnight stay on the evening they belong to', () => {
  // Belize is UTC-6. Friday 27 Nov, 11:30 pm; Saturday 1:30 am; Saturday 4:00 am (the day has ended); Saturday noon.
  assert.equal(businessDate(new Date('2026-11-28T05:30:00Z'), 4), '2026-11-27');
  assert.equal(businessDate(new Date('2026-11-28T07:30:00Z'), 4), '2026-11-27');
  assert.equal(businessDate(new Date('2026-11-28T10:00:00Z'), 4), '2026-11-28');
  assert.equal(businessDate(new Date('2026-11-28T18:00:00Z'), 4), '2026-11-28');
  // A venue that closes at midnight rolls at midnight; the last minute of the year.
  assert.equal(businessDate(new Date('2026-11-28T06:30:00Z'), 0), '2026-11-28');
  assert.equal(businessDate(new Date('2027-01-01T07:00:00Z'), 4), '2026-12-31');
  assert.deepEqual(belizeClock(new Date('2026-11-28T00:05:00Z')), { minutes: 18 * 60 + 5, weekday: 5 });
  // Settings made whole: a shop has none of it on; odd values fall back.
  const v = venueSettings({ restaurant: true, servicePercent: '55', dayEndsHour: 30, usdRateCents: 200 });
  assert.deepEqual([v.restaurant, v.bar, v.hotel, v.servicePercent, v.dayEndsHour, v.usdRateCents], [true, false, false, '10', 4, 200]);
  assert.deepEqual([expectedMinutes(v, 2), expectedMinutes(v, 5), expectedMinutes(v, 40)], [75, 105, 120]);
});
