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

import { expect, type Page, test } from '@playwright/test';
import { type OutsideSite, serveSite, setUpStore, SLUG, type Store } from './outside-site.ts';

test.describe.configure({ mode: 'serial' });

let store: Store;
let site: OutsideSite;
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
  '/choices.html': () => page('<floreo-products id="picked" handles="reef-safe-sunscreen,hot-sauce-trio"></floreo-products><floreo-products id="found" search="sauce"></floreo-products><floreo-products id="beach" collection="for-the-beach" sort="title"></floreo-products><floreo-products id="sale" on-sale></floreo-products>', `data-key="${key}"`),
  '/script.html': () => page('<p id="heard"></p>', `data-key="${key}" data-cart="none"`),
  '/floating.html': () => page('<floreo-cart floating label="Basket"></floreo-cart>', `data-key="${key}"`),
  '/no-key.html': () => page('<floreo-products></floreo-products>'),
  '/wrong-key.html': () => page('<floreo-products></floreo-products>', 'data-key="pk_test_AAAAAAAAAAAAAAAAAAAAAAAA"'),
  '/secret-key.html': () => page('<floreo-products></floreo-products>', 'data-key="etd_abcdefghijkl_notARealSecretJustItsShape"'),
};

test.beforeAll(async ({ playwright }, info) => {
  floreo = String(info.project.use.baseURL);
  store = await setUpStore(playwright, floreo);
  key = store.key;
  site = await serveSite((path) => (PAGES[path] ? { body: PAGES[path]!(), type: 'text/html; charset=utf-8' } : undefined));
  siteUrl = site.url;
});

test.afterAll(async () => {
  await store?.api.dispose();
  await site?.close();
});

const order = (number: string) => store.order(number);
const overlay = (p: Page) => p.locator('floreo-overlay dialog');

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

test('which products a grid shows: chosen ones in order, a search, a collection, what is on sale', async ({ page: p }) => {
  await p.goto(`${siteUrl}/choices.html`);
  const titles = (id: string) => p.locator(`#${id} .title`);
  await expect(titles('picked')).toHaveText(['Reef-safe sunscreen', 'Hot sauce trio']);
  await expect(titles('found')).toHaveText(['Hot sauce trio']);
  await expect(titles('beach')).toHaveText(['Island T-shirt', 'Reef-safe sunscreen']);
  await expect(titles('sale')).toHaveText(['Reef-safe sunscreen']);
  // On sale: the price, what it was, and a mark.
  await expect(p.locator('#sale .card')).toContainText('BZ$27.00');
  await expect(p.locator('#sale .was')).toHaveText('BZ$36.00');
  await expect(p.locator('#sale .tag')).toHaveText('Sale');
});

test('window.Floreo for the page\'s own code: the cart, the store\'s API, events, and no cart button when asked', async ({ page: p }) => {
  await p.goto(`${siteUrl}/script.html`);
  await p.waitForFunction(() => Boolean((window as unknown as { Floreo?: unknown }).Floreo));
  const result = await p.evaluate(async () => {
    const Floreo = (window as unknown as { Floreo: any }).Floreo;
    const heard: string[] = [];
    const stop = Floreo.on('cart', (c: { count: number }) => heard.push(`cart ${c.count}`));
    const variant = await Floreo.cart.addProduct('hot-sauce-trio');
    await Floreo.cart.addProduct('island-t-shirt', undefined, 2);
    Floreo.cart.setQuantity(variant.id, 3);
    const cart = Floreo.cart.get();
    stop();
    Floreo.cart.remove(variant.id);
    const page = await Floreo.api.products({ limit: 1, sort: 'title' });
    const quote = await Floreo.api.quote({ lines: Floreo.cart.get().lines.map((l: { variantId: string; quantity: number }) => ({ variantId: l.variantId, quantity: l.quantity })), fulfillment: 'pickup' });
    let refused = '';
    try {
      await Floreo.api.product('no-such-product');
    } catch (e) {
      refused = `${(e as { code: string }).code} ${(e as { status: number }).status}`;
    }
    return { store: Floreo.store, test: Floreo.test, version: Floreo.version, heard, count: cart.count, subtotal: cart.subtotal, first: page.data[0].title, next: Boolean(page.nextCursor), total: quote.totals.total, refused };
  });
  expect(result).toEqual({ store: SLUG, test: true, version: '1', heard: ['cart 1', 'cart 3', 'cart 5'], count: 5, subtotal: '150.75', first: 'Hot sauce trio', next: true, total: '90.00', refused: 'not_found 404' });
  // data-cart="none": no cart button appears by itself; the page opens the checkout when it wants to.
  await expect(p.locator('floreo-cart')).toHaveCount(0);
  await p.evaluate(() => (window as unknown as { Floreo: any }).Floreo.checkout.open());
  await expect(p.locator('floreo-overlay dialog').getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await expect(p.locator('floreo-overlay dialog .summary')).toContainText('2 × Island T-shirt (S)');

  // A cart button fixed to the corner, with the page's own word on it; the cart is the same one.
  await p.goto(`${siteUrl}/floating.html`);
  const button = p.locator('floreo-cart').getByRole('button');
  await expect(button).toContainText('Basket');
  await expect(p.locator('floreo-cart .count')).toHaveText('2');
  expect(await p.locator('floreo-cart').evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
});
