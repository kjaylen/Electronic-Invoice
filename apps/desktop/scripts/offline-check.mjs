// The offline check for the desktop till, end to end, with a real outage: the server is stopped, not emulated.
//
//   1. pair a new till with the server, sign in, open a shift, sell once (online)
//   2. stop the server; sell three more (offline)
//   3. quit the app and start it again, still without the server: sign in with the remembered PIN, sell once more
//   4. start the server, start the app again: everything is sent, and the server has each sale exactly once
//
// Uses the browser tests' business (npm run e2e first) through e2e/view.ts on its own port.
//   node scripts/offline-check.mjs            (from apps/desktop, after npm run web)

import { _electron as electron, request } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(appDir, '..', '..');
const PORT = process.env.CHECK_PORT ?? '3120';
const SERVER = `http://localhost:${PORT}`;
const OWNER = { business: 'corner-store', login: 'rosa@cornerstore.test', password: process.env.CHECK_PASSWORD ?? 'my brand new password' };
const PIN = process.env.CHECK_PIN ?? '4826';
const COCONUT = '7501000000017';
const userData = mkdtempSync(join(tmpdir(), 'till-offline-'));
const executablePath = createRequire(import.meta.url)('electron');
const step = (s) => console.log(`✓ ${s}`);

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SERVER}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'e2e/view.ts'], {
    cwd: repo, env: { ...process.env, VIEW_PORT: PORT, VIEW_BTS_PORT: String(Number(PORT) + 5500) }, stdio: 'ignore',
  });
  return child;
}

async function stopServer(child) {
  child.kill();
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${SERVER}/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The server did not stop');
}

const launch = () => electron.launch({ executablePath, args: [appDir, `--user-data-dir=${userData}`], cwd: appDir, timeout: 30_000 });

async function signIn(page) {
  await page.waitForSelector('text=/Who is selling\\?|Rosa Owner/', { timeout: 30_000 });
  if (await page.isVisible('h1:has-text("Who is selling?")')) await page.click('button:has-text("Rosa Owner")');
  await page.waitForSelector('text=Enter your PIN');
  for (const d of PIN) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await page.waitForSelector('button:has-text("Issue receipt")', { timeout: 20_000 });
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

const indicatorText = (page) => page.textContent('.till-bar .sync-indicator');

let server = startServer();
assert.ok(await up(), 'the server starts');
const owner = await request.newContext({ baseURL: SERVER, extraHTTPHeaders: { 'X-Requested-With': 'etd-web', 'X-Business': OWNER.business } });
const login = await owner.post('/v1/auth/login', { data: OWNER });
assert.ok(login.ok(), await login.text());
const added = await owner.post('/v1/pos/devices', { data: { name: `Desktop offline ${Date.now() % 100000}` } });
assert.ok(added.ok(), await added.text());
const { pairing } = await added.json();
step(`a till added in the web app (pairing code ${pairing.code})`);

// 1. Online: pair, sign in, open a shift, sell.
let app = await launch();
let page = await app.firstWindow();
await page.waitForSelector('text=Pair with your business', { timeout: 20_000 });
if (await page.isVisible('button:has-text("Change")')) await page.click('button:has-text("Change")');
await page.fill('input[inputmode="url"]', SERVER);
await page.fill('.pair-code', pairing.code);
await page.click('button:has-text("Pair this till")');
await signIn(page);
await page.click('button:has-text("Devices")');
await page.uncheck('text=Print each receipt automatically');
await page.click('.till-tabs button:has-text("Sell")');
await page.click('button:has-text("Open shift")');
await page.fill('input[aria-label="Cash in the drawer to start (float)"], label:has-text("Cash in the drawer to start (float)") input', '50');
await page.click('[role="dialog"] button:has-text("Open shift")');
await page.waitForSelector('.shift-bar.open');
const numbers = [await sell(page)];
const series = numbers[0].split('-')[0];
await page.waitForFunction(() => document.querySelector('.till-bar .sync-indicator')?.textContent?.includes('all sent'), null, { timeout: 30_000 });
step(`paired, signed in, shift opened, sold ${numbers[0]} online: ${await indicatorText(page)}`);

// 2. The server goes away: the till keeps selling.
await stopServer(server);
for (let i = 0; i < 3; i++) numbers.push(await sell(page));
await page.waitForFunction(() => document.querySelector('.till-bar .sync-indicator')?.textContent?.includes('Offline'), null, { timeout: 30_000 });
step(`server stopped; sold ${numbers.slice(1).join(', ')}: ${await indicatorText(page)}`);

// 3. Quit and start again without the server: from the till's own copy, the remembered PIN.
await app.close();
app = await launch();
page = await app.firstWindow();
await signIn(page);
numbers.push(await sell(page));
await page.click('.till-tabs button:has-text("Sales")');
for (const n of numbers) await page.waitForSelector(`.sale-list li:has-text("${n}")`);
assert.equal(new Set(numbers).size, 5);
step(`restarted offline, signed in offline, sold ${numbers[4]}; the sales list has all 5: ${await indicatorText(page)}`);

// Nothing readable on the disk: the local database is encrypted, the key is sealed by Windows.
// (With the app closed: its database files are locked while it runs.)
await app.close();
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(join(userData, 'IndexedDB'));
const leaked = files.filter((f) => readFileSync(f).includes('Coconut water'));
assert.ok(files.length > 0, 'the till has a local database');
assert.deepEqual(leaked, [], 'item names are not in the local database in plain text');
const store = JSON.parse(readFileSync(join(userData, 'till.json'), 'utf8'));
assert.ok(String(store['till.dbkey']).startsWith('enc:') && String(store['till.token']).startsWith('enc:'), 'the key and the token are encrypted');
step(`on the disk (${files.length} database files): no business data in plain text; the data key and the till token are encrypted by the OS`);

// 4. The server is back: everything goes up, once.
server = startServer();
assert.ok(await up(), 'the server starts again');
app = await launch();
page = await app.firstWindow();
await signIn(page);
await page.waitForFunction(() => document.querySelector('.till-bar .sync-indicator')?.textContent?.includes('all sent'), null, { timeout: 60_000 });
const docs = [];
let cursor = null;
do {
  const res = await owner.get(`/v1/documents?type=02&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  const body = await res.json();
  docs.push(...body.data.filter((d) => d.series === series));
  cursor = body.nextCursor;
} while (cursor);
assert.equal(docs.length, 5, `the server has ${docs.length} receipts in series ${series}`);
assert.equal(new Set(docs.map((d) => d.etdui)).size, 5);
assert.deepEqual(docs.map((d) => d.serial).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
step(`server back: ${await indicatorText(page)}; it has each of the 5 receipts exactly once (${docs.map((d) => d.status).join(', ')})`);

await app.close();
await stopServer(server);
await owner.dispose();
console.log('Desktop offline check passed.');
