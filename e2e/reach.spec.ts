/**
 * Reaching people the way they are reached in Belize: a payment reminder
 * written for WhatsApp, and the counter in Simplified Chinese for the many
 * shopkeepers who read it more easily than English.
 *
 * Runs after app.spec.ts, on the business it sets up.
 */

import { expect, type Page, test } from '@playwright/test';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };

async function logIn(page: Page) {
  await page.goto(`/${SLUG}/login`);
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

test('a payment reminder by WhatsApp: the number, the message with a link to the invoice, and the link that opens the chat', async ({ page }) => {
  await logIn(page);
  // An invoice on account for a customer with no phone on file.
  const name = `Wa Customer ${Date.now().toString().slice(-6)}`;
  const issued = await page.request.post('/v1/documents', { headers: API, data: {
    type: '01', customer: { name, tin: '654321', address: { street: '1 Sea Street', city: 'Dangriga', districtCode: '5' } },
    lines: [{ description: 'Boat hire', quantity: '1', unitCode: 'H87', unitPrice: '80.00', gstCategory: 'S' }], payment: { meansCode: '30', dueDate: '2099-12-31', terms: 'Net 30' },
  } });
  expect(issued.status(), await issued.text()).toBe(201);

  await page.goto(`/${SLUG}/receivables?tab=invoices`);
  const row = page.locator('tbody tr', { hasText: name });
  await row.getByRole('button', { name: `Remind ${name} by WhatsApp` }).click();
  const dialog = page.getByRole('dialog', { name: `Remind ${name} by WhatsApp` });
  // No number yet: one that cannot be a phone is refused, in words.
  await dialog.getByLabel('Their WhatsApp number').fill('12');
  await dialog.getByRole('button', { name: 'Write the message' }).click();
  await expect(dialog.getByText(/does not look like a phone number/)).toBeVisible();
  await dialog.getByLabel('Their WhatsApp number').fill('610-1234');
  await dialog.getByRole('button', { name: 'Write the message' }).click();
  const message = dialog.locator('.whatsapp-message');
  await expect(message).toContainText(`Hello ${name}, this is`);
  await expect(message).toContainText('for BZ$90.00 is due on');
  await expect(message).toContainText(/You can see it (and pay )?here: http/);
  await expect(dialog.getByText('To +5016101234')).toBeVisible();
  // The button is a plain link to WhatsApp with the same message; nothing is sent from here.
  const href = await dialog.getByRole('link', { name: 'Open WhatsApp' }).getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/5016101234\?text=Hello%20/);
  expect(decodeURIComponent(href!.split('?text=')[1]!)).toBe(await message.innerText());
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
});

test('the counter in Chinese: chosen under My account, kept for this person, and back to English', async ({ page }) => {
  await logIn(page);
  await page.goto(`/${SLUG}/settings`);
  const picker = page.getByRole('group', { name: 'Language' });
  await picker.getByRole('button', { name: '中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');

  await page.goto(`/${SLUG}/counter`);
  await expect(page.getByRole('heading', { level: 1, name: '柜台' })).toBeVisible();
  const search = page.getByRole('combobox', { name: '添加商品' });
  await search.fill('7501000000017');
  await search.press('Enter');
  await expect(page.locator('.cart')).toContainText('小计');
  await expect(page.locator('.cart .grand')).toContainText('合计');
  const pay = page.getByRole('group', { name: '付款方式' });
  for (const means of ['现金', '刷卡', '转账', '电子钱包']) await expect(pay.getByRole('button', { name: means, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^开收据/ })).toBeVisible();
  await page.getByRole('button', { name: '清空' }).click();
  // Still Chinese after a reload: it is this person's choice on this device.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '柜台' })).toBeVisible();

  // The top bar's switch goes back to English.
  await page.getByRole('button', { name: '更换语言' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Counter' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
