// Screenshots of the design system's component gallery (development server only) in both themes,
// into docs/design/gallery-<theme>.jpg.
//   npx vite --config web/vite.config.ts --port 5181      (one terminal)
//   node scripts/pos-gallery-shots.mjs [http://localhost:5181]

import { chromium } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5181';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem('till.theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${base}/pos.html?gallery`);
  await page.waitForSelector('.gallery-head', { timeout: 30_000 });
  await page.waitForTimeout(800);
  // The whole gallery, not just the screen: the page scrolls inside .gallery.
  await page.evaluate(() => { const g = document.querySelector('.gallery'); if (g) { g.style.height = 'auto'; g.style.overflow = 'visible'; } document.body.style.overflow = 'visible'; document.documentElement.style.height = 'auto'; const r = document.getElementById('root'); if (r) r.style.height = 'auto'; });
  await page.screenshot({ path: join(root, 'docs', 'design', `gallery-${theme}.jpg`), fullPage: true, type: 'jpeg', quality: 80 });
  await ctx.close();
}
await browser.close();
console.log('gallery screenshots saved');
