// Screenshots of every till screen and state, at the four sizes the tills are designed for, into
// docs/design/<phase>/<size>/ (and <theme> for "after"). For the design audit and its before/after
// comparison (docs/design/AUDIT.md). Needs a server with the browser tests' business (npm run e2e,
// then node e2e/view.ts), with Rosa Owner's PIN 4826.
//
//   node scripts/pos-shots.mjs --phase before
//   node scripts/pos-shots.mjs --phase after --theme dark --base http://localhost:3160
//   node scripts/pos-shots.mjs --phase after --only till        (one size)

import { chromium, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const phase = arg('phase', 'before');
const theme = arg('theme', 'light');
const BASE = arg('base', 'http://localhost:3160');
const only = arg('only', null);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet-8in', width: 800, height: 1280, mobile: true },
  { name: 'till-15in', width: 1366, height: 768, mobile: false, touch: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
].filter((s) => !only || s.name.startsWith(only));
const API = { 'X-Requested-With': 'etd-web', 'X-Business': 'corner-store' };
const PIN = '4826';

const owner = await request.newContext({ baseURL: BASE, extraHTTPHeaders: API });
const login = await owner.post('/v1/auth/login', { data: { business: 'corner-store', login: 'rosa@cornerstore.test', password: 'my brand new password' } });
if (!login.ok()) throw new Error(`Owner login: ${await login.text()}`);
const call = async (method, url, data) => {
  const r = await owner.fetch(url, { method, ...(data !== undefined && { data }) });
  return r.ok() ? r.json().catch(() => null) : null;
};

// A restaurant and bar: two areas, a kitchen, a choice on the Johnny cakes; nothing left open from before.
async function setUpVenue() {
  await call('PUT', '/v1/venue/settings', { restaurant: true, bar: true, hotel: false });
  const venue = await call('GET', '/v1/venue');
  const changes = await call('GET', '/v1/venue/changes');
  for (const c of changes?.checks ?? []) {
    const owing = c.items.filter((i) => i.status !== 'void' && i.paid.reduce((a, p) => a + p.shares, 0) < i.shares).map((i) => i.id);
    const op = (type, payload = {}) => ({ id: crypto.randomUUID(), checkId: c.id, type, at: new Date().toISOString(), payload });
    if (owing.length) await call('POST', '/v1/venue/ops', { ops: [op('void', { itemIds: owing, reason: 'Screenshots tidy-up' })] });
    const now = (await call('GET', `/v1/venue/checks/${c.id}`))?.status;
    if (now === 'open' || now === 'paid') await call('POST', '/v1/venue/ops', { ops: [op(now === 'paid' ? 'clean' : 'close')] });
  }
  if (!venue.floor.some((p) => p.area === 'Dining room')) {
    await call('POST', '/v1/venue/floor', { area: 'Dining room', items: [
      { id: 't1', type: 'table', name: 'Table 1', shape: 'round', seats: 4, x: 80, y: 120, w: 180, h: 280 },
      { id: 't2', type: 'table', name: 'Table 2', shape: 'rect', seats: 6, x: 340, y: 120, w: 260, h: 280 },
      { id: 'b1', type: 'stool', name: 'Bar 1', shape: 'round', seats: 1, x: 700, y: 120, w: 120, h: 200 },
      { id: 'w1', type: 'wall', name: '', x: 0, y: 0, w: 1000, h: 20 },
    ] });
  }
  if (!venue.floor.some((p) => p.area === 'Patio')) {
    await call('POST', '/v1/venue/floor', { area: 'Patio', items: [
      { id: 'p1', type: 'table', name: 'P1', shape: 'square', seats: 2, x: 100, y: 200, w: 140, h: 220 },
      { id: 'p2', type: 'table', name: 'P2', shape: 'square', seats: 2, x: 320, y: 200, w: 140, h: 220 },
      { id: 'p3', type: 'table', name: 'P3', shape: 'rect', seats: 8, x: 560, y: 200, w: 320, h: 260 },
      { id: 'f1', type: 'fixture', name: 'Door', x: 0, y: 860, w: 160, h: 60 },
    ] });
  }
}

await setUpVenue();
// One pairing for every size (the server limits pairings), kept in the browser's storage.
const pairing = (await call('POST', '/v1/pos/devices', { name: `Screens ${Math.random().toString(36).slice(2, 6)}` }))?.pairing;
if (!pairing) throw new Error('Could not add a till');

const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
let storage;
{
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto(`/pos?pair=${pairing.code}`);
  await page.waitForSelector('text=/Who is selling\\?|Rosa Owner/', { timeout: 30_000 });
  storage = await ctx.storageState();
  await ctx.close();
}

for (const size of SIZES) {
  const dir = join(root, 'docs', 'design', phase, ...(phase === 'after' ? [theme] : []), size.name);
  mkdirSync(dir, { recursive: true });
  // Every size starts from the same floor: nothing open.
  await setUpVenue();
  let n = 0;
  const ctx = await browser.newContext({
    baseURL: BASE, viewport: { width: size.width, height: size.height }, storageState: storage,
    isMobile: size.mobile, hasTouch: size.mobile || size.touch, deviceScaleFactor: 1, colorScheme: theme === 'dark' ? 'dark' : 'light',
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem('till.theme', t); } catch { /* blocked */ } }, theme);
  const page = await ctx.newPage();
  const shot = async (name) => {
    await page.waitForTimeout(450);
    n++;
    await page.screenshot({ path: join(dir, `${String(n).padStart(2, '0')}-${name}.jpg`), type: 'jpeg', quality: 72 });
  };
  const step = async (name, fn) => {
    try {
      await fn();
      // For checking a layout: PROBE_STEP=sell-cash PROBE_JS='...' prints what the script returns.
      if (process.env.PROBE_STEP === name) console.log(JSON.stringify(await page.evaluate(process.env.PROBE_JS), null, 1));
      await shot(name);
    } catch (e) {
      console.log(`  ${size.name} ${name}: skipped (${e.message.split('\n')[0]})`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  };
  const tab = (label) => page.locator('.till-tabs button, .status-tabs button, nav[aria-label="Till"] button').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  const sellOne = async (code) => {
    const search = page.getByRole('combobox', { name: 'Add an item' });
    await search.fill(code);
    await search.press('Enter');
  };

  await page.goto('/pos');
  await step('staff', () => page.waitForSelector('text=/Who is selling\\?|Enter your PIN/'));
  await step('pin', async () => {
    if (await page.isVisible('h1:has-text("Who is selling?")')) await page.click('button:has-text("Rosa Owner")');
    await page.waitForSelector('text=Enter your PIN');
    await page.keyboard.press('4');
    await page.keyboard.press('8');
  });
  await page.keyboard.press('2');
  await page.keyboard.press('6');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.till-tabs, .status-bar', { timeout: 30_000 }).catch(() => {});
  // No printing in a test browser.
  try {
    await tab('Devices');
    await page.getByLabel('Print each receipt automatically').uncheck({ timeout: 5000 });
  } catch { /* already off */ }

  await step('floor', async () => { await tab('Floor'); await page.waitForSelector('[aria-label^="Floor plan of"]'); });
  await step('floor-seat', async () => { await page.locator('[aria-label^="Table 1"]').first().click(); await page.waitForSelector('[role="dialog"]'); });
  await step('order', async () => { await page.getByRole('dialog').getByRole('button', { name: /^Open the table/ }).click(); await page.waitForSelector('.venue-order-head, .order-screen'); });
  await step('order-choices', async () => { await page.locator('.venue-item, .product-tile').filter({ hasText: 'Johnny cakes' }).first().click(); await page.waitForSelector('[role="dialog"]'); });
  await step('order-lines', async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByText('With butter').click();
    await dialog.getByRole('button', { name: /^Add/ }).click();
    await page.locator('.venue-item, .product-tile').filter({ hasText: 'Coconut water' }).first().click();
    await page.waitForTimeout(300);
  });
  await step('order-pay-split', async () => { await page.getByRole('button', { name: 'Pay', exact: true }).click(); await page.waitForSelector('[role="dialog"]'); });
  await page.keyboard.press('Escape').catch(() => {});
  await step('floor-busy', async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.venue-order-head button, .order-back').first().click();
    await page.waitForSelector('[aria-label^="Floor plan of"]');
  });
  await step('tabs', async () => { await page.getByRole('button', { name: /^Tabs/ }).click(); await page.waitForSelector('[role="dialog"]'); });
  await page.keyboard.press('Escape').catch(() => {});
  await step('kitchen', async () => { await tab('Kitchen'); await page.waitForTimeout(500); });

  await step('sell-empty', async () => { await tab('Sell'); await page.waitForSelector('button:has-text("Issue receipt")'); });
  await step('sell-lines', async () => { await sellOne('7501000000017'); await sellOne('JC'); await sellOne('7501000000017'); await page.waitForSelector('.cart-lines li'); });
  await step('sell-cash', async () => { await page.getByLabel('Cash received').fill('20'); });
  await step('sell-done', async () => { await page.getByRole('button', { name: /Issue receipt/ }).click(); await page.waitForSelector('.last-sale, .sale-done'); });
  // A receipt can be refunded once the server has it.
  await page.waitForFunction(() => document.querySelector('.sync-indicator')?.textContent?.includes('all sent'), null, { timeout: 30_000 }).catch(() => {});
  await step('sales', async () => { await tab('Sales'); await page.waitForSelector('.sale-list li'); });
  await step('sale-detail', async () => { await page.locator('.sale-list li button').first().click(); await page.waitForSelector('[role="dialog"]'); });
  await step('refund', async () => { await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click(); await page.waitForSelector('text=/A credit note goes to BTS/'); });
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await step('shift', async () => { await tab('Shift'); await page.waitForTimeout(400); });
  const opening = await page.getByRole('button', { name: 'Open shift' }).first().isVisible().catch(() => false);
  await step('shift-open', async () => {
    if (opening) {
      await page.getByRole('button', { name: 'Open shift' }).first().click();
      await page.getByLabel('Cash in the drawer to start (float)').fill('50');
    } else {
      await page.getByRole('button', { name: /Cash in\/out/ }).first().click();
    }
    await page.waitForSelector('[role="dialog"]');
  });
  if (opening) {
    await page.getByRole('dialog').getByRole('button', { name: 'Open shift' }).click().catch(() => {});
    await page.waitForTimeout(600);
    await shot('shift-running');
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await step('shift-close', async () => { await page.getByRole('button', { name: /Close shift/ }).first().click(); await page.waitForSelector('[role="dialog"]'); });
  await page.keyboard.press('Escape').catch(() => {});
  await step('devices', async () => { await tab('Devices'); await page.waitForTimeout(300); });
  await step('sync', async () => { await tab('Sync'); await page.waitForTimeout(300); });
  await ctx.close();
  console.log(`${size.name}: ${n} screens in ${dir}`);
}

// The pairing screen, on a till that has not been set up.
for (const size of SIZES) {
  const dir = join(root, 'docs', 'design', phase, ...(phase === 'after' ? [theme] : []), size.name);
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, colorScheme: theme === 'dark' ? 'dark' : 'light' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('till.theme', t); } catch { /* blocked */ } }, theme);
  const page = await ctx.newPage();
  await page.goto('/pos');
  await page.waitForSelector('text=Pair with your business').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, '00-pair.jpg'), type: 'jpeg', quality: 72 });
  await ctx.close();
}
await browser.close();
await owner.dispose();
