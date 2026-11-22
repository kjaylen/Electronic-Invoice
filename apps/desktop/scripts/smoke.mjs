// Smoke test of the desktop till: starts the app with Playwright, checks the page, the storage, and a
// network receipt printer (a fake one on this computer). With SMOKE_SERVER and SMOKE_CODE (and
// SMOKE_PIN), it also pairs with that server and signs in.
//   npm run smoke
//   SMOKE_SERVER=http://localhost:3000 SMOKE_CODE=ABCD-EFGH SMOKE_PIN=2580 npm run smoke

import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const userData = mkdtempSync(join(tmpdir(), 'till-smoke-'));

// A pretend receipt printer on port 9101.
const received = [];
const printer = createServer((socket) => socket.on('data', (d) => received.push(...d)));
await new Promise((resolve) => printer.listen(9101, '127.0.0.1', resolve));

const executablePath = createRequire(import.meta.url)('electron');
const app = await electron.launch({ executablePath, args: [appDir, `--user-data-dir=${userData}`], cwd: appDir, timeout: 30_000 });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('text=Pair with your business', { timeout: 20_000 });
  console.log('✓ the till opens on the pairing screen');

  const info = await page.evaluate(async () => {
    const d = window.tillDesktop;
    await d.store.set('till.token', 'till_secret');
    await d.store.set('till.server', 'http://localhost:3000');
    return { version: d.version, token: await d.store.get('till.token'), printers: await d.printers.list() };
  });
  assert.equal(info.token, 'till_secret');
  assert.ok(Array.isArray(info.printers));
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  const stored = readFileSync(join(userData, 'till.json'), 'utf8');
  assert.ok(!stored.includes('till_secret'), 'the token is encrypted on disk');
  console.log(`✓ version ${info.version}; storage works and the token is encrypted; ${info.printers.length} installed printers`);

  await page.evaluate(() => window.tillDesktop.printers.sendNetwork('127.0.0.1', 9101, Uint8Array.from([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x01])));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(received, [0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x01]);
  console.log('✓ ESC/POS bytes reach a network printer');
  const refused = await page.evaluate(() => window.tillDesktop.printers.sendNetwork('8.8.8.8', 9100, Uint8Array.from([1])).then(() => 'sent', (e) => e.message));
  assert.match(refused, /not on the local network/);
  console.log('✓ raw printing to the internet is refused');

  await page.evaluate(() => Promise.all([window.tillDesktop.store.remove('till.token'), window.tillDesktop.store.remove('till.server')]));

  if (process.env.SMOKE_SERVER && process.env.SMOKE_CODE) {
    await page.reload();
    await page.waitForSelector('text=Pair with your business');
    if (await page.isVisible('text=Change')) await page.click('text=Change');
    await page.fill('input[inputmode="url"]', process.env.SMOKE_SERVER);
    await page.fill('.pair-code', process.env.SMOKE_CODE);
    await page.click('button:has-text("Pair this till")');
    await page.waitForSelector('text=Who is selling?', { timeout: 15_000 });
    console.log('✓ paired with the server');
    if (process.env.SMOKE_PIN) {
      await page.click('.person >> nth=0');
      for (const d of process.env.SMOKE_PIN) await page.keyboard.press(d);
      await page.keyboard.press('Enter');
      await page.waitForSelector('text=Issue receipt', { timeout: 15_000 });
      console.log('✓ signed in with the PIN; the counter is ready');
      await page.click('button:has-text("Devices")');
      await page.waitForSelector('text=Receipt printers');
      await page.click('button:has-text("Network (Wi-Fi or Ethernet)")');
      await page.fill('input[placeholder="e.g. Front counter printer"]', 'Smoke printer');
      await page.fill('input[placeholder="192.168.1.50"]', '127.0.0.1');
      await page.getByRole('textbox', { name: 'Port', exact: true }).fill('9101');
      await page.click('button:has-text("Save")');
      received.length = 0;
      await page.click('button:has-text("Test")');
      await page.waitForSelector('text=Test page sent');
      await new Promise((r) => setTimeout(r, 300));
      const text = Buffer.from(received).toString('latin1');
      assert.match(text, /TEST PAGE/);
      assert.match(text, /Smoke printer/);
      console.log(`✓ a test page printed from the Devices screen (${received.length} bytes)`);
      await page.screenshot({ path: join(tmpdir(), 'till-desktop.png') });
      console.log(`  screenshot: ${join(tmpdir(), 'till-desktop.png')}`);
    }
  }
} finally {
  await app.close();
  printer.close();
  rmSync(userData, { recursive: true, force: true });
}
console.log('Desktop till smoke test passed');
