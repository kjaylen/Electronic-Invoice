/**
 * An owner deletes the business from Settings, asked in the app's own
 * dialogs: it is closed at once, a cashier can no longer sign in, the store
 * is shut; the owner sees when it will be erased, and reopens it.
 *
 * Runs after app.spec.ts on the business it sets up, and leaves it open.
 */

import { expect, type Page, test } from '@playwright/test';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const p = (path = '') => `/${SLUG}${path}`;

async function logIn(page: Page) {
  await page.goto(p('/login'));
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
}

test('an owner deletes the business: closed at once, erased in 30 days unless reopened; then reopens it', async ({ page, browser }) => {
  await logIn(page);
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
  try {
    await page.goto(p('/settings?tab=business'));
    await page.getByRole('button', { name: 'Delete this business…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Corner Store?' });
    await expect(dialog).toContainText('an owner can sign in, download its records and reopen it');
    // Nothing happens without the name and the password.
    const go = dialog.getByRole('button', { name: 'Delete this business' });
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Type the name of the business to go ahead').fill('corner store');
    await dialog.getByLabel('Your password').fill('not my password');
    await go.click();
    await expect(dialog.getByRole('alert')).toContainText('Your current password is incorrect');
    await dialog.getByLabel('Your password').fill(OWNER.password);
    await go.click();

    // Closed: the owner sees when it will be erased, and nothing of the app.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Corner Store is closed');
    await expect(page.getByText(/It will be erased for good on /)).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.goto(p('/documents'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Corner Store is closed');
    // Records can still be taken away.
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'All documents (CSV)' }).first().click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);

    // Buyers find the store shut.
    const buyer = await (await browser.newContext()).newPage();
    await buyer.goto(p('/shop'));
    await expect(buyer.getByRole('heading', { level: 1 })).toHaveText('This store is not open yet');
    await buyer.close();

    // Reopened, after the app's own "are you sure?".
    await page.getByRole('button', { name: 'Reopen the business' }).click();
    await page.getByRole('dialog', { name: 'Reopen Corner Store?' }).getByRole('button', { name: 'Reopen the business' }).click();
    await expect(page.getByText('Corner Store is open again')).toBeVisible();
    await expect(page.locator('.biz-card')).toContainText('Corner Store');
  } finally {
    // Whatever happened above, the business is left open for the tests that follow.
    await page.request.post('/v1/business/reopen', { headers: API, data: {} });
  }
  const shop = await page.request.get(`/v1/store/${SLUG}`);
  expect(shop.ok()).toBe(true);
});
