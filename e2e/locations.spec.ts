/**
 * A second shop: the owner adds a location, receives a delivery there with
 * freight on top (landed cost), sees stock per location, moves some between
 * the two with a transfer, counts one shop, and puts a register there.
 *
 * Runs after app.spec.ts, on the business it sets up. It leaves the business
 * with one shop again, so the specs after it see what they expect.
 */

import { expect, type Page, test } from '@playwright/test';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const OTHER = 'San Pedro shop';

async function logIn(page: Page) {
  await page.goto(`/${SLUG}/login`);
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

/** Pick from one of the app's select menus (a button that opens a list). */
async function choose(page: Page, label: string | RegExp, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

interface Place { id: string; name: string; main: boolean }
const places = async (page: Page) => (await (await page.request.get('/v1/locations', { headers: API })).json()).data as Place[];

/** One shop again: every other location emptied, without registers, and closed. */
async function oneShop(page: Page) {
  for (const p of (await places(page)).filter((x) => !x.main)) {
    for (const t of (await (await page.request.get('/v1/transfers?status=sent', { headers: API })).json()).data) await page.request.post(`/v1/transfers/${t.id}/cancel`, { headers: API });
    const stock = (await (await page.request.get('/v1/inventory?filter=tracked', { headers: API })).json()).data as Array<{ itemId: string; at?: Record<string, number> }>;
    const counts = stock.filter((s) => (s.at?.[p.id] ?? 0) !== 0).map((s) => ({ itemId: s.itemId, quantity: '0' }));
    if (counts.length) await page.request.post('/v1/inventory/count', { headers: API, data: { locationId: p.id, counts, note: 'Browser test tidy-up' } });
    for (const r of (await (await page.request.get('/v1/registers', { headers: API })).json()).data) {
      if (r.location?.id === p.id) await page.request.put(`/v1/registers/${r.id}`, { headers: API, data: { name: r.name, locationId: null } });
    }
    const closed = await page.request.delete(`/v1/locations/${p.id}`, { headers: API });
    expect(closed.status(), await closed.text()).toBe(200);
  }
}

test('a second shop: a delivery there with freight, stock by location, a transfer, a count, and a register that sells from it', async ({ page }) => {
  await logIn(page);
  await oneShop(page);
  const coconut = (await (await page.request.get('/v1/items?q=Coconut%20water&limit=1', { headers: API })).json()).data[0] as { id: string; stock: number | null };
  const first = (await places(page)).length === 0;

  // Settings: the second location. The first time, the shop there already is gets its name.
  await page.goto(`/${SLUG}/settings?tab=tills`);
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Locations' }) });
  if (first) await card.getByLabel('The shop you have now').fill('Belize City');
  await card.getByLabel(first ? 'The second location' : 'New location').fill(OTHER);
  await card.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByText('Location added. Stock, deliveries and counts can now be kept for each one.')).toBeVisible();
  await expect(card.locator('.locations-list li')).toHaveCount(2);
  const all = await places(page);
  const main = all.find((p) => p.main)!;
  const other = all.find((p) => !p.main)!;
  expect(other.name).toBe(OTHER);

  // Twenty coconut waters in the main shop, whatever earlier tests sold.
  if (coconut.stock === null) await page.request.put(`/v1/inventory/${coconut.id}/settings`, { headers: API, data: { track: true, quantity: '20' } });
  else await page.request.post('/v1/inventory/count', { headers: API, data: { locationId: main.id, counts: [{ itemId: coconut.id, quantity: '20' }] } });

  // A delivery to the other shop, with freight on top of the supplier's price.
  await page.goto(`/${SLUG}/inventory/receive`);
  await page.getByRole('combobox', { name: 'Item 1' }).fill('Coconut');
  await page.getByRole('option', { name: /Coconut water/ }).click();
  await page.getByLabel('Quantity', { exact: true }).fill('10');
  await page.getByLabel('Unit cost before GST (BZ$)').fill('2.00');
  await choose(page, /^Received at/, OTHER);
  await page.getByRole('button', { name: /Add freight, duty or other costs/ }).click();
  await page.getByLabel('Amount before GST (BZ$)').fill('5.00');
  await page.getByLabel(/Record the supplier’s bill as an expense/).uncheck();
  const aside = page.locator('.doc-aside');
  await expect(aside).toContainText('Freight, duty, other costs');
  await expect(aside.locator('.landed-total')).toContainText('BZ$25.00');
  await page.getByRole('button', { name: /Receive 1 items/ }).click();
  await expect(page.getByText('Stock received')).toBeVisible();
  const delivery = page.locator('tbody tr').first();
  await expect(delivery).toContainText(`At ${OTHER}`);
  await expect(delivery).toContainText('+ BZ$5.00 to bring it in');

  // Inventory: each location's stock, together and one at a time.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Tracked', exact: true }).click();
  const row = page.locator('tbody tr', { hasText: 'Coconut water' });
  await expect(row.locator('.stock-places')).toHaveText(`${main.name} 20 · ${OTHER} 10`);
  await choose(page, 'Location', OTHER);
  await expect(page.getByRole('columnheader', { name: `At ${OTHER}` })).toBeVisible();
  await expect(row).toContainText('30 in all');

  // A transfer: five from the main shop, on the way, then received.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Transfers', exact: true }).click();
  await page.getByRole('button', { name: 'Move stock' }).click();
  const move = page.getByRole('dialog', { name: 'Move stock' });
  await move.getByRole('combobox', { name: /^Item 1/ }).fill('Coconut');
  await page.getByRole('option', { name: /Coconut water/ }).click();
  await expect(move.getByText(`20 at ${main.name}`)).toBeVisible();
  await move.getByLabel(/^Quantity/).fill('5');
  await move.getByLabel(/^Note/).fill('Friday boat');
  await move.getByRole('button', { name: 'Send 1 items' }).click();
  await expect(page.getByText(new RegExp(`TR-\\d{4} is on the way to ${OTHER}`))).toBeVisible();
  const transfer = page.locator('tbody tr').first();
  await expect(transfer).toContainText('On the way');
  await expect(transfer).toContainText('5 × Coconut water');
  let levels = (await (await page.request.get(`/v1/inventory/${coconut.id}`, { headers: API })).json()) as { stock: number; at: Record<string, number>; onTheWay: number };
  expect([levels.stock, levels.at[main.id], levels.at[other.id], levels.onTheWay]).toEqual([30, 15, 10, 5]);
  await transfer.getByRole('button', { name: 'Receive' }).click();
  await expect(page.getByText(new RegExp(`TR-\\d{4} received at ${OTHER}`))).toBeVisible();
  await expect(transfer).toContainText('Received');

  // Counting the other shop: fourteen on the shelf where fifteen were expected.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Tracked', exact: true }).click();
  await page.getByRole('button', { name: 'Stock count' }).click();
  const count = page.getByRole('dialog', { name: 'Stock count' });
  await choose(page, /^Counting at/, OTHER);
  const line = count.locator('tbody tr', { hasText: 'Coconut water' });
  await expect(line.locator('td').nth(1)).toHaveText('15');
  await line.getByLabel('Counted for Coconut water').fill('14');
  await count.getByRole('button', { name: 'Save 1 counts' }).click();
  await expect(page.getByText('1 counts saved, 1 changed')).toBeVisible();
  levels = await (await page.request.get(`/v1/inventory/${coconut.id}`, { headers: API })).json();
  expect([levels.stock, levels.at[main.id], levels.at[other.id], levels.onTheWay]).toEqual([29, 15, 14, 0]);
  // Its cost has the freight in it: 20 held without a cost... the delivery's ten cost 2.50 each, not 2.00.
  const history = (await (await page.request.get(`/v1/inventory/${coconut.id}`, { headers: API })).json()).movements as Array<{ reason: string; unitCost: string | null; location: string }>;
  expect(history.find((m) => m.reason === 'receive')).toMatchObject({ unitCost: '2.50', location: OTHER });

  // A register moves to the other shop: it sells from that shop's stock from now on.
  await page.goto(`/${SLUG}/shifts`);
  const registers = (await (await page.request.get('/v1/registers', { headers: API })).json()).data as Array<{ id: string; name: string }>;
  const register = registers[registers.length - 1]!;
  await choose(page, `Location of ${register.name}`, OTHER);
  await expect(page.getByText(`${register.name} now sells from ${OTHER}`)).toBeVisible();
  const moved = (await (await page.request.get('/v1/registers', { headers: API })).json()).data.find((r: { id: string }) => r.id === register.id);
  expect(moved.location.name).toBe(OTHER);

  // Back to one shop for the tests that follow.
  await oneShop(page);
  expect((await places(page)).map((p) => p.name)).toEqual([main.name]);
});
