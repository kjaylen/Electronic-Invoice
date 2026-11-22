/**
 * The web app end to end, in a real browser, against the demo server
 * (stand-in BTS, emails written to .demo-e2e/outbox).
 *
 * One business is set up in the first test and used by the rest, in order.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTBOX = `${root}.demo-e2e/outbox`;
const OWNER = { name: 'Rosa Owner', email: 'rosa@cornerstore.test', password: 'a long test password' };
const BUSINESS = 'Corner Store Ltd.';
const SLUG = 'corner-store';
/** A page of the business's own instance. */
const p = (path = '') => `/${SLUG}${path === '/' ? '' : path}`;

/** The newest email to `to` (decoded from quoted-printable), waiting for it to arrive. */
async function emailTo(to: string, after: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(OUTBOX)) {
      const files = readdirSync(OUTBOX).filter((f) => f.endsWith('.eml') && f.includes(to)).sort().reverse();
      for (const f of files) {
        const raw = readFileSync(`${OUTBOX}/${f}`, 'utf8');
        const stamp = Date.parse(f.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
        if (stamp >= after - 1000) return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no email to ${to}`);
}

async function logIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto(p('/login'));
  await page.getByLabel('Email or username').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Corner Store/);
}

test('create the business and its owner, then install the certificate', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create a business' }).click();
  await page.getByLabel('Registered name').fill(BUSINESS);
  await page.getByLabel(/^Trade name/).fill('Corner Store');
  await expect(page.getByLabel(/^Business address/)).toHaveValue(SLUG); // suggested from the name
  await expect(page.getByText(`Available. Your team signs in at`)).toBeVisible();
  await page.getByLabel(/^TIN/).fill('123456');
  await page.getByLabel('Street').fill('12 Albert Street');
  await page.getByLabel('City or town').fill('Belize City');
  await page.getByLabel('Telephone').fill('+501 227 0000');
  await page.getByLabel('Billing email', { exact: true }).fill('office@cornerstore.test');
  await page.getByLabel('Your name').fill(OWNER.name);
  await page.getByLabel(/^Your email/).fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /Create business/ }).click();

  await expect(page).toHaveURL(new RegExp(`/${SLUG}/setup$`));
  await expect(page.getByRole('heading', { name: 'Install your BTS certificate' })).toBeVisible();
  await page.getByLabel(/^Certificate file/).setInputFiles(`${root}test/certs/signer-123456.pfx`);
  await page.getByLabel('Certificate password').fill('test-pfx-password');
  await page.getByRole('button', { name: 'Install certificate' }).click();

  await expect(page).toHaveURL(new RegExp(`/${SLUG}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Corner Store');
  await expect(page.getByText('Test environment')).toBeVisible();

  // The start page now goes straight to this business on this device.
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/${SLUG}$`));
});

test('catalog: add items, star them for the counter, edit one', async ({ page }) => {
  await logIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Items' }).click();
  for (const [name, code, barcode, price] of [['Coconut water', 'COCO', '7501000000017', '3.50'], ['Johnny cakes', 'JC', '', '1.25']] as const) {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel(/^Your code/).fill(code);
    if (barcode) await dialog.getByLabel(/^Barcode/).fill(barcode);
    await dialog.getByLabel(/^Price/).fill(price);
    await dialog.getByLabel('Show as a quick button at the counter').check();
    await dialog.getByRole('button', { name: 'Save item' }).click();
    await expect(page.getByRole('status').getByText(`${name} added`)).toBeVisible();
  }
  await page.getByRole('row', { name: /Johnny cakes/ }).getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog').getByLabel(/^Price/).fill('1.50');
  await page.getByRole('dialog').getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByRole('row', { name: /Johnny cakes/ })).toContainText('BZ$1.50');
});

test('counter: scan, quick button, quantity, cash and change, issue with F2', async ({ page }) => {
  await logIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Counter' }).click();
  const search = page.getByRole('combobox', { name: 'Add an item' });
  await expect(search).toBeFocused();
  await search.fill('7501000000017');
  await search.press('Enter');
  await expect(page.locator('.cart-lines li')).toHaveCount(1);
  await search.fill('2*jc');
  await search.press('Enter');
  await expect(page.locator('.cart-lines li')).toHaveCount(2);
  await search.press('+'); // one more Johnny cake: 3
  await page.getByRole('group', { name: 'Quick buttons' }).getByRole('button', { name: /Coconut water/ }).click(); // a second coconut water
  await expect(page.getByLabel('Quantity of Coconut water')).toHaveValue('2');
  await expect(page.getByLabel('Quantity of Johnny cakes')).toHaveValue('3');
  // 2 x 3.50 + 3 x 1.50 = 11.50; GST 1.44; total 12.94
  await expect(page.locator('.cart .grand')).toContainText('BZ$12.94');
  await page.getByLabel('Cash received').fill('20');
  await expect(page.locator('.tender')).toContainText('Change BZ$7.06');
  await page.keyboard.press('F2');
  const last = page.locator('.last-sale');
  await expect(last).toContainText('Authorized');
  await expect(last).toContainText('BZ$7.06');
  await expect(page.locator('.cart-lines li')).toHaveCount(0);
  await expect(search).toBeFocused();
});

test('invoice: new customer, draft survives a reload, issue, email it', async ({ page }) => {
  await logIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'New invoice' }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Placencia Dive Shop');
  await page.getByLabel('Street').fill('Main Road');
  await page.getByLabel('City or town').fill('Placencia');
  await page.getByLabel(/^Email/).fill('accounts@placenciadive.test');
  await page.getByPlaceholder(/Search your items/).fill('Tank refills');
  await page.getByLabel('Qty').fill('4');
  await page.getByLabel('Price (BZ$)').fill('25');
  await expect(page.locator('.totals .grand')).toContainText('BZ$112.50');

  await page.waitForTimeout(800); // the draft is saved half a second after typing stops
  await page.reload();
  await expect(page.getByText('Draft restored')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Placencia Dive Shop');

  await page.getByRole('button', { name: /Issue tax invoice/ }).click();
  await expect(page.getByText('Issued and authorized by BTS')).toBeVisible();
  await expect(page.getByRole('table').first()).toContainText('Tank refills');

  const sent = Date.now();
  await page.getByRole('button', { name: /^Email/ }).click();
  await expect(page.getByRole('dialog').getByLabel('To')).toHaveValue('accounts@placenciadive.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Emailed to accounts@placenciadive.test')).toBeVisible();
  const mail = await emailTo('accounts@placenciadive.test', sent);
  expect(mail).toMatch(/Subject: Tax Invoice 001-000000001 from Corner Store/);
  expect(mail).toMatch(/application\/pdf/);
  expect(mail).toMatch(/application\/xml/);

  // A new form starts empty again: the draft was cleared when the invoice was issued.
  await page.getByRole('navigation').getByRole('link', { name: 'New invoice' }).click();
  await expect(page.getByText('Draft restored')).toHaveCount(0);
});

test('documents: search, filter, and the overview totals', async ({ page }) => {
  await logIn(page);
  await expect(page.locator('.stat').nth(0)).toContainText('2');
  await page.getByRole('navigation').getByRole('link', { name: 'Documents' }).click();
  await page.getByLabel('Search').fill('placencia');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page).toHaveURL(/q=placencia/);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Type').selectOption('02');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Tax receipt');
});

test('reports: totals, GST by rate, CSV download', async ({ page }) => {
  await logIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Reports' }).click();
  // 12.94 + 112.50
  await expect(page.locator('.stat').first()).toContainText('BZ$125.44');
  await expect(page.getByRole('row', { name: /Standard rate/ })).toContainText('BZ$111.50');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'All documents (CSV)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^documents-.*\.csv$/);
});

test('users: the owner adds a cashier by email, who sets a password from the welcome link', async ({ page, browser }) => {
  await logIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'Add a user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Carlos Cashier');
  await dialog.getByLabel(/^Email/).fill('carlos@cornerstore.test');
  await dialog.getByRole('button', { name: 'Email them a link' }).click();
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog.getByText('Carlos Cashier can sign in now')).toBeVisible();
  const link = (await dialog.locator('.key-reveal').innerText()).trim();
  expect(link).toContain(`/${SLUG}/reset-password?token=`);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /Carlos Cashier/ })).toContainText('Cashier');

  const cashier = await (await browser.newContext()).newPage();
  await cashier.goto(link);
  await expect(cashier.getByRole('heading', { name: 'Welcome, Carlos Cashier' })).toBeVisible();
  await cashier.getByLabel(/^New password/).fill('cashier password 1');
  await cashier.getByLabel('Repeat the new password').fill('cashier password 1');
  await cashier.getByRole('button', { name: /Save and log in/ }).click();
  await expect(cashier.getByRole('heading', { level: 1 })).toHaveText('Corner Store');
  // A cashier sells but does not see reports, users or keys.
  await expect(cashier.getByRole('navigation').getByRole('link', { name: 'Counter' })).toBeVisible();
  await expect(cashier.getByRole('navigation').getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await cashier.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(cashier.getByRole('button', { name: 'Users' })).toHaveCount(0);
  await expect(cashier.getByRole('button', { name: 'API keys' })).toHaveCount(0);
  await cashier.goto(p('/reports'));
  await expect(cashier).toHaveURL(new RegExp(`/${SLUG}$`), { timeout: 5000 });

  // The owner deactivates them: they are signed out at once.
  await page.getByRole('row', { name: /Carlos Cashier/ }).getByRole('button', { name: 'Deactivate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('row', { name: /Carlos Cashier/ })).toContainText('Deactivated');
  await cashier.reload();
  await expect(cashier.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await cashier.getByLabel('Email or username').fill('carlos@cornerstore.test');
  await cashier.getByLabel(/^Password/).fill('cashier password 1');
  await cashier.getByRole('button', { name: /^Log in/ }).click();
  await expect(cashier.getByText('This account is deactivated')).toBeVisible();
});

test('users: a till account with a username and a temporary password, replaced at first sign-in', async ({ page, browser }) => {
  await logIn(page);
  await page.goto(p('/settings?tab=users'));
  await page.getByRole('button', { name: 'Add a user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Till One');
  await dialog.getByLabel(/^Username/).fill('till1');
  await dialog.getByLabel(/^Temporary password/).fill('temporary-till-1');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog.locator('.handover')).toContainText('till1');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const till = await (await browser.newContext()).newPage();
  await till.goto(p('/login'));
  await till.getByLabel('Email or username').fill('TILL1');
  await till.getByLabel(/^Password/).fill('temporary-till-1');
  await till.getByRole('button', { name: /^Log in/ }).click();
  await expect(till.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await till.getByLabel('Temporary password').fill('temporary-till-1');
  await till.getByLabel(/^New password/).fill('till one password');
  await till.getByLabel('Repeat the new password').fill('till one password');
  await till.getByRole('button', { name: /Save and continue/ }).click();
  await expect(till.getByRole('heading', { level: 1 })).toHaveText('Corner Store');

  // The activity log shows all of it.
  await page.goto(p('/settings?tab=activity'));
  const log = page.locator('ol.activity');
  await expect(log).toContainText('created an account for till1');
  await expect(log).toContainText('deactivated carlos@cornerstore.test');
  await expect(log).toContainText('changed their password');
});

test('forgot password: email link, new password, signed in', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(p('/login'));
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  const asked = Date.now();
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByRole('button', { name: /Email me a link/ }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  const mail = await emailTo(OWNER.email, asked);
  const link = new RegExp(`http://localhost:\\d+/${SLUG}/reset-password\\?token=[A-Za-z0-9_-]{43}`).exec(mail)?.[0];
  expect(link).toBeTruthy();

  await page.goto(link!);
  await page.getByLabel(/^New password/).fill('my brand new password');
  await page.getByLabel('Repeat the new password').fill('my brand new password');
  await page.getByRole('button', { name: /Save and log in/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Corner Store');
  OWNER.password = 'my brand new password';
});

test('Spanish: the whole interface switches, and the choice is remembered', async ({ page }) => {
  await logIn(page);
  await page.getByRole('button', { name: 'Change language' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Resumen' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Mostrador' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Informes' })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar idioma' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Reports' })).toBeVisible();
});

test('accessibility basics: skip link, one h1 per page, labelled controls, dialogs trap focus', async ({ page }) => {
  await logIn(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  for (const path of ['/', '/counter', '/documents', '/documents/new?type=01', '/customers', '/items', '/reports', '/settings']) {
    await page.goto(p(path));
    await expect(page.locator('h1')).toHaveCount(1);
    // Every visible form control has an accessible name.
    const unnamed = await page.locator('input:visible, select:visible, textarea:visible').evaluateAll((els) =>
      els.filter((el) => !(el as HTMLInputElement).labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unnamed, path).toEqual([]);
  }
  await page.goto(p('/customers'));
  await page.getByRole('button', { name: 'Add customer' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add customer' })).toBeFocused();
});

test('installable: manifest, icons and service worker are served', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  expect((await request.get('/sw.js')).headers()['content-type']).toMatch(/javascript/);
  await logIn(page);
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())), { timeout: 10_000 }).toBe(true);
});
