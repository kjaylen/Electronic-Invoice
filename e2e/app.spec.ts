/**
 * The web app end to end, in a real browser, against the demo server
 * (stand-in BTS, emails written to .demo-e2e/outbox).
 *
 * One business is set up in the first test and used by the rest, in order.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTBOX = `${root}.demo-e2e/outbox`;
const OWNER = { name: 'Rosa Owner', email: 'rosa@cornerstore.test', password: 'a long test password' };
const BUSINESS = 'Corner Store Ltd.';
const SLUG = 'corner-store';
/** The current code for an authenticator secret (RFC 6238), as a phone app would show it. */
function totp(secretB32: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/\s/g, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

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
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

test('create the business and its owner, then install the certificate', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create a business' }).click();
  await page.getByLabel('Registered name').fill(BUSINESS);
  await page.getByLabel(/^Trade name/).fill('Corner Store');
  await expect(page.locator('.address-preview')).toContainText(`/${SLUG}`); // made from the name, not editable
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
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
  await expect(page.getByText('Test environment')).toBeVisible();

  // The start page now goes straight to this business on this device.
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/${SLUG}$`));
});

test('catalog: add items, star them for the counter, edit one', async ({ page }) => {
  await logIn(page);
  await page.goto(p('/products?tab=items'));
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
  await expect(page.locator('.kpi').filter({ hasText: 'Issued today' }).locator('.kpi-value')).toHaveText('2');
  await page.getByRole('navigation').getByRole('link', { name: 'Documents' }).click();
  await page.getByLabel('Search').fill('placencia');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page).toHaveURL(/q=placencia/);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  // The type menu: open it, pick an option (keyboard works too).
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Tax receipts' }).click();
  await expect(page.getByRole('combobox', { name: 'Type' })).toHaveText('Tax receipts');
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

test('counter: a line discount, hold and recall, and a payment split between card and cash', async ({ page }) => {
  await logIn(page);
  await page.goto(p('/counter'));
  const quick = page.getByRole('group', { name: 'Quick buttons' });
  await quick.getByRole('button', { name: /Coconut water/ }).click();
  await quick.getByRole('button', { name: /Coconut water/ }).click();
  // 10% off 2 x 3.50: 6.30, GST 0.79, total 7.09.
  await page.getByRole('button', { name: 'Discount on Coconut water' }).click();
  await page.getByRole('button', { name: '10%', exact: true }).click();
  await expect(page.locator('.cart-lines .line-discount')).toHaveText('10% off');
  await expect(page.locator('.cart .grand')).toContainText('BZ$7.09');

  // Hold it for later, then recall it.
  await page.locator('.counter-actions').getByRole('button', { name: 'Hold sale' }).click();
  await page.getByRole('dialog').getByLabel('Name it (optional)').fill('Table 4');
  await page.getByRole('dialog').getByRole('button', { name: 'Hold sale' }).click();
  await expect(page.locator('.cart-lines li')).toHaveCount(0);
  await page.locator('.counter-actions').getByRole('button', { name: /Held sales/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Table 4');
  await page.getByRole('dialog').getByRole('button', { name: 'Recall' }).click();
  await expect(page.locator('.cart .grand')).toContainText('BZ$7.09');

  // BZ$5 by card, the rest in cash.
  await page.locator('.cart').getByRole('button', { name: 'Split' }).click();
  await page.getByLabel('Amount by card or transfer').fill('5');
  await expect(page.locator('.tender.split')).toContainText('Cash: BZ$2.09');
  await page.getByLabel('Cash received').fill('5');
  await expect(page.locator('.tender:not(.split)')).toContainText('Change BZ$2.91');
  await page.keyboard.press('F2');
  await expect(page.locator('.last-sale')).toContainText('Authorized');
  await expect(page.locator('.last-sale')).toContainText('BZ$2.91');
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
  await expect(cashier.locator('.biz-card')).toContainText('Corner Store');
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
  await expect(till.locator('.biz-card')).toContainText('Corner Store');

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
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
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
  for (const path of ['/', '/counter', '/documents', '/documents/new?type=01', '/orders', '/products', '/customers', '/items', '/reports', '/settings']) {
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

test('templates: edit an email with a live preview, a mistake shown on its line, save, a logo on the receipt, back to the default', async ({ page }) => {
  await logIn(page);
  await page.goto(p('/templates'));
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
  const rail = page.locator('.tpl-rail');
  await rail.getByRole('button', { name: 'Document email' }).click();
  await expect(page.frameLocator('.tpl-mail-body').getByText(/Please find attached tax invoice/)).toBeVisible();

  // The subject is Liquid too, and the preview follows it.
  await page.getByLabel('Subject').fill('Your {{ document.type_name }} from {{ business.name }}');
  // business.name is the trading name (Corner Store) when there is one.
  await expect(page.locator('.tpl-mail-subject')).toHaveText('Your Tax Invoice from Corner Store');

  // A mistake is marked on its line and pauses the preview; fixing it clears both.
  await page.getByRole('textbox', { name: 'Template code' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n{{ customer.name | shout }}');
  await expect(page.locator('.tpl-problems.bad')).toContainText('shout');
  await expect(page.locator('.tpl-stale')).toBeVisible();
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.tpl-problems.ok')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tpl-title .badge')).toHaveText('Customized');
  await expect(rail.getByRole('button', { name: 'Document email' }).locator('.tpl-dot')).toBeVisible();

  // A logo: uploaded under Images, it is the logo at once, and the receipt shows it.
  await rail.getByRole('button', { name: 'Images' }).click();
  await page.locator('.tpl-images input[type=file]').setInputFiles(`${root}web/public/icon-192.png`);
  await expect(page.locator('.tpl-asset')).toHaveCount(1);
  await expect(page.locator('.tpl-asset-badge')).toHaveText('Logo');
  await rail.getByRole('button', { name: 'Receipt (80 mm roll)' }).click();
  await expect(page.frameLocator('.tpl-roll-frame').locator('img.logo')).toBeVisible();

  // Back to the default.
  await rail.getByRole('button', { name: 'Document email' }).click();
  await page.getByRole('button', { name: 'Use the default' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use the default' }).click();
  await expect(page.locator('.tpl-title .badge')).toHaveText('Default');
  await expect(page.locator('.tpl-mail-subject')).toHaveText(/^Tax Invoice 001-000000042 from /);
});

test('labels: price tags with barcodes for items, on an A4 sheet', async ({ page }) => {
  await logIn(page);
  await page.goto(p('/products?tab=items'));
  await page.getByRole('link', { name: 'Print labels' }).click();
  await expect(page.getByRole('heading', { name: 'Labels', level: 1 })).toBeVisible();
  const search = page.getByRole('combobox', { name: 'Add an item' });
  await search.fill('Coconut');
  await page.getByRole('option', { name: /Coconut water/ }).click();
  await page.getByLabel('Labels for Coconut water').fill('3');
  await expect(page.getByRole('button', { name: 'Print 3 labels' })).toBeEnabled();
  await expect(page.locator('.label-options')).toContainText('3 labels on 1 sheet');
  // 3.50 plus GST is 3.94; the barcode is drawn.
  const preview = page.frameLocator('.labels-frame');
  await expect(preview.locator('.label')).toHaveCount(3);
  await expect(preview.locator('.label').first()).toContainText('BZ$3.94');
  await expect(preview.locator('.label svg').first()).toBeVisible();
});

test('import: customers from a spreadsheet, checked row by row first', async ({ page }) => {
  await logIn(page);
  await page.goto(p('/customers'));
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'customers.csv', mimeType: 'text/csv',
    buffer: Buffer.from(['Name,TIN,Email,City', 'Caye Caulker Dive Shop,654987,dive@caye.example,Caye Caulker', 'No TIN Here,12,,'].join('\n')),
  });
  await expect(dialog.locator('.import-summary')).toContainText('1 new');
  await expect(dialog.locator('.import-summary')).toContainText('1 with problems');
  await expect(dialog).toContainText('TIN "12" is not 6 digits');
  await dialog.getByRole('button', { name: 'Import 1 row, skip the rest' }).click();
  await expect(page.getByRole('status').getByText('1 added, 0 updated.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Caye Caulker Dive Shop/ })).toContainText('654987');
  // The customer's own page.
  await page.getByRole('link', { name: 'Caye Caulker Dive Shop' }).click();
  await expect(page.getByRole('heading', { name: 'Caye Caulker Dive Shop', level: 1 })).toBeVisible();
  await expect(page.locator('.kpis')).toContainText('Bought this year');
  await expect(page.getByText('Nothing owed. All paid up.')).toBeVisible();
});

test('online store: a product with sizes and a photo, open the store, a buyer orders, paid becomes a BTS receipt', async ({ page, browser }) => {
  await logIn(page);
  // The product.
  await page.getByRole('navigation').getByRole('link', { name: 'Products' }).click();
  await page.getByRole('link', { name: 'Add product' }).click();
  await page.getByLabel('Title').fill('Reef Hoodie');
  await page.getByLabel(/^Description/).fill('Warm enough for a norther.');
  await page.getByLabel(/^Option name/).fill('Size');
  const rows = page.locator('.variant-row');
  await rows.nth(0).getByLabel('Size').fill('S');
  await rows.nth(0).getByLabel(/^Price/).fill('60');
  await rows.nth(0).getByLabel(/^Stock/).fill('3');
  await expect(rows.nth(0)).toContainText('Buyers pay BZ$67.50');
  await page.getByRole('button', { name: '+ Add variant' }).click();
  await rows.nth(1).getByLabel('Size').fill('M');
  await page.getByRole('button', { name: 'On sale' }).click();
  await page.getByRole('button', { name: 'Save product' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reef Hoodie');
  await page.locator('.photo-add input[type=file]').setInputFiles(`${root}web/public/icon-192.png`);
  await expect(page.locator('.photo-grid figure')).toHaveCount(1);

  // Open the store.
  await page.goto(p('/settings?tab=store'));
  await page.getByLabel(/^Bank details for buyers/).fill('Test Bank, account Corner Store, 111-222');
  await page.getByRole('button', { name: 'Open the store' }).click();
  await expect(page.getByRole('heading', { name: 'Your store is open' })).toBeVisible();

  // A buyer, on another device.
  const buyer = await (await browser.newContext()).newPage();
  await buyer.goto(p('/shop'));
  await expect(buyer.getByRole('heading', { level: 1 })).toHaveText('Corner Store');
  await buyer.getByRole('link', { name: /Reef Hoodie/ }).click();
  await expect(buyer.getByText('Only 3 left')).toBeVisible();
  await buyer.getByRole('button', { name: 'M', exact: true }).click();
  await buyer.getByRole('button', { name: /Add to cart/ }).click();
  await buyer.getByRole('button', { name: 'View cart' }).click();
  await expect(buyer.locator('.shop-cart li')).toHaveCount(1);
  await buyer.getByRole('button', { name: /Check out/ }).click();
  await buyer.getByLabel('Name', { exact: true }).fill('Bea Buyer');
  await buyer.getByLabel(/^Phone/).fill('+501 600 1234');
  await buyer.getByLabel(/^Email/).fill('bea@buyer.test');
  await buyer.getByRole('radio', { name: /Pickup/ }).check();
  await expect(buyer.locator('.summary .grand')).toContainText('BZ$67.50');
  await buyer.getByRole('button', { name: /Place order/ }).click();
  await expect(buyer.getByRole('heading', { name: 'Thank you, Bea' })).toBeVisible();
  await expect(buyer.locator('pre.instructions')).toContainText('Test Bank');
  const orderUrl = buyer.url();

  // The merchant confirms the transfer: that issues the receipt.
  await page.getByRole('navigation').getByRole('link', { name: 'Orders' }).click();
  await page.getByRole('row', { name: /Bea Buyer/ }).getByRole('link').click();
  const sent = Date.now();
  await page.getByRole('button', { name: /Mark paid and issue receipt/ }).click();
  await expect(page.getByText('Paid. The receipt was issued and emailed to bea@buyer.test.')).toBeVisible();
  await expect(page.locator('.banner.ok')).toContainText('Tax receipt');
  await page.getByRole('button', { name: 'Mark picked up' }).click();
  await expect(page.locator('.badges')).toContainText('Picked up');
  const mail = await emailTo('bea@buyer.test', sent);
  expect(mail).toMatch(/application\/pdf/);

  // The buyer's page now has the receipt.
  await buyer.goto(orderUrl);
  await expect(buyer.getByText('Your receipt')).toBeVisible();
  const pdf = await buyer.request.get(await buyer.getByRole('link', { name: /Download PDF/ }).getAttribute('href') as string);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
});

test('till: set a PIN, add a till and pair it from the link, sign in, open a shift, scan and sell, lock', async ({ page, browser }) => {
  await logIn(page);
  await page.goto(p('/settings?tab=account'));
  await page.getByRole('button', { name: 'Set a PIN' }).click();
  await page.getByLabel('New PIN').fill('4826');
  await page.getByLabel('PIN again').fill('4826');
  await page.getByRole('button', { name: 'Set PIN' }).click();
  await expect(page.getByText('Your PIN is set')).toBeVisible();

  await page.goto(p('/settings?tab=tills'));
  await page.getByRole('button', { name: 'Add a till' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('Front counter');
  await page.getByRole('button', { name: 'Add and get a pairing code' }).click();
  const code = (await page.locator('.pairing-code').textContent())!.trim();
  expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  await page.getByRole('button', { name: 'Done' }).click();

  // The till is another device: its own browser, opened from the pairing link.
  const device = await browser.newContext();
  const till = await device.newPage();
  await till.goto(`/pos?pair=${code}`);
  // With one person who has a PIN, the till goes straight to their PIN pad; otherwise they pick their name.
  await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible();
  if (await till.getByRole('heading', { name: 'Who is selling?' }).isVisible()) await till.getByRole('button', { name: 'Rosa Owner' }).click();
  await expect(till.getByText('Enter your PIN')).toBeVisible();
  for (const d of '4826') await till.keyboard.press(d);
  await till.keyboard.press('Enter');
  await expect(till.getByRole('button', { name: /Issue receipt/ })).toBeVisible();

  await till.getByRole('button', { name: 'Open shift' }).click();
  await till.getByLabel('Cash in the drawer to start (float)').fill('50');
  await till.getByRole('dialog').getByRole('button', { name: 'Open shift' }).click();
  await expect(till.locator('.shift-bar.open')).toContainText('Cash expected BZ$50.00');

  // Devices: no automatic printing in this browser; a barcode scanner typing anywhere is read as one code.
  await till.getByRole('button', { name: 'Devices', exact: true }).click();
  await till.getByLabel('Print each receipt automatically').uncheck();
  await till.locator('h1').click();
  await till.keyboard.type('7501000000017', { delay: 5 });
  await till.keyboard.press('Enter');
  await expect(till.locator('.scan-test')).toContainText('7501000000017');

  // Selling: a scan with the focus anywhere adds the item.
  await till.getByRole('button', { name: 'Sell', exact: true }).click();
  await expect(till.getByRole('combobox', { name: 'Add an item' })).toBeFocused();
  await till.locator('.till-where').click();
  await till.keyboard.type('7501000000017', { delay: 5 });
  await till.keyboard.press('Enter');
  await expect(till.locator('.cart-lines li')).toHaveCount(1);
  await expect(till.locator('.cart .grand')).toContainText('BZ$3.94');
  await till.getByLabel('Cash received').fill('5');
  await till.getByRole('button', { name: /Issue receipt/ }).click();
  await expect(till.locator('.last-sale')).toContainText('Authorized');
  await expect(till.locator('.shift-bar.open')).toContainText('Cash expected BZ$53.94');

  await till.getByRole('button', { name: 'Sales', exact: true }).click();
  await expect(till.locator('.sale-list li').first()).toContainText('BZ$3.94');

  // The web app shows the till, its shift and who is on it.
  await page.reload();
  await expect(page.locator('.till-admin-list')).toContainText('Front counter');
  await expect(page.locator('.till-admin-list')).toContainText('Signed in: Rosa Owner');

  await till.getByRole('button', { name: 'Lock' }).click();
  await expect(till.getByRole('heading', { name: /Who is selling\?|Rosa Owner/ })).toBeVisible();
  await device.close();
});

test('platform console: staff move the business to BTS production', async ({ page, browser }) => {
  const staff = readFileSync(`${root}.demo-e2e/platform-admin.txt`, 'utf8');
  const email = /Email: (\S+)/.exec(staff)![1]!;
  const password = /Password: (\S+)/.exec(staff)![1]!;
  const staffPage = await (await browser.newContext()).newPage();
  await staffPage.goto('/admin');
  await staffPage.getByLabel('Email').fill(email);
  await staffPage.getByLabel('Password').fill(password);
  await staffPage.getByRole('button', { name: /Sign in/ }).click();
  // Staff always use two-step sign-in: the first sign-in sets up the authenticator app.
  await expect(staffPage.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  const secret = (await staffPage.locator('.secret-key').textContent())!;
  await staffPage.getByLabel(/Enter the 6-digit code/).fill(totp(secret));
  await staffPage.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(staffPage.locator('.recovery-codes li')).toHaveCount(10);
  const download = staffPage.waitForEvent('download');
  await staffPage.getByRole('button', { name: 'Download' }).click();
  await download;
  await staffPage.getByRole('button', { name: 'I saved them' }).click();
  await staffPage.getByRole('link', { name: 'Corner Store' }).click();
  await expect(staffPage.locator('ul.checks li.ok')).toHaveCount(3);
  await staffPage.getByRole('button', { name: /Move to production/ }).click();
  const dialog = staffPage.getByRole('dialog');
  await dialog.getByLabel(/^BTS approval reference/).fill('BTS-TEST-0042');
  await dialog.getByLabel(/^Type the TIN to confirm/).fill('111111');
  await dialog.getByRole('button', { name: 'Move to production' }).click();
  await expect(dialog.getByText('The TIN does not match this business.')).toBeVisible();
  await dialog.getByLabel(/^Type the TIN to confirm/).fill('123456');
  await dialog.getByRole('button', { name: 'Move to production' }).click();
  await expect(staffPage.getByRole('heading', { name: /In production since/ })).toBeVisible();
  await expect(staffPage.locator('ol.activity')).toContainText('Moved to production');

  // The business sees it: its sidebar says Production, and its activity log says so.
  await logIn(page);
  await expect(page.locator('.biz-card')).toContainText('Production');
  await expect(page.locator('.biz-card .badge.test')).toHaveCount(0);
  await page.goto(p('/settings?tab=activity'));
  await expect(page.locator('ol.activity')).toContainText('moved this business to BTS production');
});
