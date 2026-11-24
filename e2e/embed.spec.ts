/**
 * A site built somewhere else, in a real browser: a page on another origin
 * loads /embed.js with a publishable key and sells from the store. Products,
 * one product, the cart, the checkout, a test card and back to the site paid;
 * a checkout page of the site's own; the site's look and language; and what
 * the person building the site sees when something is set up wrong.
 *
 * Makes its own business (in the BTS test environment, where test payments
 * work), so it does not depend on the other tests.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SLUG = 'reef-goods';
const OWNER = { name: 'Maya Reef', email: 'maya@reefgoods.test', password: 'reef goods test only 1' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const cert = (name: string) => readFileSync(new URL(`../test/certs/${name}`, import.meta.url), 'utf8');

let api: APIRequestContext;
let site: Server;
let siteUrl = '';
let floreo = '';
let key = '';

/** The pages of the outside site: plain HTML with the one script tag. */
const page = (body: string, attrs = '', style = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reef Goods</title>
<style>body { font: 16px/1.5 Georgia, serif; max-width: 960px; margin: 0 auto; padding: 1.5rem; } ${style}</style>
<script src="${floreo}/embed.js" data-store="${SLUG}" ${attrs} async></script></head>
<body><h1>Reef Goods</h1>${body}</body></html>`;

const PAGES: Record<string, () => string> = {
  '/': () => page('<floreo-cart></floreo-cart><floreo-products limit="2" sort="title"></floreo-products>', `data-key="${key}"`),
  '/own-pages.html': () => page('<floreo-products sort="title" product-url="/product.html?handle={handle}"></floreo-products>', `data-key="${key}" data-checkout-url="/checkout.html"`),
  '/product.html': () => page('<floreo-product></floreo-product>', `data-key="${key}" data-checkout-url="/checkout.html"`),
  '/checkout.html': () => page('<floreo-checkout></floreo-checkout>', `data-key="${key}"`),
  '/button.html': () => page('<floreo-buy-button handle="hot-sauce-trio" label="Buy the hot sauce"></floreo-buy-button><floreo-buy-button handle="island-t-shirt" action="checkout"></floreo-buy-button>', `data-key="${key}"`,
    ':root { --floreo-accent: rgb(11, 110, 105); --floreo-accent-text: rgb(255, 255, 240); --floreo-radius: 2px; } floreo-buy-button::part(button) { text-transform: uppercase; }'),
  '/es.html': () => page('<floreo-products></floreo-products>', `data-key="${key}" data-lang="es"`),
  '/no-key.html': () => page('<floreo-products></floreo-products>'),
  '/wrong-key.html': () => page('<floreo-products></floreo-products>', 'data-key="pk_test_AAAAAAAAAAAAAAAAAAAAAAAA"'),
  '/secret-key.html': () => page('<floreo-products></floreo-products>', 'data-key="etd_abcdefghijkl_notARealSecretJustItsShape"'),
};

test.beforeAll(async ({ playwright }, info) => {
  floreo = String(info.project.use.baseURL);
  api = await playwright.request.newContext({ baseURL: floreo, extraHTTPHeaders: API });
  // A business of its own, in test mode; signing in instead when an earlier run already made it.
  const signup = await api.post('/v1/auth/signup', {
    data: {
      business: { legalName: 'Reef Goods Ltd', tradeName: 'Reef Goods', tin: '654321', address: { street: '12 Front Street', city: 'San Pedro', districtCode: '1' }, contact: { telephone: '501-226-0000', email: 'hello@reefgoods.test' } },
      owner: OWNER, sells: 'products',
    },
  });
  if (!signup.ok()) expect((await api.post('/v1/auth/login', { data: { business: SLUG, login: OWNER.email, password: OWNER.password } })).ok()).toBeTruthy();
  expect((await api.put('/v1/certificate', { data: { certificatePem: cert('signer-654321.cert.pem'), privateKeyPem: cert('signer-654321.key.pem') } })).ok()).toBeTruthy();
  const have = new Set(((await (await api.get('/v1/products')).json()).data as Array<{ handle: string }>).map((x) => x.handle));
  const products = [
    { title: 'Hot sauce trio', description: 'Three habanero sauces.\n\nMade in Belize.', status: 'active', variants: [{ price: '18.00', gstCategory: 'S', sellerCode: 'HOT-3' }] },
    { title: 'Island T-shirt', description: 'Soft cotton, printed in San Pedro.', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 50 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 3 }, { option1: 'L', price: '40.00', gstCategory: 'S', stock: 0 }] },
    { title: 'Reef-safe sunscreen', description: 'Mineral sunscreen, SPF 30.', status: 'active', variants: [{ price: '24.00', gstCategory: 'S' }] },
  ];
  for (const product of products) {
    if (!have.has(product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))) expect((await api.post('/v1/products', { data: product })).status()).toBe(201);
  }
  const settings = await api.put('/v1/store-settings', {
    data: {
      enabled: true, delivery: { enabled: true, zones: [{ name: 'San Pedro', fee: '8.00' }] }, pickup: { enabled: true, instructions: 'Ask at the counter' },
      payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank 000-111, Reef Goods Ltd' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: true, provider: 'test' } },
    },
  });
  expect(settings.ok(), await settings.text()).toBeTruthy();
  const made = await api.post('/v1/publishable-keys', { data: { name: `Browser test ${Date.now()}` } });
  expect(made.status(), await made.text()).toBe(201);
  key = (await made.json()).key;
  expect(key).toMatch(/^pk_test_/);

  // The outside site: its own server, so its own origin.
  site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    const make = PAGES[path];
    if (!make) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(make());
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await api?.dispose();
  await new Promise((resolve) => (site ? site.close(resolve) : resolve(null)));
});

const overlay = (p: Page) => p.locator('floreo-overlay dialog');
const order = async (number: string) => ((await (await api.get(`/v1/orders?view=all&q=${number}`)).json()).data as Array<{ number: number; paymentStatus: string; paymentMethod: string; documentId: string | null }>).find((o) => String(o.number) === number)!;

async function fillContact(p: Page, scope = p.locator('body')) {
  await scope.getByLabel('Full name').fill('Ana Buyer');
  await scope.getByLabel('Phone').fill('501-610-0000');
  await scope.getByLabel('Email').fill('ana@example.test');
}

test('a site built elsewhere: products, a product, the cart, the checkout, a test card, and back on the site paid', async ({ page: p }) => {
  const failed: string[] = [];
  p.on('console', (m) => m.type() === 'error' && failed.push(m.text()));
  await p.goto(siteUrl);

  // Two products a page, in the page's own font; more on asking.
  const grid = p.locator('floreo-products');
  await expect(grid.locator('.card')).toHaveCount(2);
  await expect(grid.locator('.card').first()).toContainText('Hot sauce trio');
  await expect(grid.locator('.card').first()).toContainText('BZ$20.25');
  expect(await grid.locator('.title').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Georgia');
  await grid.getByRole('button', { name: 'Show more' }).click();
  await expect(grid.locator('.card')).toHaveCount(3);
  await expect(grid.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // A product opens over the page: its sizes, what is left, sold out.
  await grid.locator('.card', { hasText: 'Island T-shirt' }).click();
  const dialog = overlay(p);
  await expect(dialog.getByRole('heading', { name: 'Island T-shirt' })).toBeVisible();
  await expect(dialog).toContainText('BZ$45.00');
  await dialog.getByLabel('Size').selectOption('L');
  await expect(dialog.getByRole('button', { name: 'Sold out' })).toBeDisabled();
  await dialog.getByLabel('Size').selectOption('M');
  await expect(dialog).toContainText('Only 3 left');
  await dialog.getByRole('button', { name: '+', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add to cart' }).click();

  // The cart: two of them, one more, one fewer.
  await expect(dialog.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  await expect(dialog).toContainText('Test mode');
  await expect(dialog).toContainText('BZ$90.00');
  await expect(p.locator('floreo-cart .count')).toHaveText('2');
  await dialog.getByRole('button', { name: '−', exact: true }).click();
  await expect(dialog).toContainText('BZ$45.00');
  await dialog.getByRole('button', { name: 'Check out' }).click();

  // The checkout: pickup, paid online with the test card.
  await expect(dialog.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await expect(dialog).toContainText('no money moves');
  await fillContact(p, dialog);
  await dialog.getByLabel('Pickup').check();
  await expect(dialog.locator('.summary .total')).toContainText('BZ$45.00');
  await dialog.getByLabel('Pay online now (test card)').check();
  await dialog.getByRole('button', { name: 'Place order' }).click();

  // On the platform's pretend card page, then back on the site.
  await p.waitForURL(new RegExp(`${SLUG}/shop/pay/`));
  await p.getByRole('button', { name: /^Pay BZ\$45\.00/ }).click();
  await p.waitForURL((url) => url.origin === siteUrl);
  await expect(dialog).toContainText('Thank you, Ana');
  await expect(dialog.locator('.badge.ok')).toHaveText('Paid');
  expect(new URL(p.url()).search).toBe('');
  const number = /Order #(\d+)/.exec(await dialog.innerText())![1]!;
  await expect(dialog.getByRole('link', { name: 'Download your receipt (PDF)' })).toHaveAttribute('href', new RegExp(`/v1/store/${SLUG}/orders/${number}/document\\?t=`));
  await expect(dialog.getByRole('link', { name: 'See your order' })).toHaveAttribute('href', new RegExp(`^${floreo}/${SLUG}/shop/orders/${number}\\?t=`));
  await expect(p.locator('floreo-cart .count')).toHaveText('0');

  // In the business's own orders: paid online, with its BTS receipt.
  const placed = await order(number);
  expect(placed.paymentStatus).toBe('paid');
  expect(placed.paymentMethod).toBe('online');
  expect(placed.documentId).toBeTruthy();
  const receipt = await p.request.get((await dialog.getByRole('link', { name: 'Download your receipt (PDF)' }).getAttribute('href'))!);
  expect(receipt.headers()['content-type']).toContain('application/pdf');
  expect(failed).toEqual([]);
});

test('the site\'s own product and checkout pages: bank transfer, how to pay, and a cart that survives leaving', async ({ page: p }) => {
  await p.goto(`${siteUrl}/own-pages.html`);
  // Cards are links to the site's own product page.
  const card = p.locator('floreo-products a.card', { hasText: 'Reef-safe sunscreen' });
  await expect(card).toHaveAttribute('href', '/product.html?handle=reef-safe-sunscreen');
  await card.click();
  await expect(p.locator('floreo-product').getByRole('heading', { name: 'Reef-safe sunscreen' })).toBeVisible();
  await expect(p.locator('floreo-product')).toContainText('Mineral sunscreen, SPF 30.');
  await p.locator('floreo-product').getByRole('button', { name: 'Add to cart' }).click();

  // No cart button on this page: one appears, and the cart opens.
  await expect(p.locator('floreo-cart[floating] .count')).toHaveText('1');
  await overlay(p).getByRole('button', { name: 'Check out' }).click();
  await p.waitForURL(`${siteUrl}/checkout.html`);

  // Still in the cart on the checkout page, and after a reload.
  const checkout = p.locator('floreo-checkout');
  await expect(checkout.locator('.summary')).toContainText('1 × Reef-safe sunscreen');
  await p.reload();
  await expect(checkout.locator('.summary')).toContainText('1 × Reef-safe sunscreen');

  // Delivery adds its fee and asks for an address; a code that does not exist is said beside it.
  await expect(checkout.locator('.summary')).toContainText('Delivery to San Pedro');
  await expect(checkout.locator('.summary .total')).toContainText('BZ$36.00');
  await fillContact(p, checkout);
  await checkout.getByLabel('Street').fill('3 Coconut Drive');
  await checkout.getByLabel('Town or city').fill('San Pedro');
  await checkout.getByText('Have a discount code or gift card?').click();
  await checkout.getByLabel('Discount code').fill('NOPE');
  await checkout.getByRole('button', { name: 'Apply' }).first().click();
  await expect(checkout.locator('details')).toContainText(/code/i);
  await checkout.getByLabel('Bank transfer').check();
  await checkout.getByRole('button', { name: 'Place order' }).click();

  // The order, on the site: how to pay, and a way to its own page.
  await expect(checkout).toContainText('Thank you, Ana');
  await expect(checkout).toContainText('Waiting for payment');
  await expect(checkout).toContainText('Belize Bank 000-111, Reef Goods Ltd');
  const number = /Order #(\d+)/.exec(await checkout.locator('.row', { hasText: 'Order #' }).innerText())![1]!;
  await expect(checkout).toContainText(`Use order #${number} as the reference.`);
  const placed = await order(number);
  expect(placed.paymentMethod).toBe('bank_transfer');
  expect(placed.paymentStatus).toBe('unpaid');
});

test('buy buttons in the site\'s colours; a declined card can be tried again', async ({ page: p }) => {
  await p.goto(`${siteUrl}/button.html`);
  const hot = p.locator('floreo-buy-button').first().getByRole('button');
  await expect(hot).toHaveText('Buy the hot sauce');
  // The page's CSS variables and ::part reach inside.
  expect(await hot.evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderRadius, s.textTransform]; })).toEqual(['rgb(11, 110, 105)', 'rgb(255, 255, 240)', '2px', 'uppercase']);
  await hot.click();
  const dialog = overlay(p);
  await expect(dialog).toContainText('Hot sauce trio');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // "Buy now" on a product with sizes asks which one first.
  await p.locator('floreo-buy-button').nth(1).getByRole('button', { name: 'Buy now' }).click();
  await expect(dialog.getByLabel('Size')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to cart' }).click();
  await dialog.getByRole('button', { name: 'Check out' }).click();
  await fillContact(p, dialog);
  await dialog.getByLabel('Pickup').check();
  await dialog.getByLabel('Pay online now (test card)').check();
  await expect(dialog.locator('.summary .total')).toContainText('BZ$65.25');
  await dialog.getByRole('button', { name: 'Place order' }).click();

  // Declined: back on the site with the reason and a way to try again; the second time it goes through.
  await p.waitForURL(new RegExp(`${SLUG}/shop/pay/`));
  await p.getByRole('button', { name: 'Decline' }).click();
  await p.waitForURL((url) => url.origin === siteUrl);
  await expect(dialog).toContainText('The payment did not go through.');
  await expect(dialog).toContainText('Waiting for payment');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await p.waitForURL(new RegExp(`${SLUG}/shop/pay/`));
  await p.getByRole('button', { name: /^Pay BZ\$65\.25/ }).click();
  await p.waitForURL((url) => url.origin === siteUrl);
  await expect(dialog.locator('.badge.ok')).toHaveText('Paid');
});

test('in Spanish when the page asks for it', async ({ page: p }) => {
  await p.goto(`${siteUrl}/es.html`);
  await p.locator('floreo-products .card', { hasText: 'Island T-shirt' }).click();
  const dialog = overlay(p);
  await dialog.getByRole('button', { name: 'Añadir al carrito' }).click();
  await expect(dialog.getByRole('heading', { name: 'Tu carrito' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pagar' }).click();
  await expect(dialog.getByLabel('Nombre completo')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Hacer pedido' })).toBeVisible();
  await expect(dialog).toContainText('Modo de prueba');
});

test('set up wrong: the page says what is missing, and what the store answered', async ({ page: p }) => {
  await p.goto(`${siteUrl}/no-key.html`);
  await expect(p.locator('floreo-products')).toContainText('the script tag needs data-key="pk_…"');
  await p.goto(`${siteUrl}/secret-key.html`);
  await expect(p.locator('floreo-products')).toContainText('Never put a secret key (etd_…) in a page');
  await p.goto(`${siteUrl}/wrong-key.html`);
  await expect(p.locator('floreo-products')).toContainText(`This publishable key is not one of the store "${SLUG}"`);
});
