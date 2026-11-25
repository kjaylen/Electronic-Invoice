/**
 * The hotel in a real browser: rooms and rates, a booking with a deposit,
 * check-in, a bar sale charged to the room (the guest's name confirmed at
 * the till), the night audit, housekeeping, and check-out paid in two parts.
 * Then the host stand: a table booking seated from the floor with its allergy.
 *
 * Runs after app.spec.ts, on the business it sets up; turns the module off again.
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };

async function logIn(page: Page) {
  await page.goto(`/${SLUG}/login`);
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}
const get = async (page: Page, url: string) => (await page.request.get(url, { headers: API })).json();
const send = async (page: Page, method: 'post' | 'put' | 'delete', url: string, data?: unknown) => {
  const r = await page.request[method](url, { headers: API, ...(data !== undefined && { data }) });
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
};
/** Pick from one of the app's select menus (a button that opens a list, drawn over the page). */
async function choose(page: Page, label: string | RegExp, option: string | RegExp, within: Page | Locator = page) {
  await within.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).first().click();
}

test('hotel: a booking with a deposit, check-in, a drink charged to the room, the night audit, housekeeping, check-out in two payments', async ({ page }) => {
  await logIn(page);
  await send(page, 'put', '/v1/venue/settings', { restaurant: true, bar: true, hotel: true, serviceCharge: 'off' });
  const run = Date.now().toString().slice(-5);
  const roomName = `R${run}`;
  const guest = `Maya Young ${run}`;

  // Rooms and rates: a type at BZ$200 a night, and a room of it.
  await page.goto(`/${SLUG}/hotel?tab=setup`);
  await page.getByRole('button', { name: '+ A room type' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Garden ${run}`);
  await page.getByLabel('Rate per night').fill('200');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Garden ${run}`).first()).toBeVisible();
  const addRoom = page.locator('form', { has: page.getByLabel('Room number or name') });
  await addRoom.getByLabel('Room number or name').fill(roomName);
  await choose(page, /^Room type/, new RegExp(`Garden ${run}`), addRoom);
  await page.getByRole('button', { name: 'Add the room' }).click();
  await expect(page.locator('.room-tile', { hasText: roomName })).toBeVisible();

  // A booking for two nights from the hotel's day, in that room.
  const today = (await get(page, '/v1/hotel/front-desk')).today as string;
  const out = new Date(new Date(`${today}T12:00:00Z`).getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole('button', { name: 'New booking' }).click();
  const fresh = page.getByRole('dialog', { name: 'New booking' });
  await fresh.getByLabel('Arrival').fill(today);
  await fresh.getByLabel('Departure').fill(out);
  await choose(page, /^Room type/, new RegExp(`Garden ${run}`), fresh);
  await choose(page, /^Room$/, roomName, fresh);
  await expect(fresh.getByText(/2 nights: BZ\$400\.00 · US\$200\.00/)).toBeVisible();
  await fresh.getByLabel('Guest').fill(guest);
  await fresh.getByRole('textbox', { name: 'Phone' }).fill('610-2222');
  await fresh.getByRole('button', { name: 'Book', exact: true }).click();
  // The booking opens: a deposit of BZ$100, then check-in.
  const booking = page.getByRole('dialog', { name: new RegExp(guest) });
  await expect(booking.getByText('Booked', { exact: true })).toBeVisible();
  await booking.getByText('Add to the bill, a deposit, or a second folio').click();
  await booking.getByLabel('Deposit (BZ$)').fill('100');
  await booking.getByRole('button', { name: 'Take the deposit' }).click();
  await expect(booking.getByText(/Deposit held: BZ\$100\.00/)).toBeVisible();
  await booking.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(booking.getByText('In house', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // On the calendar the stay is taken by its right edge: two nights longer, then back to two nights.
  await page.goto(`/${SLUG}/hotel?tab=calendar`);
  const plus = (n: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const bar = page.locator('.timeline-bar', { hasText: guest });
  await expect(bar).toBeVisible();
  let box = (await bar.boundingBox())!;
  await bar.dragTo(page.getByRole('button', { name: `Room ${roomName}, ${plus(3)}` }), { sourcePosition: { x: box.width - 5, y: box.height / 2 } });
  await expect(page.getByText(`${guest} now leaves on ${plus(4)}`)).toBeVisible();
  expect((await get(page, '/v1/hotel/front-desk')).inHouse.find((b: { guest: { name: string } }) => b.guest.name === guest).departure).toBe(plus(4));
  await expect.poll(async () => Math.round((await bar.boundingBox())!.width / box.width)).toBe(2);
  box = (await bar.boundingBox())!;
  await bar.dragTo(bar, { sourcePosition: { x: box.width - 5, y: box.height / 2 }, targetPosition: { x: box.width * (1.5 / 4), y: box.height / 2 } });
  await expect(page.getByText(`${guest} now leaves on ${out}`)).toBeVisible();
  expect((await get(page, '/v1/hotel/front-desk')).inHouse.find((b: { guest: { name: string } }) => b.guest.name === guest).departure).toBe(out);
  await page.goto(`/${SLUG}/hotel`);
  await expect(page.locator('section.card', { hasText: 'In house' }).getByText(guest)).toBeVisible();

  // At the bar: two coconut waters as a quick sale, charged to the room. The till shows whose room it is.
  await page.goto(`/${SLUG}/floor`);
  await page.getByRole('button', { name: 'Quick sale' }).click();
  const menu = page.getByRole('region', { name: 'Menu' });
  await page.getByLabel('Search the menu').fill('Coconut');
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await page.getByRole('region', { name: 'The order' }).getByRole('button', { name: 'Pay', exact: true }).click();
  const pay = page.getByRole('dialog', { name: /^Pay / });
  await pay.getByLabel('Charge to a room').fill('999');
  await pay.getByRole('button', { name: 'Find the guest' }).click();
  await expect(pay.getByText('Nobody is checked in to room 999')).toBeVisible();
  await pay.getByLabel('Charge to a room').fill(roomName);
  await pay.getByRole('button', { name: 'Find the guest' }).click();
  await expect(pay.getByText(`Charge to room ${roomName}: ${guest}`)).toBeVisible();
  await pay.getByRole('button', { name: 'Pay BZ$7.88' }).click();
  const cart = page.locator('form.cart');
  await expect(cart.locator('.cart-table')).toContainText(`Room ${roomName}, ${guest}`);
  await expect(cart.locator('.grand')).toContainText('BZ$7.88');
  await cart.getByRole('button', { name: /^Charge to the room/ }).click();
  await expect(page.getByRole('button', { name: 'Quick sale' })).toBeVisible();
  // It is an invoice on her account, not a receipt, and it is on her folio.
  const docs = (await get(page, '/v1/documents?limit=1')).data;
  expect([docs[0].type, docs[0].totals.payable, docs[0].customer.name]).toEqual(['01', '7.88', guest]);

  // The night audit: tonight's room is charged, and the hotel moves on a day.
  await page.goto(`/${SLUG}/hotel?tab=audit`);
  await page.getByRole('button', { name: 'Run the night audit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run the night audit' }).click();
  await expect(page.getByRole('heading', { name: `Manager’s report for ${today}` })).toBeVisible();
  await expect(page.getByText('Charged to rooms from the restaurant and bar: BZ$7.88.', { exact: false })).toBeVisible();
  // Housekeeping: her room is dirty in the morning; cleaned from the list.
  await page.goto(`/${SLUG}/hotel?tab=housekeeping`);
  const tile = page.locator('.room-tile', { hasText: `Room ${roomName}` });
  await expect(tile).toContainText('Dirty');
  await expect(tile).toContainText('Stay-over clean');
  await tile.getByRole('button', { name: 'Cleaned' }).click();
  await expect(tile).toContainText('Clean');

  // She leaves a day early: one night at 200.00 + 9% hotel tax = 218.00, the bar's 7.88, less the 100.00 deposit: 125.88, paid in two parts.
  await page.goto(`/${SLUG}/hotel`);
  await page.locator('section.card', { hasText: 'In house' }).getByRole('button', { name: guest }).click();
  await expect(booking.getByText('Owed: BZ$125.88').first()).toBeVisible();
  await booking.getByLabel('Amount (BZ$)').fill('100');
  await booking.getByRole('button', { name: '+ Another way of paying' }).click();
  await booking.getByLabel('Amount (BZ$)').nth(1).fill('20');
  await booking.getByRole('button', { name: 'Check out', exact: true }).click();
  await expect(booking.getByText(/BZ\$5\.88 is still owed/)).toBeVisible();
  // The invoices were issued and the two payments stand; the last BZ$5.88 settles it.
  await booking.getByLabel('Amount (BZ$)').first().fill('5.88');
  await booking.getByLabel('Amount (BZ$)').nth(1).fill('');
  await booking.getByRole('button', { name: 'Check out', exact: true }).click();
  await expect(booking.getByText('Checked out', { exact: true })).toBeVisible();
  await expect(booking.getByText('Owed: BZ$0.00').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Nothing of hers is owed anywhere, and the room is on the cleaning list again.
  const owed = (await get(page, '/v1/receivables/invoices')).data as Array<{ customer: { name: string } }>;
  expect(owed.filter((o) => o.customer.name === guest)).toEqual([]);
  const rooms = (await get(page, '/v1/hotel/rooms')).data as Array<{ id: string; name: string; status: string }>;
  expect(rooms.find((r) => r.name === roomName)!.status).toBe('dirty');

  // Tidy up: the room goes, and the business is a shop again.
  await send(page, 'delete', `/v1/hotel/rooms/${rooms.find((r) => r.name === roomName)!.id}`);
  await send(page, 'put', '/v1/venue/settings', { restaurant: false, bar: false, hotel: false });
});

test('the host stand: a table booking with an allergy, on the timeline, seated from the floor; the waitlist; the day closed', async ({ page }) => {
  await logIn(page);
  await send(page, 'put', '/v1/venue/settings', { restaurant: true, bar: true, hotel: false, serviceCharge: 'off' });
  // A dining room with two tables, from nothing.
  const venue = await get(page, '/v1/venue');
  for (const c of (await get(page, '/v1/venue/changes')).checks as Array<{ id: string; status: string; items: Array<{ id: string; status: string }> }>) {
    const live = c.items.filter((i) => i.status !== 'void').map((i) => i.id);
    const op = (type: string, payload = {}) => ({ id: crypto.randomUUID(), checkId: c.id, type, at: new Date().toISOString(), payload });
    if (live.length) await send(page, 'post', '/v1/venue/ops', { ops: [op('void', { itemIds: live, reason: 'Browser test tidy-up' })] });
    const now = (await get(page, `/v1/venue/checks/${c.id}`)).status;
    if (now === 'open' || now === 'paid') await send(page, 'post', '/v1/venue/ops', { ops: [op(now === 'paid' ? 'clean' : 'close')] });
  }
  for (const p of venue.floor) await send(page, 'delete', `/v1/venue/floor/${p.id}`);
  await send(page, 'post', '/v1/venue/floor', { area: 'Dining room', items: [{ id: 'h1', type: 'table', name: 'Table 1', seats: 4, x: 80, y: 120, w: 200, h: 280 }, { id: 'h2', type: 'table', name: 'Table 2', seats: 6, x: 360, y: 120, w: 260, h: 280 }] });
  const name = `Carla ${Date.now().toString().slice(-5)}`;
  for (const r of (await get(page, '/v1/venue/reservations')).reservations as Array<{ id: string; status: string }>) {
    if (r.status === 'booked' || r.status === 'confirmed') await send(page, 'post', `/v1/venue/reservations/${r.id}/cancel`, {});
  }

  // A booking for four at table 2, an hour from now, with an allergy.
  await page.goto(`/${SLUG}/host`);
  await page.getByRole('button', { name: 'New booking' }).click();
  const form = page.getByRole('dialog', { name: 'New booking' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByRole('textbox', { name: 'Phone' }).fill('610-7777');
  await form.getByLabel('Guests').fill('4');
  const soon = new Date(Date.now() - 6 * 3600_000 + 3600_000);
  // Late in the Belize evening the booking would fall on tomorrow: keep it on today's page.
  const time = soon.toISOString().slice(0, 10) === new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10) ? soon.toISOString().slice(11, 16) : '23:59';
  await form.getByLabel('Time').fill(time);
  await form.getByLabel('Allergy').fill('Peanuts');
  await form.getByRole('group', { name: 'Tables' }).getByRole('button', { name: /Table 2/ }).click();
  await form.getByRole('button', { name: 'Book the table' }).click();
  await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
  // It is on the timeline against table 2, and in the day's list with its allergy.
  await expect(page.getByRole('region', { name: 'Tables against time' }).getByRole('button', { name: new RegExp(name) })).toBeVisible();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toContainText('Allergy: Peanuts');
  await expect(row).toContainText('Table 2');
  // A message for WhatsApp is written for them.
  await row.getByRole('button', { name: 'Message' }).click();
  const message = page.getByRole('dialog', { name: 'A message for the guest' });
  await expect(message.locator('.whatsapp-message')).toContainText(`in the name of ${name}`);
  await expect(message.getByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/5016107777/);
  await page.keyboard.press('Escape');
  // A walk-in party goes on the waitlist.
  const wait = page.locator('section.card', { has: page.getByRole('heading', { name: 'Waitlist' }) });
  await wait.getByLabel('Name', { exact: true }).fill(`Pat ${name.slice(-5)}`);
  await wait.getByRole('button', { name: 'Add to the list' }).click();
  await expect(wait.locator('li', { hasText: `Pat ${name.slice(-5)}` })).toContainText('waiting 0 min');

  // On the floor: table 2 shows as reserved; tapping it offers the booked party; seating them opens their check with the allergy.
  await page.goto(`/${SLUG}/floor`);
  const plan = page.getByRole('group', { name: 'Floor plan of Dining room' });
  await plan.getByRole('button', { name: /^Table 2/ }).click();
  const seat = page.getByRole('dialog', { name: 'Seat a party at Table 2' });
  await seat.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Table 2/ })).toBeVisible();
  await expect(page.locator('.venue-allergy')).toContainText('Peanuts');
  await expect(page.getByText('4 guests', { exact: false })).toBeVisible();
  // Nothing ordered: the table is closed again.
  await page.getByRole('button', { name: 'Close the table' }).click();
  await expect(plan.getByRole('button', { name: /^Table 2: Free/ })).toBeVisible();

  // The day's close lists what is open and will not close over an open shift without saying so.
  await page.goto(`/${SLUG}/venue-reports?view=close`);
  await expect(page.getByText('No tables or tabs are open')).toBeVisible();
  await expect(page.locator('section').getByRole('button', { name: 'Close the day' })).toBeVisible();

  await send(page, 'post', `/v1/venue/waitlist/${(await get(page, '/v1/venue/reservations')).waitlist[0].id}/left`, {});
  await send(page, 'put', '/v1/venue/settings', { restaurant: false, bar: false, hotel: false });
});
