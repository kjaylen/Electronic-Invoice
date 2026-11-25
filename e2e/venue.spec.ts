/**
 * Table service in a real browser: the floor plan, seating a party, ordering
 * with a required choice, sending to the kitchen (a ticket prints once),
 * the kitchen screen, paying at the counter, and the table free again; then
 * a bar tab moved to a table and split evenly.
 *
 * Runs after app.spec.ts, on the business it sets up. It turns the module on
 * for the test and off again, so the specs after it see a shop.
 */

import { expect, type Page, test } from '@playwright/test';

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

const put = async (page: Page, method: 'post' | 'put' | 'delete', url: string, data?: unknown) => {
  const r = await page.request[method](url, { headers: API, ...(data !== undefined && { data }) });
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
};

/** A small restaurant on the test business: two tables and a bar stool, a kitchen, a choice on the Johnny cakes. */
async function setUp(page: Page) {
  await put(page, 'put', '/v1/venue/settings', { restaurant: true, bar: true, hotel: false, serviceCharge: 'off' });
  // From nothing, whatever an earlier run left.
  for (const c of (await (await page.request.get('/v1/venue/changes', { headers: API })).json()).checks as Array<{ id: string; status: string; items: Array<{ id: string; status: string; shares: number; paid: Array<{ shares: number }> }> }>) {
    const owing = c.items.filter((i) => i.status !== 'void' && i.paid.reduce((a, p) => a + p.shares, 0) < i.shares).map((i) => i.id);
    const op = (type: string, payload: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), checkId: c.id, type, at: new Date().toISOString(), payload });
    if (owing.length) await put(page, 'post', '/v1/venue/ops', { ops: [op('void', { itemIds: owing, reason: 'Browser test tidy-up' })] });
    const now = ((await (await page.request.get(`/v1/venue/checks/${c.id}`, { headers: API })).json()) as { status: string }).status;
    if (now === 'open' || now === 'paid') await put(page, 'post', '/v1/venue/ops', { ops: [op(now === 'paid' ? 'clean' : 'close')] });
  }
  const venue = await (await page.request.get('/v1/venue', { headers: API })).json();
  for (const p of venue.floor) await put(page, 'delete', `/v1/venue/floor/${p.id}`);
  for (const s of venue.stations) await put(page, 'delete', `/v1/venue/stations/${s.id}`);
  for (const g of venue.modifierGroups) await put(page, 'delete', `/v1/venue/modifier-groups/${g.id}`);
  await put(page, 'post', '/v1/venue/floor', { area: 'Dining room', items: [
    { id: 't1', type: 'table', name: 'Table 1', shape: 'round', seats: 4, x: 80, y: 120, w: 180, h: 280 },
    { id: 't2', type: 'table', name: 'Table 2', shape: 'rect', seats: 6, x: 340, y: 120, w: 260, h: 280 },
    { id: 'b1', type: 'stool', name: 'Bar 1', shape: 'round', seats: 1, x: 700, y: 120, w: 120, h: 200 },
    { id: 'w1', type: 'wall', name: '', x: 0, y: 0, w: 1000, h: 20 },
  ] });
  const find = async (q: string) => (await (await page.request.get(`/v1/items?q=${encodeURIComponent(q)}&limit=1`, { headers: API })).json()).data[0];
  const cakes = await find('Johnny cakes');
  const water = await find('Coconut water');
  for (const [item, category] of [[cakes, 'Food'], [water, 'Drinks']] as const) {
    await put(page, 'put', `/v1/items/${item.id}`, { name: item.name, unitCode: item.unitCode, unitPrice: item.unitPrice, gstCategory: item.gstCategory, ...(item.sellerCode && { sellerCode: item.sellerCode }), ...(item.barcode && { barcode: item.barcode }), favorite: true, category });
  }
  // The kitchen has no till of its own: its tickets print where the order is sent from, and show on the kitchen screen.
  await put(page, 'post', '/v1/venue/stations', { name: 'Kitchen', categories: ['Food'] });
  const group = (await put(page, 'post', '/v1/venue/modifier-groups', { name: 'Butter', minChoices: 1, maxChoices: 1, options: [{ name: 'With butter' }, { name: 'No butter' }] })).data.find((g: { name: string }) => g.name === 'Butter');
  await put(page, 'put', `/v1/venue/items/${cakes.id}`, { modifierGroupIds: [group.id], course: 2, allergens: ['gluten', 'milk'] });
  await put(page, 'put', `/v1/venue/items/${water.id}`, { modifierGroupIds: [], course: 0 });
  await put(page, 'post', `/v1/venue/items/${cakes.id}/availability`, { soldOut: false });
  return { cakes, water };
}

test('table service: seat a party, order with a choice, send to the kitchen, the kitchen screen, pay at the counter, the table is free again', async ({ page }) => {
  await logIn(page);
  await setUp(page);

  // The floor is in the menu for a restaurant, and is the home of table service.
  await page.goto(`/${SLUG}/`);
  await page.getByRole('navigation').getByRole('link', { name: 'Floor' }).click();
  const plan = page.getByRole('group', { name: 'Floor plan of Dining room' });
  await expect(plan.getByRole('button', { name: /^Table 1: Free/ })).toBeVisible();
  await expect(plan.getByRole('button')).toHaveCount(3);

  // Seat three at table 1.
  await plan.getByRole('button', { name: /^Table 1/ }).click();
  const seat = page.getByRole('dialog', { name: 'Seat a party at Table 1' });
  await seat.getByRole('button', { name: '3', exact: true }).click();
  await seat.getByRole('button', { name: 'Open the table for 3' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Table 1/ })).toBeVisible();

  // Two coconut waters for seat 1 (one tap each), a Johnny cake for seat 2: it needs its choice first.
  const menu = page.getByRole('region', { name: 'Menu' });
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await page.getByRole('group', { name: 'Seat' }).getByRole('button', { name: '2', exact: true }).click();
  await menu.getByRole('button', { name: /^Johnny cakes/ }).click();
  const choose = page.getByRole('dialog', { name: 'Johnny cakes' });
  await expect(choose.getByRole('button', { name: 'Add to the order' })).toBeDisabled();
  await expect(choose.getByText('Butter: choose one')).toBeVisible();
  await choose.getByRole('button', { name: 'No butter' }).click();
  await choose.getByLabel('Note for the kitchen or bar').fill('well done');
  await choose.getByRole('button', { name: 'Add to the order' }).click();
  const order = page.getByRole('region', { name: 'The order' });
  // The second tap made the first line two.
  await expect(order.locator('.venue-course li')).toHaveCount(2);
  await expect(order.locator('.venue-course li').first()).toContainText('2');
  await expect(order.getByText('not sent')).toHaveCount(2);
  // 2 x 3.50 + 1.50 = 8.50; GST 1.06.
  await expect(order.locator('.grand')).toContainText('BZ$9.56');
  await expect(order.locator('.grand-usd')).toContainText('US$4.78');

  // Send: the kitchen's ticket prints here (this browser sent it), with the table, the choice and the note; the drinks have no station.
  await order.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText('Sent: 3 items')).toBeVisible();
  await expect(order.getByText('not sent')).toHaveCount(0);
  await expect.poll(async () => page.locator('iframe.print-frame').evaluate((f) => (f as HTMLIFrameElement).srcdoc).catch(() => '')).toContain('KITCHEN');
  const ticket = await page.locator('iframe.print-frame').evaluate((f) => (f as HTMLIFrameElement).srcdoc);
  for (const text of ['Table 1', '1 x Johnny cakes', 'No butter', 'well done', 'MAINS']) expect(ticket).toContain(text);
  expect(ticket).not.toContain('Coconut water');
  // Sending again sends nothing new.
  await expect(order.getByRole('button', { name: /^Send/ })).toBeDisabled();

  // The floor shows the stage; the kitchen screen has the card, and bumping it tells the floor.
  await page.getByRole('button', { name: /Floor$/ }).click();
  await expect(plan.getByRole('button', { name: /^Table 1: Food sent, 3/ })).toBeVisible();
  await page.goto(`/${SLUG}/kitchen`);
  const card = page.locator('.kds-card', { hasText: 'Table 1' });
  await expect(card).toContainText('1 × Johnny cakes');
  await expect(card).toContainText('No butter');
  await expect(page.getByLabel('All day')).toContainText('1 × Johnny cakes');
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(card).toHaveCount(0);
  await page.goto(`/${SLUG}/floor`);
  await expect(plan.getByRole('button', { name: /^Table 1/ }).locator('.venue-bell')).toBeVisible();

  // The bill: paid whole, at the counter, in cash.
  await plan.getByRole('button', { name: /^Table 1/ }).click();
  await expect(page.getByRole('region', { name: 'The order' }).locator('.state-ready')).toHaveCount(1);
  await page.getByRole('region', { name: 'The order' }).getByRole('button', { name: 'Pay', exact: true }).click();
  await page.getByRole('dialog', { name: 'Pay Table 1' }).getByRole('button', { name: 'Pay BZ$9.56' }).click();
  const cart = page.locator('form.cart');
  await expect(cart.locator('.cart-table')).toContainText('Table 1');
  await expect(cart.locator('.cart-lines li')).toHaveCount(2);
  await expect(cart.locator('.grand')).toContainText('BZ$9.56');
  await cart.getByRole('button', { name: /^Issue receipt/ }).click();
  // Back on the floor: the table is paid and waits to be cleaned; then it is free.
  await expect(plan.getByRole('button', { name: /^Table 1: Paid: clean it/ })).toBeVisible();
  await plan.getByRole('button', { name: /^Table 1/ }).click();
  await page.getByRole('button', { name: 'Table is clean' }).click();
  await expect(plan.getByRole('button', { name: /^Table 1: Free/ })).toBeVisible();

  // The receipt is a real tax document for BZ$9.56, and the report has the three covers.
  const docs = (await (await page.request.get('/v1/documents?limit=1', { headers: API })).json()).data;
  expect([docs[0].type, docs[0].totals.payable, docs[0].status]).toEqual(['02', '9.56', 'authorized']);
  const day = (await (await page.request.get('/v1/venue', { headers: API })).json()).businessDate;
  const report = await (await page.request.get(`/v1/venue/reports?from=${day}&to=${day}`, { headers: API })).json();
  expect(report.covers.covers).toBeGreaterThanOrEqual(3);
  expect(report.byItem.find((i: { name: string }) => i.name === 'Johnny cakes').quantity).toBeGreaterThanOrEqual(1);
});

test('no connection: a table is opened, ordered and sent; the ticket prints here once; it all goes up when the connection is back', async ({ page }) => {
  await logIn(page);
  await setUp(page);
  await page.goto(`/${SLUG}/floor`);
  const plan = page.getByRole('group', { name: 'Floor plan of Dining room' });
  await expect(plan.getByRole('button', { name: /^Table 2: Free/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'In step' })).toBeVisible();

  // The connection goes: every call to the server fails from here.
  await page.route('**/v1/**', (r) => r.abort('internetdisconnected'));
  await plan.getByRole('button', { name: /^Table 2/ }).click();
  const seat = page.getByRole('dialog', { name: 'Seat a party at Table 2' });
  await seat.getByRole('button', { name: '2', exact: true }).click();
  await seat.getByRole('button', { name: 'Open the table for 2' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Table 2/ })).toBeVisible();
  const menu = page.getByRole('region', { name: 'Menu' });
  await menu.getByRole('button', { name: /^Johnny cakes/ }).click();
  const choose = page.getByRole('dialog', { name: 'Johnny cakes' });
  await choose.getByRole('button', { name: 'With butter' }).click();
  await choose.getByRole('button', { name: 'Add to the order' }).click();
  const order = page.getByRole('region', { name: 'The order' });
  await order.getByRole('button', { name: /^Send/ }).click();
  await expect(order.getByText('not sent')).toHaveCount(0);
  // The kitchen's ticket is made and printed by this device.
  await expect.poll(async () => page.locator('iframe.print-frame').evaluate((f) => (f as HTMLIFrameElement).srcdoc).catch(() => ''), { timeout: 15_000 }).toContain('KITCHEN');
  const ticket = await page.locator('iframe.print-frame').evaluate((f) => (f as HTMLIFrameElement).srcdoc);
  for (const text of ['Table 2', '1 x Johnny cakes', 'With butter']) expect(ticket).toContain(text);
  await page.getByRole('button', { name: /Floor$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /No connection: \d+ to send/ })).toBeVisible();
  await expect(plan.getByRole('button', { name: /^Table 2: Food sent, 2/ })).toBeVisible();

  // The connection is back: the order goes up by itself, and the server does not print the ticket a second time.
  await page.unroute('**/v1/**');
  await expect(page.getByRole('status').filter({ hasText: 'In step' })).toBeVisible({ timeout: 20_000 });
  const changes = await (await page.request.get('/v1/venue/changes', { headers: API })).json() as { checks: Array<{ id: string; tableName: string; items: Array<{ name: string; status: string }> }>; tickets: Array<{ checkId: string; kind: string; status: string; attempts: number }> };
  const check = changes.checks.find((c) => c.tableName === 'Table 2')!;
  expect(check.items.map((i) => [i.name, i.status])).toEqual([['Johnny cakes', 'sent']]);
  const tickets = changes.tickets.filter((k) => k.checkId === check.id);
  expect(tickets.map((k) => [k.kind, k.status, k.attempts])).toEqual([['order', 'printed', 0]]);
  await expect(plan.getByRole('button', { name: /^Table 2: Food sent, 2/ })).toBeVisible();
});

test('the till app with no connection: a table opened, ordered, sent and paid in cash on the till; the receipt and the payment reach the server once', async ({ page, browser }) => {
  await logIn(page);
  await setUp(page);
  // A till of its own (another device), paired while there is a connection, as a till always is the first time.
  const added = await put(page, 'post', '/v1/pos/devices', { name: `Floor till ${Math.random().toString(36).slice(2, 6)}` });
  const context = await browser.newContext();
  const till = await context.newPage();
  await till.goto(`/pos?pair=${added.pairing.code}`);
  await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible({ timeout: 20_000 });
  if (await till.getByRole('heading', { name: 'Who is selling?' }).isVisible()) await till.getByRole('button', { name: 'Rosa Owner' }).click();
  await expect(till.getByText('Enter your PIN')).toBeVisible();
  for (const d of '4826') await till.keyboard.press(d);
  await till.keyboard.press('Enter');
  // A restaurant's till opens on the floor.
  const plan = till.getByRole('group', { name: 'Floor plan of Dining room' });
  await expect(plan.getByRole('button', { name: /^Table 1: Free/ })).toBeVisible({ timeout: 20_000 });
  const indicator = till.locator('.till-bar .sync-indicator').first();
  await expect(indicator).toContainText('Online');

  await context.setOffline(true);
  await expect(indicator).toContainText('Offline');
  await plan.getByRole('button', { name: /^Table 1/ }).click();
  const seat = till.getByRole('dialog', { name: 'Seat a party at Table 1' });
  await seat.getByRole('button', { name: '2', exact: true }).click();
  await seat.getByRole('button', { name: 'Open the table for 2' }).click();
  const menu = till.getByRole('region', { name: 'Menu' });
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  const order = till.getByRole('region', { name: 'The order' });
  await order.getByRole('button', { name: /^Send/ }).click();
  await expect(order.getByText('not sent')).toHaveCount(0);
  // 2 x 3.50 = 7.00, GST 0.88: paid whole, in cash, on a receipt the till makes itself.
  await order.getByRole('button', { name: 'Pay', exact: true }).click();
  await till.getByRole('dialog', { name: 'Pay Table 1' }).getByRole('button', { name: 'Pay BZ$7.88' }).click();
  const cart = till.locator('form.cart');
  await expect(cart.locator('.grand')).toContainText('BZ$7.88');
  await cart.getByLabel('Cash received').fill('10');
  await cart.getByRole('button', { name: /^Issue receipt/ }).click();
  await expect(plan.getByRole('button', { name: /^Table 1: Needs cleaning/ })).toBeVisible();
  await expect(indicator).toContainText(/Offline · \d+ to send/);
  // Nothing of it is on the server yet.
  const before = await (await page.request.get('/v1/venue/changes', { headers: API })).json() as { checks: Array<{ tableName: string }> };
  expect(before.checks.some((c) => c.tableName === 'Table 1')).toBeFalsy();

  // The connection is back: the receipt goes up and is authorized, and the table is paid on the server, by that receipt.
  await context.setOffline(false);
  await expect(indicator).toContainText('Online · all sent', { timeout: 30_000 });
  await expect.poll(async () => {
    const now = await (await page.request.get('/v1/venue/changes', { headers: API })).json() as { checks: Array<{ tableName: string; status: string }> };
    return now.checks.find((c) => c.tableName === 'Table 1')?.status;
  }, { timeout: 20_000 }).toBe('paid');
  const after = await (await page.request.get('/v1/venue/changes', { headers: API })).json() as { checks: Array<{ tableName: string; items: Array<{ name: string; status: string; paid: Array<{ documentId: string }> }> }> };
  const check = after.checks.find((c) => c.tableName === 'Table 1')!;
  expect(check.items.length).toBe(1);
  expect(check.items[0]!.paid.length).toBe(1);
  const doc = await (await page.request.get(`/v1/documents/${check.items[0]!.paid[0]!.documentId}`, { headers: API })).json();
  expect([doc.type, doc.totals.payable]).toEqual(['02', '7.88']);
  await expect.poll(async () => (await (await page.request.get(`/v1/documents/${doc.id}`, { headers: API })).json()).status, { timeout: 20_000 }).toBe('authorized');
  await context.close();
});

test('the till floor: the plan and the list, the legend, a table held for its actions, dragged onto another to move it (confirmed), the filters', async ({ page, browser }) => {
  await logIn(page);
  await setUp(page);
  const added = await put(page, 'post', '/v1/pos/devices', { name: `Floor till ${Math.random().toString(36).slice(2, 6)}` });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const till = await context.newPage();
  await till.goto(`/pos?pair=${added.pairing.code}`);
  await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible({ timeout: 20_000 });
  if (await till.getByRole('heading', { name: 'Who is selling?' }).isVisible()) await till.getByRole('button', { name: 'Rosa Owner' }).click();
  for (const d of '4826') await till.keyboard.press(d);
  await till.keyboard.press('Enter');
  const plan = till.getByRole('group', { name: 'Floor plan of Dining room' });
  await expect(plan.getByRole('button', { name: /^Table 1: Free/ })).toBeVisible({ timeout: 20_000 });

  // The legend is one tap away: every state in a word, with its icon.
  await till.getByRole('button', { name: 'Legend' }).click();
  const legend = till.getByRole('dialog', { name: 'Legend' });
  for (const word of ['Free', 'Reserved', 'Seated', 'Ordered', 'Food sent', 'Mains served', 'Bill requested', 'Needs cleaning', 'Food is ready']) await expect(legend).toContainText(word);
  await till.keyboard.press('Escape');
  await expect(legend).toHaveCount(0);

  // Seat two at table 1 and come back to the floor.
  await plan.getByRole('button', { name: /^Table 1/ }).click();
  await till.getByRole('dialog', { name: 'Seat a party at Table 1' }).getByRole('button', { name: /^Open the table/ }).click();
  await till.locator('.venue-order-head').getByRole('button', { name: /Floor/ }).click();
  await expect(plan.getByRole('button', { name: /^Table 1: Seated, 2/ })).toBeVisible();

  // Held (right-click with a mouse): its actions.
  await plan.getByRole('button', { name: /^Table 1/ }).click({ button: 'right' });
  const actions = till.getByRole('dialog', { name: 'Table 1' });
  for (const a of ['Open the table', 'Move to another table', 'Join with another table', 'Give to another server']) await expect(actions.getByRole('button', { name: a })).toBeVisible();
  await till.keyboard.press('Escape');

  // Held and dragged onto table 2: moved, after saying yes.
  const from = await plan.getByRole('button', { name: /^Table 1/ }).boundingBox();
  const to = await plan.getByRole('button', { name: /^Table 2/ }).boundingBox();
  await till.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await till.mouse.down();
  await till.waitForTimeout(650);
  await till.mouse.move(from!.x + from!.width / 2 + 40, from!.y + from!.height / 2, { steps: 4 });
  await till.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await till.mouse.up();
  const sure = till.getByRole('dialog', { name: 'Move the party?' });
  await expect(sure).toContainText('Table 1 moves to Table 2');
  await sure.getByRole('button', { name: 'Move' }).click();
  await expect(plan.getByRole('button', { name: /^Table 2: Seated, 2/ })).toBeVisible();
  await expect(plan.getByRole('button', { name: /^Table 1: Free/ })).toBeVisible();

  // My tables dims the others; the list shows only those, and remembers it is the list.
  await till.getByRole('button', { name: /^My tables/ }).click();
  await till.getByRole('button', { name: 'List' }).click();
  const list = till.getByRole('group', { name: 'Tables' });
  await expect(list.getByRole('button', { name: /^Table 2/ }).first()).toBeVisible();
  await expect(list.getByText('Table 1', { exact: true })).toHaveCount(0);
  await till.getByRole('button', { name: /^All tables/ }).click();
  await expect(list.getByRole('button', { name: 'Actions for Table 1' })).toBeVisible();
  await till.getByRole('button', { name: 'Plan' }).click();
  await context.close();
});

test('the layout editor: tables added, duplicated, undone and redone, numbered in reading order, lined up, and saved', async ({ page }) => {
  await logIn(page);
  await setUp(page);
  await page.goto(`/${SLUG}/settings?tab=venue`);
  const editor = page.getByLabel('Floor plan editor');
  await expect(editor.getByRole('button', { name: 'Table 1' })).toBeVisible();
  await page.getByRole('button', { name: '+ Round table' }).click();
  await expect(editor.getByRole('button', { name: 'Table 3' })).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(editor.getByRole('button', { name: 'Table 3 (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(editor.getByRole('button', { name: 'Table 3 (2)' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(editor.getByRole('button', { name: 'Table 3 (2)' })).toBeVisible();
  // Numbered top to bottom, left to right: the copy (lower down) is last.
  await page.getByRole('button', { name: 'Number the tables' }).click();
  await expect(editor.getByRole('button', { name: /^Table \d$/ })).toHaveCount(4);
  await expect(editor.getByRole('button', { name: 'Table 3 (2)' })).toHaveCount(0);
  // Two chosen, lined up on the left.
  await editor.getByRole('button', { name: 'Table 1' }).click();
  await editor.getByRole('button', { name: 'Table 2' }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Line up left' }).click();
  await page.getByRole('button', { name: 'Save the plan' }).click();
  await expect(page.getByText('Floor plan saved')).toBeVisible();
  const venue = await (await page.request.get('/v1/venue', { headers: API })).json() as { floor: Array<{ area: string; items: Array<{ name: string; x: number; type: string }> }> };
  const items = venue.floor.find((p) => p.area === 'Dining room')!.items;
  expect(items.filter((i) => i.type === 'table').map((i) => i.name).sort()).toEqual(['Table 1', 'Table 2', 'Table 3', 'Table 4']);
  expect(items.find((i) => i.name === 'Table 1')!.x).toBe(items.find((i) => i.name === 'Table 2')!.x);
});

test('speed: a table opened and four items with choices sent, on a slow connection, without one tap waiting for the server', async ({ page }) => {
  await logIn(page);
  await setUp(page);
  await page.goto(`/${SLUG}/floor`);
  const plan = page.getByRole('group', { name: 'Floor plan of Dining room' });
  await expect(plan.getByRole('button', { name: /^Table 2: Free/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'In step' })).toBeVisible();
  // Every call to the server takes two seconds from here.
  await page.route('**/v1/**', async (r) => { await new Promise((done) => setTimeout(done, 2000)); await r.continue().catch(() => {}); });

  const started = Date.now();
  await plan.getByRole('button', { name: /^Table 2/ }).click();
  const seat = page.getByRole('dialog', { name: 'Seat a party at Table 2' });
  await seat.getByRole('button', { name: '2', exact: true }).click();
  await seat.getByRole('button', { name: 'Open the table for 2' }).click();
  const menu = page.getByRole('region', { name: 'Menu' });
  const choose = page.getByRole('dialog', { name: 'Johnny cakes' });
  // Four items: two Johnny cakes, each with its required choice, and two coconut waters.
  for (const butter of ['With butter', 'No butter']) {
    await menu.getByRole('button', { name: /^Johnny cakes/ }).click();
    await choose.getByRole('button', { name: butter }).click();
    await choose.getByRole('button', { name: 'Add to the order' }).click();
  }
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  const order = page.getByRole('region', { name: 'The order' });
  await order.getByRole('button', { name: /^Send/ }).click();
  await expect(order.getByText('not sent')).toHaveCount(0);
  await expect(page.getByText('Sent: 4 items')).toBeVisible();
  const taken = Date.now() - started;
  // Twelve taps. Had each waited for the server it would be 24 seconds; a person has 20 for the lot.
  expect(taken, `took ${taken} ms`).toBeLessThan(6000);

  // And the server did get it, once, a moment later.
  await page.unroute('**/v1/**');
  await expect.poll(async () => {
    const now = await (await page.request.get('/v1/venue/changes', { headers: API })).json() as { checks: Array<{ tableName: string; items: Array<{ quantity: number; status: string }> }> };
    const c = now.checks.find((x) => x.tableName === 'Table 2');
    return c ? c.items.filter((i) => i.status === 'sent').reduce((a, i) => a + i.quantity, 0) : 0;
  }, { timeout: 20_000 }).toBe(4);
});

test('the menu: in the sidebar for a restaurant, sections made, ordered, renamed everywhere, items moved, sold out', async ({ page }) => {
  await logIn(page);
  await setUp(page);
  await page.reload();
  // Restaurant or bar on: Menu sits after Products.
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Menu' })).toBeVisible();
  const section = (name: string) => page.getByRole('region', { name, exact: true });
  await expect(section('Food')).toContainText('Johnny cakes');
  await expect(section('Drinks')).toContainText('Coconut water');

  // A section made before anything is in it, then the Johnny cakes moved into it by ticking them.
  const name = `Specials ${Date.now() % 10000}`;
  await page.getByLabel('New section').fill(name);
  await page.getByRole('button', { name: '+ Section' }).click();
  await expect(section(name)).toContainText('Nothing in it yet');
  await section('Food').getByLabel('Select Johnny cakes').check();
  await page.getByLabel('Move to section').click();
  await page.getByRole('option', { name }).click();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(section(name)).toContainText('Johnny cakes');
  await expect(section('Food')).toContainText('Nothing in it yet');

  // Put first, then renamed: the kitchen station that makes it follows.
  for (let i = 0; i < 20 && (await page.locator('.menu-section h2').first().innerText()) !== name; i++) {
    await page.getByRole('button', { name: `Move ${name} up` }).click();
    await page.waitForTimeout(250);
  }
  await expect(page.locator('.menu-section h2').first()).toHaveText(name);
  await put(page, 'put', `/v1/venue/stations/${(await (await page.request.get('/v1/venue', { headers: API })).json()).stations[0].id}`, { name: 'Kitchen', categories: [name], deviceId: null, screen: true, fallbackId: null, targetMin: 12, position: 0 });
  await section(name).getByRole('button', { name: 'Rename' }).click();
  await page.locator('.menu-section form input').fill(`${name} tonight`);
  await page.locator('.menu-section form button', { hasText: 'Rename' }).click();
  await expect(section(`${name} tonight`)).toContainText('Johnny cakes');
  const venue = await (await page.request.get('/v1/venue', { headers: API })).json();
  expect(venue.stations[0].categories).toEqual([`${name} tonight`]);
  expect(venue.menuSections[0].name).toBe(`${name} tonight`);

  // Sold out in one tap, from the menu.
  await section(`${name} tonight`).getByRole('button', { name: 'Mark Johnny cakes sold out' }).click();
  await expect(section(`${name} tonight`).getByRole('button', { name: 'Johnny cakes is sold out: put it back on' })).toBeVisible();
  await section(`${name} tonight`).getByRole('button', { name: 'Johnny cakes is sold out: put it back on' }).click();

  // Settings → Venue points to the menu.
  await page.goto(`/${SLUG}/settings?tab=venue`);
  await expect(page.getByRole('link', { name: 'Open the menu' })).toBeVisible();
});

test('the bar: a tab by name, a round repeated, moved to a table, split evenly in two, and a sold-out item', async ({ page }) => {
  await logIn(page);
  const { cakes } = await setUp(page);
  await page.goto(`/${SLUG}/floor`);
  // A tab for Maria: two coconut waters, sent; the same round again in one tap.
  await page.getByRole('button', { name: /^Tabs/ }).click();
  const tabs = page.getByRole('dialog', { name: 'Open tabs' });
  await tabs.getByLabel('New tab: a name, or a seat at the bar').fill('Maria');
  await tabs.getByRole('button', { name: 'Open the tab' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Maria/ })).toBeVisible();
  const menu = page.getByRole('region', { name: 'Menu' });
  const order = page.getByRole('region', { name: 'The order' });
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await menu.getByRole('button', { name: /^Coconut water/ }).click();
  await order.getByRole('button', { name: /^Send/ }).click();
  await order.getByRole('button', { name: 'Repeat round' }).click();
  await expect(order.locator('.venue-course li')).toHaveCount(2);
  await order.getByRole('button', { name: /^Send/ }).click();
  // The kitchen runs out of Johnny cakes: one tap, and they cannot be ordered here.
  await page.request.post(`/v1/venue/items/${cakes.id}/availability`, { headers: API, data: { soldOut: true } });
  await expect(menu.getByRole('button', { name: /^Johnny cakes/ })).toContainText('Sold out');
  await menu.getByRole('button', { name: /^Johnny cakes/ }).click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Johnny cakes' })).toHaveCount(0);
  // She takes table 2: the tab goes with her.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog', { name: 'This check' }).getByRole('button', { name: 'Move to a table' }).click();
  await page.getByRole('dialog', { name: 'Move to a table' }).getByRole('button', { name: /^Table 2/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Table 2/ })).toBeVisible();
  // 4 x 3.50 = 14.00 + GST 1.75 = 15.75, split evenly in two, each a receipt of its own; together exactly 15.75.
  await order.getByRole('button', { name: 'Pay', exact: true }).click();
  let pay = page.getByRole('dialog', { name: 'Pay Table 2' });
  await pay.getByRole('button', { name: 'Evenly' }).click();
  await pay.getByRole('button', { name: /^Split in 2/ }).click();
  const paid: number[] = [];
  for (const left of [2, 1]) {
    await order.getByRole('button', { name: 'Pay', exact: true }).click();
    pay = page.getByRole('dialog', { name: 'Pay Table 2' });
    await expect(pay.getByText(`This bill is being paid in equal parts: ${left} left.`)).toBeVisible();
    await pay.getByRole('button', { name: /^Pay the next part/ }).click();
    const cart = page.locator('form.cart');
    await expect(cart.locator('.cart-table')).toContainText(`1 of ${left} left`);
    // The part that is not the last is made to carry GST with nothing to round (7.83); the last takes what is left (7.92).
    await expect(cart.locator('.grand')).toContainText(left === 2 ? 'BZ$7.83' : 'BZ$7.92');
    const total = /BZ\$(\d+\.\d\d)/.exec(await cart.locator('.grand').innerText())![1]!;
    paid.push(Math.round(Number(total) * 100));
    await cart.getByRole('group', { name: 'Payment' }).getByRole('button', { name: left === 2 ? 'Card' : 'Cash' }).click();
    await cart.getByRole('button', { name: /^Issue receipt/ }).click();
    // With a part still to pay, the check comes back; when it is all paid, the floor.
    if (left === 2) await expect(page.getByRole('heading', { level: 1, name: /Table 2/ })).toBeVisible();
    else await expect(page.getByRole('group', { name: 'Floor plan of Dining room' })).toBeVisible();
  }
  expect(paid.reduce((a, b) => a + b, 0)).toBe(1575);
  expect(Math.abs(paid[0]! - paid[1]!)).toBeLessThanOrEqual(9);
  await expect(page.getByRole('group', { name: 'Floor plan of Dining room' }).getByRole('button', { name: /^Table 2: Paid/ })).toBeVisible();

  // Back to a shop for the tests that follow.
  await setUp(page);
  await put(page, 'put', '/v1/venue/settings', { restaurant: false, bar: false, hotel: false });
  await page.goto(`/${SLUG}/`);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Floor' })).toHaveCount(0);
});
