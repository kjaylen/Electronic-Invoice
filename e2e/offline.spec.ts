/**
 * Offline-first tills, end to end, in a real browser (its own IndexedDB and
 * Web Crypto) against the demo server: the till sells without the server,
 * survives restarts, and every sale reaches the server exactly once.
 *
 *   - selling offline, restarting offline, signing in offline, reconnecting
 *   - the connection dropping in the middle of an upload (the server has it, the till never heard back)
 *   - the app closed in the middle of a sale
 *   - sending again (duplicates)
 *   - two tills selling the last of an item while both are offline
 *   - a long time offline: many sales, signing in offline expires after 7 days
 *
 * Runs after app.spec.ts on the business it sets up (Rosa Owner's PIN is 4826).
 */

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const PIN = '4826';
const COCONUT = '7501000000017';
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const p = (path = '') => `/${SLUG}${path}`;

async function logIn(page: Page) {
  await page.goto(p('/login'));
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

async function api<T>(page: Page, method: string, url: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(url, { method, headers: API, ...(data !== undefined && { data }) });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBeTruthy();
  return res.status() === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

/** The business's receipts in one till's series, as the server has them. */
async function seriesDocs(page: Page, series: string) {
  const out: Array<{ id: string; etdui: string; serial: number; status: string }> = [];
  let cursor: string | null = null;
  do {
    const r: { data: Array<{ id: string; etdui: string; serial: number; status: string; series: string }>; nextCursor: string | null } =
      await api(page, 'GET', `/v1/documents?type=02&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...r.data.filter((d) => d.series === series));
    cursor = r.nextCursor;
  } while (cursor);
  return out;
}

/** Add a till in the web app and open it in its own browser (another device), paired and signed in. */
async function newTill(browser: Browser, owner: Page, name: string, setup?: (context: BrowserContext, till: Page) => Promise<void>) {
  // A new name each run (names are unique, and a rerun meets the last run's tills).
  const added = await api<{ pairing: { code: string } }>(owner, 'POST', '/v1/pos/devices', { name: `${name} ${Math.random().toString(36).slice(2, 6)}` });
  const context = await browser.newContext();
  const till = await context.newPage();
  if (setup) await setup(context, till);
  await till.goto(`/pos?pair=${added.pairing.code}`);
  await signIn(till);
  // No automatic printing in a test browser.
  await till.getByRole('button', { name: 'Devices', exact: true }).click();
  await till.getByLabel('Print each receipt automatically').uncheck();
  await till.getByRole('button', { name: 'Sell', exact: true }).click();
  return { context, till };
}

async function signIn(till: Page, expectError?: RegExp) {
  try {
    await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible({ timeout: 20_000 });
  } catch (e) {
    // What the till shows instead, for whoever reads the failure.
    throw new Error(`${(e as Error).message}
The till shows: ${(await till.locator('body').innerText().catch(() => '?')).slice(0, 1500)}`);
  }
  if (await till.getByRole('heading', { name: 'Who is selling?' }).isVisible()) await till.getByRole('button', { name: 'Rosa Owner' }).click();
  await expect(till.getByText('Enter your PIN')).toBeVisible();
  for (const d of PIN) await till.keyboard.press(d);
  await till.keyboard.press('Enter');
  if (expectError) {
    await expect(till.locator('.form-error')).toContainText(expectError);
    return;
  }
  try {
    await expect(till.getByRole('button', { name: /Issue receipt/ })).toBeVisible({ timeout: 20_000 });
  } catch (e) {
    throw new Error(`${(e as Error).message}
The till shows: ${(await till.locator('body').innerText().catch(() => '?')).slice(0, 1500)}`);
  }
}

async function lock(till: Page) {
  await till.getByRole('button', { name: 'Lock' }).click();
  await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible();
}

/**
 * Type a barcode in the counter's search box, take cash, issue. Returns the receipt's number
 * ("105-000000003"). (The search box, not a scanner's burst of keys: the long test fakes the clock.)
 */
async function sell(till: Page, barcode = COCONUT, cash = '5'): Promise<string> {
  const search = till.getByRole('combobox', { name: 'Add an item' });
  await search.fill(barcode);
  await search.press('Enter');
  await expect(till.locator('.cart-lines li')).toHaveCount(1);
  await till.getByLabel('Cash received').fill(cash);
  await till.getByRole('button', { name: /Issue receipt/ }).click();
  await expect(till.locator('.cart-lines li')).toHaveCount(0);
  const heading = (await till.locator('.last-sale h2').textContent())!;
  return heading.split('·')[0]!.trim();
}

const indicator = (till: Page) => till.locator('.till-bar .sync-indicator, .till-lock-head .sync-indicator').first();

test('offline: sell without a connection, restart, sign in offline, reconnect: each sale reaches the server once', async ({ page, browser }) => {
  await logIn(page);
  const { context, till } = await newTill(browser, page, 'Offline A');
  await expect(indicator(till)).toContainText('Online');

  await till.getByRole('button', { name: 'Open shift' }).click();
  await till.getByLabel('Cash in the drawer to start (float)').fill('50');
  await till.getByRole('dialog').getByRole('button', { name: 'Open shift' }).click();
  await expect(till.locator('.shift-bar.open')).toContainText('Cash expected BZ$50.00');

  // The connection goes: the till says so, and keeps selling.
  await context.setOffline(true);
  await expect(indicator(till)).toContainText('Offline');
  const numbers = [await sell(till), await sell(till), await sell(till)];
  await expect(till.locator('.last-sale')).toContainText('Saved on the till, not sent yet');
  await expect(indicator(till)).toContainText('Offline · 3 to send');
  // Gift cards and sales on account need the server: off, and the counter says why.
  await expect(till.locator('.offline-note')).toContainText('Gift cards, points and sales on account need a connection');
  await expect(till.locator('.shift-bar.open')).toContainText('Cash expected BZ$61.82');

  // The app restarts with no connection: it opens from its own copy and the PIN remembered on it.
  await till.reload();
  await signIn(till);
  numbers.push(await sell(till));
  await till.getByRole('button', { name: 'Sales', exact: true }).click();
  for (const n of numbers) await expect(till.locator('.sale-list')).toContainText(n);
  await expect(till.locator('.sale-list li').first()).toContainText('Saved on the till');
  const series = numbers[0]!.split('-')[0]!;
  expect(new Set(numbers).size).toBe(4);
  expect(numbers.every((n) => n.startsWith(`${series}-`))).toBeTruthy();
  expect((await seriesDocs(page, series)).length).toBe(0);

  // Back online: everything goes up, once.
  await context.setOffline(false);
  await expect(indicator(till)).toContainText('Online · all sent', { timeout: 30_000 });
  const docs = await seriesDocs(page, series);
  expect(docs.length).toBe(4);
  expect(new Set(docs.map((d) => d.etdui)).size).toBe(4);
  expect(docs.map((d) => d.serial).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  await expect.poll(async () => (await seriesDocs(page, series)).every((d) => d.status === 'authorized'), { timeout: 20_000 }).toBeTruthy();

  // The shift too: opened, its sales in it, on the server.
  const current = await api<{ data: Array<{ register: { name: string }; status: string; number: number }> }>(page, 'GET', '/v1/shifts');
  expect(current.data.some((s) => s.register.name.startsWith('Offline A') && s.status === 'open' && s.number > 0)).toBeTruthy();
  await context.close();
});

test('offline: the connection drops in the middle of an upload; sending again does not double anything', async ({ page, browser }) => {
  await logIn(page);
  const { context, till } = await newTill(browser, page, 'Offline B');
  // The first upload reaches the server, but its answer never comes back.
  let dropped = 0;
  await till.route('**/v1/pos/sync', async (route) => {
    if (dropped === 0) {
      dropped++;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  const first = await sell(till);
  const series = first.split('-')[0]!;
  await expect.poll(() => dropped).toBe(1);
  await sell(till);
  await expect(indicator(till)).toContainText('Online · all sent', { timeout: 30_000 });
  expect((await seriesDocs(page, series)).length).toBe(2);

  // A manager sends again and again: still two.
  await till.getByRole('button', { name: 'Sync', exact: true }).click();
  for (let i = 0; i < 3; i++) await till.getByRole('button', { name: 'Send now' }).click();
  await expect(till.locator('.sync-facts')).toContainText('0');
  expect((await seriesDocs(page, series)).length).toBe(2);
  await context.close();
});

test('offline: the app is closed in the middle of a sale; the sale is there once, or not at all', async ({ page, browser }) => {
  await logIn(page);
  const { context, till } = await newTill(browser, page, 'Offline C');
  const series = (await sell(till)).split('-')[0]!;
  await context.setOffline(true);
  let tab = till;
  for (const wait of [0, 15, 60]) {
    // Scan, take cash, press issue, and close the app before (or while) it is saved.
    const search = tab.getByRole('combobox', { name: 'Add an item' });
    await search.fill(COCONUT);
    await search.press('Enter');
    await expect(tab.locator('.cart-lines li')).toHaveCount(1);
    await tab.getByLabel('Cash received').fill('5');
    void tab.getByRole('button', { name: /Issue receipt/ }).click().catch(() => {});
    if (wait) await new Promise((r) => setTimeout(r, wait));
    await tab.close({ runBeforeUnload: false });

    // Opened again: whatever is still in the cart is issued again (the same sale, if it was saved).
    tab = await context.newPage();
    await tab.goto('/pos');
    await signIn(tab);
    if (await tab.locator('.cart-lines li').count()) {
      await tab.getByRole('button', { name: /Issue receipt/ }).click();
      await expect(tab.locator('.cart-lines li')).toHaveCount(0);
    }
  }
  await context.setOffline(false);
  await expect(indicator(tab)).toContainText('Online · all sent', { timeout: 30_000 });
  // The first sale and one for each of the three closed attempts: four, numbered 1 to 4.
  const docs = await seriesDocs(page, series);
  expect(docs.map((d) => d.serial).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  await context.close();
});

test('offline: two tills sell the last mug while both are offline; both sales stand, stock goes below zero and is flagged', async ({ page, browser }) => {
  await logIn(page);
  const barcode = `75019${String(Date.now()).slice(-8)}`;
  const item = await api<{ id: string }>(page, 'POST', '/v1/items', { name: 'Last mug', unitCode: 'H87', unitPrice: '20', gstCategory: 'S', barcode });
  await api(page, 'PUT', `/v1/inventory/${item.id}/settings`, { track: true, quantity: '1' });
  const one = await newTill(browser, page, 'Offline D');
  const two = await newTill(browser, page, 'Offline E');
  await one.context.setOffline(true);
  await two.context.setOffline(true);
  const a = await sell(one.till, barcode, '25');
  const b = await sell(two.till, barcode, '25');
  expect(a.split('-')[0]).not.toBe(b.split('-')[0]);

  await one.context.setOffline(false);
  await expect(indicator(one.till)).toContainText('Online · all sent', { timeout: 30_000 });
  await two.context.setOffline(false);
  await expect(indicator(two.till)).toContainText('Online · all sent', { timeout: 30_000 });
  const stock = await api<{ item: { stock: number } } & { stock?: number }>(page, 'GET', `/v1/inventory/${item.id}`);
  expect(stock.item?.stock ?? stock.stock).toBe(-1);
  // The second till's sync screen shows the warning.
  await two.till.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(two.till.locator('.sync-screen')).toContainText('Last mug is now at -1 in stock');
  await one.context.close();
  await two.context.close();
});

test('offline: a long time without a connection: many sales; signing in offline stops after 7 days', async ({ page, browser }) => {
  // 25 sales through the counter, two jumps of days, and the upload: longer than one ordinary test.
  test.setTimeout(240_000);
  await logIn(page);
  const { context, till } = await newTill(browser, page, 'Offline F', async (_c, t) => {
    await t.clock.install();
  });
  await lock(till);
  await context.setOffline(true);
  await signIn(till);
  const numbers: string[] = [];
  for (let i = 0; i < 25; i++) numbers.push(await sell(till));
  const series = numbers[0]!.split('-')[0]!;
  await lock(till);
  await expect(indicator(till)).toContainText('Offline · 25 to send');

  // Six days later, still offline: the remembered PIN works.
  await till.clock.fastForward(6 * 86_400_000);
  await signIn(till);
  await lock(till);
  // Eight days: no more; the till needs the server to check the PIN again.
  await till.clock.fastForward(2 * 86_400_000);
  await signIn(till, /works for 7 days/);
  await till.getByRole('button', { name: 'Back' }).click();

  // Connected again: signing in works, and every sale goes up, once.
  await context.setOffline(false);
  await signIn(till);
  await expect(indicator(till)).toContainText('Online · all sent', { timeout: 60_000 });
  const docs = await seriesDocs(page, series);
  expect(docs.length).toBe(25);
  expect(new Set(docs.map((d) => d.etdui)).size).toBe(25);
  await context.close();
});
