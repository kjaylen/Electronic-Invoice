/**
 * The menu's sections: item categories in the business's order. Made empty ahead of time, ordered,
 * renamed everywhere the category is named (items, stations, menus by the clock, promotions), two
 * joined by renaming one to the other, removed with their items moved; items moved one or many at once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, menuItem, withVenue } from './venue-helpers.ts';

type Sections = { data: Array<{ name: string; items: number }> };
const names = (r: Sections) => r.data.map((s) => `${s.name}:${s.items}`);

test('menu sections: order, empty ones, rename everywhere, join, remove, move items', () =>
  withVenue(async (c) => {
    const nachos = await menuItem(c, 'Nachos', '12', 'Starters');
    const fish = await menuItem(c, 'Fried fish', '25', 'Mains');
    const rice = await menuItem(c, 'Rice and beans', '15', 'mains');
    const beer = await menuItem(c, 'Belikin', '6', 'Drinks');
    const cake = await menuItem(c, 'Coconut cake', '8', 'Drinks');
    await call(c, 'POST', '/v1/venue/items/move', { itemIds: [cake], section: null });

    // In use but never ordered: A to Z, with how many items each has; the spellings join ("mains" is "Mains").
    let r = await call(c, 'GET', '/v1/venue/menu-sections');
    assert.deepEqual(names(r.json()), ['Drinks:1', 'Mains:2', 'Starters:1']);
    assert.deepEqual(names({ data: (await call(c, 'GET', '/v1/venue')).json().menuSections }), ['Drinks:1', 'Mains:2', 'Starters:1']);

    // A section made before anything is in it, at the end; the same name twice is refused.
    r = await call(c, 'POST', '/v1/venue/menu-sections', { name: '  Desserts ' });
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(names(r.json()), ['Drinks:1', 'Mains:2', 'Starters:1', 'Desserts:0']);
    assert.equal((await call(c, 'POST', '/v1/venue/menu-sections', { name: 'desserts' })).statusCode, 409);

    // The order the menu is read in.
    r = await call(c, 'PUT', '/v1/venue/menu-sections', { order: ['Starters', 'Mains', 'Desserts', 'Drinks'] });
    assert.deepEqual(names(r.json()), ['Starters:1', 'Mains:2', 'Desserts:0', 'Drinks:1']);

    // Items in, one or several at once; out of every section with null.
    r = await call(c, 'POST', '/v1/venue/items/move', { itemIds: [cake], section: 'desserts' });
    assert.equal(r.json().section, 'Desserts');
    assert.deepEqual(names(r.json()), ['Starters:1', 'Mains:2', 'Desserts:1', 'Drinks:1']);
    r = await call(c, 'POST', '/v1/venue/items/move', { itemIds: [nachos, fish], section: null });
    assert.equal(r.json().moved, 2);
    r = await call(c, 'POST', '/v1/venue/items/move', { itemIds: [nachos], section: 'Starters' });
    r = await call(c, 'POST', '/v1/venue/items/move', { itemIds: [fish], section: 'Mains' });
    assert.deepEqual(names(r.json()), ['Starters:1', 'Mains:2', 'Desserts:1', 'Drinks:1']);

    // A station and a menu by the clock that name a section, and a promotion on it.
    const station = (await call(c, 'POST', '/v1/venue/stations', { name: 'Kitchen', categories: ['Mains', 'Starters'], deviceId: null, screen: true, fallbackId: null, targetMin: 12, position: 0 })).json();
    const lunch = await call(c, 'POST', '/v1/venue/periods', { kind: 'menu', name: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], startsMin: 660, endsMin: 900, categories: ['Mains'], prices: {}, rules: [], active: true, position: 0 });
    assert.equal(lunch.statusCode, 201, lunch.body);
    const promo = await call(c, 'POST', '/v1/venue/periods', { kind: 'promotion', name: 'Happy hour', days: [5], startsMin: 960, endsMin: 1080, categories: [], prices: {}, rules: [{ kind: 'percent', percent: 20, categories: ['Mains', 'Drinks'], itemIds: [] }], active: true, position: 1 });
    assert.equal(promo.statusCode, 201, promo.body);

    // Renaming renames it everywhere, keeping its place.
    r = await call(c, 'POST', '/v1/venue/menu-sections/rename', { from: 'mains', to: 'Main dishes' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(names(r.json()), ['Starters:1', 'Main dishes:2', 'Desserts:1', 'Drinks:1']);
    const venue = (await call(c, 'GET', '/v1/venue')).json();
    assert.deepEqual(venue.items.filter((i: { id: string }) => [fish, rice].includes(i.id)).map((i: { category: string }) => i.category), ['Main dishes', 'Main dishes']);
    assert.deepEqual(venue.stations.find((s: { id: string }) => s.id === (station.id ?? station.data?.[0]?.id))?.categories ?? venue.stations[0].categories, ['Main dishes', 'Starters']);
    const periods = venue.periods as Array<{ name: string; categories: string[]; rules: Array<{ categories: string[] }> }>;
    assert.deepEqual(periods.find((p) => p.name === 'Lunch')!.categories, ['Main dishes']);
    assert.deepEqual(periods.find((p) => p.name === 'Happy hour')!.rules[0]!.categories, ['Main dishes', 'Drinks']);

    // Renaming one section to another's name joins them (the other's spelling and place win).
    r = await call(c, 'POST', '/v1/venue/menu-sections/rename', { from: 'Starters', to: 'MAIN DISHES' });
    assert.equal(r.json().name, 'Main dishes');
    assert.deepEqual(names(r.json()), ['Main dishes:3', 'Desserts:1', 'Drinks:1']);
    const kitchen = (await call(c, 'GET', '/v1/venue')).json().stations[0].categories;
    assert.deepEqual(kitchen, ['Main dishes']);

    // Removing a section moves its items (and what named it) to another, or to none.
    r = await call(c, 'POST', '/v1/venue/menu-sections/remove', { name: 'Desserts', moveTo: 'Main dishes' });
    assert.deepEqual(names(r.json()), ['Main dishes:4', 'Drinks:1']);
    r = await call(c, 'POST', '/v1/venue/menu-sections/remove', { name: 'Drinks', moveTo: null });
    assert.deepEqual(names(r.json()), ['Main dishes:4']);
    const after = (await call(c, 'GET', '/v1/venue')).json();
    assert.equal(after.items.find((i: { id: string }) => i.id === beer).category, null);
    assert.deepEqual((after.periods as typeof periods).find((p) => p.name === 'Happy hour')!.rules[0]!.categories, ['Main dishes']);
    assert.equal((await call(c, 'POST', '/v1/venue/menu-sections/remove', { name: 'Nope', moveTo: null })).statusCode, 404);

    // The same sections are the products' categories.
    const cats = (await call(c, 'GET', '/v1/items/categories')).json().data.map((x: { name: string; items: number }) => `${x.name}:${x.items}`);
    assert.deepEqual(cats, ['Main dishes:4']);

    // Only people who manage the catalog arrange the menu; servers see it.
    const server = await c.person('Sam', 'server');
    assert.equal((await call(c, 'GET', '/v1/venue/menu-sections', undefined, server.headers)).statusCode, 200);
    assert.equal((await call(c, 'POST', '/v1/venue/menu-sections', { name: 'Specials' }, server.headers)).statusCode, 403);
    assert.equal((await call(c, 'POST', '/v1/venue/items/move', { itemIds: [beer], section: 'Specials' }, server.headers)).statusCode, 403);
  }));

test('menu sections need a restaurant or bar', () =>
  withVenue(async (c) => {
    assert.equal((await call(c, 'POST', '/v1/venue/menu-sections', { name: 'Starters' })).statusCode, 409);
  }, null));
