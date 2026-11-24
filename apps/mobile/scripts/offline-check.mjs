// The offline check for the Android till, end to end, on an emulator or a phone with USB debugging,
// with a real outage (the server is stopped, not emulated):
//
//   1. pair the installed debug app with the server, sign in, open a shift, sell once (online)
//   2. stop the server; sell three more (offline)
//   3. stop the app and start it again, still without the server: sign in offline, sell once more
//   4. start the server, start the app again: everything is sent, and the server has each sale exactly once
//
// The app's web view is driven over the DevTools protocol (adb forward); the server is reached through
// adb reverse, as http://localhost:<port> on the device. Uses the browser tests' business (npm run e2e).
//   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
//   node scripts/offline-check.mjs            (from apps/mobile; ADB=path\to\adb if it is not on the PATH)

import { chromium, request } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ADB = process.env.ADB ?? 'adb';
const APP = 'bz.floreo.till';
const PORT = process.env.CHECK_PORT ?? '3121';
const DEVTOOLS = Number(process.env.CHECK_DEVTOOLS_PORT ?? 9333);
const SERVER = `http://localhost:${PORT}`;
const OWNER = { business: 'corner-store', login: 'rosa@cornerstore.test', password: process.env.CHECK_PASSWORD ?? 'my brand new password' };
const PIN = process.env.CHECK_PIN ?? '4826';
const COCONUT = '7501000000017';
const step = (s) => console.log(`✓ ${s}`);
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SERVER}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  return false;
}
const startServer = () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'e2e/view.ts'], {
  cwd: repo, env: { ...process.env, VIEW_PORT: PORT, VIEW_BTS_PORT: String(Number(PORT) + 5500) }, stdio: 'ignore',
});
async function stopServer(child) {
  child.kill();
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${SERVER}/health`);
    } catch {
      return;
    }
    await sleep(250);
  }
  throw new Error('The server did not stop');
}

/** Start the app and attach to its web view. */
async function openApp() {
  adb('shell', 'am', 'force-stop', APP);
  adb('shell', 'monkey', '-p', APP, '-c', 'android.intent.category.LAUNCHER', '1');
  let socket = '';
  for (let i = 0; i < 60 && !socket; i++) {
    await sleep(500);
    const pid = adb('shell', 'pidof', APP).split(/\s+/)[0];
    if (!pid) continue;
    const unix = adb('shell', 'cat', '/proc/net/unix');
    socket = unix.split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '').find((s) => s === `@webview_devtools_remote_${pid}`) ?? '';
  }
  assert.ok(socket, 'the app\'s web view can be debugged (a debug build)');
  try {
    adb('forward', '--remove', `tcp:${DEVTOOLS}`);
  } catch {
    /* none yet */
  }
  adb('forward', `tcp:${DEVTOOLS}`, `localabstract:${socket.slice(1)}`);
  const browser = await chromium.connectOverCDP(`http://localhost:${DEVTOOLS}`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https://localhost'));
    if (!page) await sleep(250);
  }
  assert.ok(page, 'the till page is open');
  return { browser, page };
}

async function signIn(page) {
  await page.waitForSelector('text=/Who is selling\\?|Rosa Owner/', { timeout: 30_000 });
  if (await page.isVisible('h1:has-text("Who is selling?")')) await page.click('button:has-text("Rosa Owner")');
  await page.waitForSelector('text=Enter your PIN');
  for (const d of PIN) await page.click(`.pin-pad button:text-is("${d}")`);
  await page.click('.pin-pad button[aria-label="Sign in"]');
  await page.waitForSelector('button:has-text("Issue receipt")', { timeout: 30_000 });
}

async function sell(page) {
  const search = page.getByRole('combobox', { name: 'Add an item' });
  await search.fill(COCONUT);
  await search.press('Enter');
  await page.waitForSelector('.cart-lines li');
  await page.fill('input[aria-label="Cash received"]', '5');
  await page.click('button:has-text("Issue receipt")');
  await page.waitForFunction(() => document.querySelectorAll('.cart-lines li').length === 0);
  return (await page.textContent('.last-sale h2')).split('·')[0].trim();
}
const waitIndicator = (page, text, timeout = 30_000) => page.waitForFunction((t) => document.querySelector('.till-bar .sync-indicator')?.textContent?.includes(t), text, { timeout });
const indicator = (page) => page.textContent('.till-bar .sync-indicator');

adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
let server = startServer();
assert.ok(await up(), 'the server starts');
const owner = await request.newContext({ baseURL: SERVER, extraHTTPHeaders: { 'X-Requested-With': 'etd-web', 'X-Business': OWNER.business } });
assert.ok((await owner.post('/v1/auth/login', { data: OWNER })).ok());
const added = await owner.post('/v1/pos/devices', { data: { name: `Android offline ${Date.now() % 100000}` } });
assert.ok(added.ok(), await added.text());
const { pairing } = await added.json();
// A fresh install: nothing left from an earlier run.
adb('shell', 'pm', 'clear', APP);
step(`a till added in the web app (pairing code ${pairing.code}); the app's data cleared`);

// 1. Online.
let { browser, page } = await openApp();
await page.waitForSelector('text=Pair with your business', { timeout: 30_000 });
if (await page.isVisible('button:has-text("Change")')) await page.click('button:has-text("Change")');
await page.fill('input[inputmode="url"]', SERVER);
await page.fill('.pair-code', pairing.code);
await page.click('button:has-text("Pair this till")');
await signIn(page);
await page.click('.till-tabs button:has-text("Devices")');
await page.uncheck('text=Print each receipt automatically');
await page.click('.till-tabs button:has-text("Sell")');
await page.click('button:has-text("Open shift")');
await page.getByLabel('Cash in the drawer to start (float)').fill('50');
await page.click('[role="dialog"] button:has-text("Open shift")');
await page.waitForSelector('.shift-bar.open');
const numbers = [await sell(page)];
const series = numbers[0].split('-')[0];
await waitIndicator(page, 'all sent');
step(`paired, signed in, shift opened, sold ${numbers[0]} online: ${await indicator(page)}`);

// 2. The server goes away.
await stopServer(server);
for (let i = 0; i < 3; i++) numbers.push(await sell(page));
await waitIndicator(page, 'Offline');
step(`server stopped; sold ${numbers.slice(1).join(', ')}: ${await indicator(page)}`);

// 3. The app stopped and started again, without the server.
await browser.close();
({ browser, page } = await openApp());
await signIn(page);
numbers.push(await sell(page));
await page.click('.till-tabs button:has-text("Sales")');
for (const n of numbers) await page.waitForSelector(`.sale-list li:has-text("${n}")`);
assert.equal(new Set(numbers).size, 5);
step(`app restarted offline, signed in offline, sold ${numbers[4]}; all 5 in the sales list: ${await indicator(page)}`);
const secure = await page.evaluate(() => localStorage.getItem('till.dbkey') === null && localStorage.getItem('till.token') === null);
assert.ok(secure, 'no secrets in the web view\'s plain storage');
await browser.close();

// 4. The server is back.
server = startServer();
assert.ok(await up(), 'the server starts again');
({ browser, page } = await openApp());
await signIn(page);
await waitIndicator(page, 'all sent', 60_000);
const docs = [];
let cursor = null;
do {
  const body = await (await owner.get(`/v1/documents?type=02&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
  docs.push(...body.data.filter((d) => d.series === series));
  cursor = body.nextCursor;
} while (cursor);
assert.equal(docs.length, 5, `the server has ${docs.length} receipts in series ${series}`);
assert.equal(new Set(docs.map((d) => d.etdui)).size, 5);
assert.deepEqual(docs.map((d) => d.serial).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
step(`server back: ${await indicator(page)}; it has each of the 5 receipts exactly once (${docs.map((d) => d.status).join(', ')})`);

await browser.close();
await stopServer(server);
await owner.dispose();
adb('reverse', '--remove', `tcp:${PORT}`);
console.log('Android offline check passed.');
