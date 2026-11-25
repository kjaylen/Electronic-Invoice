// The four everyday flows on a real till app, end to end, against a server with the browser tests'
// business (npm run e2e, then node e2e/view.ts):
//
//   1. a three-item cash sale (the tiles, Exact, Pay; Pay is on screen without scrolling)
//   2. a refund of that sale (once the server has it), with a one-tap reason
//   3. a table order: seat a party, order for two seats (a required choice), send, pay seat by seat
//   4. closing the shift
//
//   node scripts/till-flows.mjs --app desktop               (the packaged app in apps/desktop/release/win-unpacked)
//   node scripts/till-flows.mjs --app android               (the installed debug app, emulator or USB phone)
//   --server http://localhost:3160   ADB=path\to\adb   Screenshots go to --out (default: the OS temp folder).

import { _electron as electron, chromium, request } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const APP = arg('app', 'desktop');
const SERVER = arg('server', 'http://localhost:3160');
const OUT = arg('out', join(tmpdir(), `till-flows-${APP}`));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = { business: 'corner-store', login: 'rosa@cornerstore.test', password: 'my brand new password' };
const PIN = '4826';
const ADB = process.env.ADB ?? 'adb';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shots = 0;
const step = async (page, text) => {
  console.log(`✓ ${text}`);
  const file = join(OUT, `${String(++shots).padStart(2, '0')}.png`);
  if (APP === 'android') {
    // What the phone really shows (a screenshot over DevTools uses a viewport of its own).
    await sleep(600);
    writeFileSync(file, execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
  } else await page.screenshot({ path: file }).catch(() => {});
};

// The business: table service on, nothing left open at the tables, a till of its own.
const owner = await request.newContext({ baseURL: SERVER, extraHTTPHeaders: { 'X-Requested-With': 'etd-web', 'X-Business': OWNER.business } });
assert.ok((await owner.post('/v1/auth/login', { data: OWNER })).ok(), 'the owner signs in');
const call = async (method, url, data) => {
  const r = await owner.fetch(url, { method, ...(data !== undefined && { data }) });
  assert.ok(r.ok(), `${method} ${url}: ${await r.text()}`);
  return r.json().catch(() => null);
};
await call('PUT', '/v1/venue/settings', { restaurant: true, bar: true, hotel: false });
for (const c of (await call('GET', '/v1/venue/changes')).checks ?? []) {
  const owing = c.items.filter((i) => i.status !== 'void' && i.paid.reduce((a, p) => a + p.shares, 0) < i.shares).map((i) => i.id);
  const op = (type, payload = {}) => ({ id: crypto.randomUUID(), checkId: c.id, type, at: new Date().toISOString(), payload });
  if (owing.length) await call('POST', '/v1/venue/ops', { ops: [op('void', { itemIds: owing, reason: 'Flows check tidy-up' })] });
  const now = (await call('GET', `/v1/venue/checks/${c.id}`))?.status;
  if (now === 'open' || now === 'paid') await call('POST', '/v1/venue/ops', { ops: [op(now === 'paid' ? 'clean' : 'close')] });
}
const { pairing } = await call('POST', '/v1/pos/devices', { name: `${APP} flows ${Date.now() % 100000}` });

// The app.
let page;
let close = async () => {};
if (APP === 'desktop') {
  const exe = join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'Floreo Till.exe');
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'till-flows-'))}`], timeout: 30_000 });
  page = await app.firstWindow();
  close = () => app.close();
} else {
  const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const port = new URL(SERVER).port;
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  adb('shell', 'pm', 'clear', 'bz.floreo.till');
  // On the phone's own screen (an emulator can have a second display).
  adb('shell', 'am', 'start', '--display', '0', '-n', 'bz.floreo.till/.MainActivity');
  let socket = '';
  for (let i = 0; i < 80 && !socket; i++) {
    await sleep(500);
    let pid = '';
    try { pid = adb('shell', 'pidof', 'bz.floreo.till').split(/\s+/)[0] ?? ''; } catch { continue; }
    if (pid) socket = adb('shell', 'cat', '/proc/net/unix').split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '').find((s) => s === `@webview_devtools_remote_${pid}`) ?? '';
  }
  assert.ok(socket, 'the web view can be debugged');
  try { adb('forward', '--remove', 'tcp:9334'); } catch { /* none */ }
  adb('forward', 'tcp:9334', `localabstract:${socket.slice(1)}`);
  const browser = await chromium.connectOverCDP('http://localhost:9334');
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https://localhost'));
    if (!page) await sleep(250);
  }
  close = () => browser.close();
}
assert.ok(page, 'the till is open');
page.setDefaultTimeout(30_000);

try {
  // Pair and sign in by tapping the PIN pad.
  await page.waitForSelector('text=Pair with your business');
  if (await page.isVisible('text=Change')) await page.click('text=Change');
  await page.fill('input[inputmode="url"]', SERVER);
  await page.fill('.pair-code', pairing.code);
  await page.click('button:has-text("Pair this till")');
  await page.waitForSelector('text=/Who is selling\\?|Enter your PIN/');
  if (await page.isVisible('h1:has-text("Who is selling?")')) await page.click('.person:has-text("Rosa Owner")');
  for (const d of PIN) await page.click(`.pin-pad button:text-is("${d}")`);
  await page.click('.pin-pad button[aria-label="Sign in"]');
  await page.waitForSelector('.status-tabs');
  await step(page, 'paired and signed in with the PIN pad');
  const tab = (name) => page.click(`.status-tabs button:has-text("${name}")`);
  await tab('Devices');
  await page.getByLabel('Print each receipt automatically').uncheck();

  // 1. A three-item cash sale.
  await tab('Sell');
  await page.click('.shift-bar button:has-text("Open shift")');
  await page.getByLabel('Cash in the drawer to start (float)').fill('50');
  await page.click('[role="dialog"] button:has-text("Open shift")');
  await page.waitForSelector('.shift-bar.open');
  for (const name of ['Coconut water', 'Johnny cakes', 'Coconut water']) await page.click(`button.quick:has-text("${name}")`);
  await page.waitForFunction(() => document.querySelectorAll('.cart-lines li').length === 2);
  await page.click('.quick-cash button:has-text("Exact")');
  const pay = page.locator('.cart button.big.lime');
  const box = await pay.boundingBox();
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.ok(box && box.y >= 0 && box.y + box.height <= view.h + 1, `Pay is on screen without scrolling (${JSON.stringify(box)} in ${JSON.stringify(view)})`);
  await step(page, `three items in the order, Exact, Pay on screen (${await pay.textContent()})`);
  await pay.click();
  await page.waitForSelector('.last-sale');
  const receipt = (await page.textContent('.last-sale h2')).split('·')[0].trim();
  await step(page, `sold ${receipt} in 5 taps (3 tiles, Exact, Pay)`);

  // 2. The refund, once the server has the sale.
  await page.waitForFunction(() => document.querySelector('.sync-indicator')?.textContent?.includes('all sent'), null, { timeout: 60_000 });
  await tab('Sales');
  await page.click(`.sale-list li button:has-text("${receipt}")`);
  await page.click('[role="dialog"] button:text-is("Refund")');
  await page.click('[role="dialog"] .chip-row button:has-text("Returned")');
  await step(page, 'the refund, with a one-tap reason');
  await page.click('[role="dialog"] button:has-text("Issue the refund")');
  await page.waitForSelector('text=/Refund issued/');
  await step(page, `refunded ${receipt}`);

  // 3. A table order paid seat by seat.
  await tab('Floor');
  if (await page.isVisible('.pos-seg button:has-text("Plan")')) await page.click('.pos-seg button:has-text("Plan")');
  await page.click('[aria-label^="Table 2: Free"]');
  await page.click('[role="dialog"] button:has-text("Open the table")');
  await page.waitForSelector('.venue-order');
  await page.click('.venue-seats[aria-label="Seat"] button:text-is("1")');
  await page.click('.venue-item:has-text("Coconut water")');
  await page.click('.venue-seats[aria-label="Seat"] button:text-is("2")');
  await page.click('.venue-item:has-text("Johnny cakes")');
  await page.click('[role="dialog"] button:has-text("With butter")');
  await page.click('[role="dialog"] button.add-to-order');
  await page.click('.venue-actions button:has-text("Send")');
  await step(page, 'Table 2: one item for each of two seats, sent');
  for (const seat of ['Seat 1', 'Seat 2']) {
    await page.click('.venue-actions button:text-is("Pay")');
    await page.click('[role="dialog"] button:has-text("By seat")');
    await page.click(`[role="dialog"] button:has-text("${seat}")`);
    await page.waitForSelector('.venue-paying .cart');
    await page.click('.quick-cash button:has-text("Exact")');
    await page.click('.cart button.big.lime');
    await page.waitForSelector(seat === 'Seat 1' ? '.venue-order' : '[aria-label^="Table 2: Needs cleaning"]');
    await step(page, `${seat} paid`);
  }
  await page.click('[aria-label^="Table 2: Needs cleaning"]');
  await page.click('button:has-text("Table is clean")');
  await page.waitForSelector('[aria-label^="Table 2: Free"]');
  await step(page, 'Table 2 paid in two parts and free again');

  // 4. The shift closed.
  await tab('Shift');
  await page.click('.shift-actions button:has-text("Close shift")');
  await page.click('[role="dialog"] button:has-text("Just the total")');
  await page.getByLabel('Cash counted (BZ$)').fill('60');
  await step(page, 'counting the drawer');
  await page.click('[role="dialog"] button:text-is("Close shift")');
  await page.waitForSelector('.till-shift-screen button:has-text("Open shift")');
  await step(page, 'the shift is closed');
  console.log(`${APP}: all four flows done. Screenshots in ${OUT}`);
} finally {
  await close();
}
