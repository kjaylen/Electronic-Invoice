/**
 * The worked examples the reference shows (web/examples), run as they are
 * from another origin against a real store: the page with the embed, the
 * page with plain fetch, and the React app. Only the three placeholders
 * (address, store, key) are filled in. If an example stops working, or the
 * API changes under it, this fails, so the docs cannot drift from what runs.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { type OutsideSite, serveSite, setUpStore, SLUG, type Store } from './outside-site.ts';

test.describe.configure({ mode: 'serial' });

const examples = fileURLToPath(new URL('../web/examples/', import.meta.url));
let store: Store;
let site: OutsideSite;
let floreo = '';
let reactBuild = '';

/** An example as written, with the reader's own values in place of the placeholders. */
const filled = (file: string) => readFileSync(join(examples, file), 'utf8')
  .replaceAll('https://YOUR-FLOREO', floreo).replaceAll('your-store', SLUG).replaceAll('pk_test_YOUR_KEY', store.key);

test.beforeAll(async ({ playwright }, info) => {
  floreo = String(info.project.use.baseURL);
  store = await setUpStore(playwright, floreo);
  // The React example is a Vite app: built the way its reader would, with their values in its .env.
  reactBuild = mkdtempSync(join(tmpdir(), 'floreo-react-example-'));
  await build({
    root: join(examples, 'react'), configFile: false, logLevel: 'error', base: './',
    define: { 'import.meta.env.VITE_FLOREO_URL': JSON.stringify(floreo), 'import.meta.env.VITE_FLOREO_STORE': JSON.stringify(SLUG), 'import.meta.env.VITE_FLOREO_KEY': JSON.stringify(store.key) },
    build: { outDir: reactBuild, emptyOutDir: true },
  });
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  site = await serveSite((path) => {
    if (path === '/embed.html') return { body: filled('html-embed/index.html'), type: types['.html']! };
    if (path === '/fetch.html') return { body: filled('html-fetch/index.html'), type: types['.html']! };
    // The same page with a key the store does not have.
    if (path === '/fetch-wrong-key.html') return { body: filled('html-fetch/index.html').replace(store.key, 'pk_test_AAAAAAAAAAAAAAAAAAAAAAAA'), type: types['.html']! };
    if (path.startsWith('/react/') && !path.includes('..')) {
      try {
        const file = path.slice('/react/'.length) || 'index.html';
        return { body: readFileSync(join(reactBuild, file)), type: types[extname(file)] ?? 'application/octet-stream' };
      } catch {
        return undefined;
      }
    }
    return undefined;
  });
});

test.afterAll(async () => {
  await store?.api.dispose();
  await site?.close();
});

test('the embed example: products, an order, and the page\'s own code hearing about it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${site.url}/embed.html`);
  const grid = page.locator('floreo-products');
  // Cheapest first, as the example asks; titles styled through ::part.
  await expect(grid.locator('.card')).toHaveCount(3);
  await expect(grid.locator('.card').first()).toContainText('Hot sauce trio');
  expect(await grid.locator('.title').first().evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
  await grid.locator('.card', { hasText: 'Reef-safe sunscreen' }).click();
  const dialog = page.locator('floreo-overlay dialog');
  await dialog.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveTitle('(1) My store');
  await dialog.getByRole('button', { name: 'Check out' }).click();
  await dialog.getByLabel('Full name').fill('Ana Buyer');
  await dialog.getByLabel('Phone').fill('501-610-0000');
  await dialog.getByLabel('Pickup').check();
  await dialog.getByLabel('Bank transfer').check();
  await dialog.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('#thanks')).toHaveText(/^Order #\d+ placed, BZ\$27\.00\.$/);
  await expect(dialog).toContainText('Thank you, Ana');
  await expect(page).toHaveTitle('My store');
  expect(errors).toEqual([]);
});

test('the fetch example: products, a cart priced by the store, a test card, and back paid', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${site.url}/fetch.html`);
  await expect(page.locator('.product')).toHaveCount(3);
  await page.locator('.product', { hasText: 'Island T-shirt' }).getByRole('button', { name: 'Add to cart' }).click();
  await page.locator('.product', { hasText: 'Island T-shirt' }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.locator('#cart')).toHaveText('2 × Island T-shirt – S, BZ$45.00 each');
  await expect(page.locator('#total')).toHaveText('Total BZ$90.00 (GST included: BZ$10.00)');
  await page.getByLabel('Full name').fill('Ana Buyer');
  await page.getByLabel('Phone').fill('501-610-0000');
  await page.getByLabel('Email (for the receipt)').fill('ana@example.test');
  await page.getByLabel('How to pay').selectOption('online');
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.waitForURL(new RegExp(`${SLUG}/shop/pay/`));
  await page.getByRole('button', { name: /^Pay BZ\$90\.00/ }).click();
  await page.waitForURL(`${site.url}/fetch.html`);
  await expect(page.locator('#message')).toContainText('Paid. Thank you! Order #');
  const number = /Order #(\d+)/.exec(await page.locator('#message').innerText())![1]!;
  await expect(page.locator('#message')).toContainText(`/v1/store/${SLUG}/orders/${number}/document?t=`);
  expect((await store.order(number)).paymentStatus).toBe('paid');
  expect(errors).toEqual([]);
});

test('the fetch example says what the store answered when a request is refused', async ({ page }) => {
  await page.goto(`${site.url}/fetch-wrong-key.html`);
  await expect(page.locator('#message')).toHaveClass('bad');
  await expect(page.locator('#message')).toContainText(`This publishable key is not one of the store "${SLUG}"`);
});

test('the React example: products, the cart priced by the store, an order', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${site.url}/react/`);
  await expect(page.locator('.products li')).toHaveCount(3);
  await page.locator('.products li', { hasText: 'Hot sauce trio' }).getByRole('button', { name: 'Add to cart' }).click();
  await page.locator('.products li', { hasText: 'Hot sauce trio' }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.locator('.cart li')).toHaveText('2 × Hot sauce trio');
  await expect(page.getByText('Total BZ$40.50')).toBeVisible();
  await page.getByLabel('Full name').fill('Ana Buyer');
  await page.getByLabel('Phone').fill('501-610-0000');
  await page.getByLabel('How to pay').selectOption('pay_at_pickup');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText(/Thank you\. Order #\d+ is placed\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'See your order' })).toHaveAttribute('href', new RegExp(`^${floreo}/${SLUG}/shop/orders/\\d+\\?t=`));
  expect(errors).toEqual([]);
});

test('the reference shows these same files, and what the store API answers', async ({ page }) => {
  await page.goto('/docs');
  const shown = async (within: string, name: string) => (await page.locator(`${within} .doc-sample`, { has: page.locator('.doc-sample-head', { hasText: name }) }).locator('pre').evaluate((el) => el.textContent ?? '')).replaceAll('\r\n', '\n');
  const file = (path: string) => readFileSync(join(examples, path), 'utf8').replaceAll('\r\n', '\n').replaceAll('https://YOUR-FLOREO', floreo);
  // Each sample is its file, with this server's address where the placeholder was.
  expect(await shown('#quick-start', 'index.html')).toBe(file('html-embed/index.html'));
  expect(await shown('#your-own-code', 'index.html')).toBe(file('html-fetch/index.html'));
  expect(await shown('#your-own-code', 'floreo.js')).toBe(file('react/floreo.js'));
  expect(await shown('#your-own-code', 'App.jsx')).toBe(file('react/App.jsx'));
  // The guides the dashboard links to are there, the store API comes first with example answers, and every event has a sample.
  for (const id of ['quick-start', 'embed', 'your-own-code', 'paying', 'keys', 'errors', 'webhooks', 'events', 'error-codes']) await expect(page.locator(`#${id}`)).toHaveCount(1);
  const first = page.locator('.doc-op').first();
  await expect(first).toContainText('/v1/store/{slug}/info');
  await expect(first.locator('.doc-answer')).toContainText('"currency": "BZD"');
  await expect(first).toContainText("-H 'Authorization: Bearer pk_test_…'");
  await expect(page.locator('#events details')).toHaveCount(19);
  await expect(page.locator('#error-codes tbody tr', { hasText: 'origin_not_allowed' })).toContainText('403');
  // In Spanish, the guides are too.
  await page.getByRole('button', { name: 'Change language' }).click();
  await expect(page.locator('#quick-start h2')).toHaveText('Inicio rápido');
});
