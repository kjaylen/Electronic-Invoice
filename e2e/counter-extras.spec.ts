/**
 * What a counter does for shops that sell to visitors and for bars and
 * restaurants: totals in US dollars too, a mobile wallet as a way to pay, a
 * service charge added with one tap, a tip on a card or wallet payment, and
 * all of it in the shift report.
 *
 * Runs after app.spec.ts, on the business it sets up (and its catalog).
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

test('counter: US$ total, service charge, a wallet payment with a tip, and the shift report', async ({ page }) => {
  await logIn(page);
  // From nothing, whatever an earlier run left; and a shift of this test's own.
  await page.request.put('/v1/counter-settings', { headers: API, data: { showUsd: false, serviceChargePercent: null, tips: false } });
  const open = await page.request.get('/v1/shifts/current', { headers: API });
  if (open.ok() && (await open.json()).shift) {
    const current = await open.json();
    await page.request.post(`/v1/shifts/${current.shift.id}/close`, { headers: API, data: { countedCash: current.report.cash.expected } });
  }
  expect((await page.request.post('/v1/shifts', { headers: API, data: { openingFloat: '20.00' } })).status()).toBe(201);

  // The owner turns the three on.
  await page.goto(`/${SLUG}/settings?tab=tills`);
  await page.getByLabel(/Show totals in US dollars too/).check();
  await page.getByLabel('Service charge (%)').fill('45');
  await expect(page.getByText('Up to 30, or empty')).toBeVisible();
  await page.getByLabel('Service charge (%)').fill('10');
  await page.getByLabel(/Take tips with card and wallet payments/).check();
  await page.locator('form.counter-extras').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Counter settings saved.')).toBeVisible();

  // At the counter: 2 coconut waters at 3.50 = 7.00; GST 0.88; total 7.88 = US$3.94.
  await page.getByRole('navigation').getByRole('link', { name: 'Counter' }).click();
  const search = page.getByRole('combobox', { name: 'Add an item' });
  await search.fill('2*7501000000017');
  await search.press('Enter');
  await expect(page.locator('.cart .grand')).toContainText('BZ$7.88');
  await expect(page.locator('.cart .grand-usd')).toContainText('US$3.94');

  // The service charge: one tap. 7.00 + 0.70 = 7.70; GST 0.96; total 8.66 = US$4.33.
  await page.getByRole('button', { name: 'Add the service charge (10%)' }).click();
  await expect(page.locator('.cart .cart-service')).toContainText('BZ$0.70');
  await expect(page.locator('.cart .grand')).toContainText('BZ$8.66');
  await expect(page.locator('.cart .grand-usd')).toContainText('US$4.33');
  await expect(page.getByRole('button', { name: 'Service charge 10%: on (remove)' })).toBeVisible();

  // Paid by wallet, with the confirmation number and a tip.
  await page.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'Wallet' }).click();
  await page.getByLabel('Wallet reference (optional)').fill('DW-48213');
  await page.getByLabel('Tip (optional)').fill('1.34');
  await expect(page.locator('.tender.wallet').last()).toContainText('Charge BZ$10.00 in all');
  await page.keyboard.press('F2');
  const last = page.locator('.last-sale');
  await expect(last).toContainText('Authorized');
  await expect(last).toContainText('BZ$8.66');

  // The receipt carries the charge and the wallet; nothing of the tip.
  const docs = await (await page.request.get('/v1/documents?limit=1', { headers: API })).json();
  const doc = docs.data[0];
  expect(doc.totals.payable).toBe('8.66');
  const xml = await (await page.request.get(`/v1/documents/${doc.id}/xml`, { headers: API })).text();
  expect(xml).toContain('<cbc:AllowanceChargeReason>Service charge 10%</cbc:AllowanceChargeReason>');
  expect(xml).toContain('<cbc:PaymentMeansCode>68</cbc:PaymentMeansCode>');
  expect(xml).toContain('Paid by mobile wallet (ref DW-48213)');
  expect(xml).not.toContain('1.34');

  // The shift: the sale is wallet takings; the service charge and the tip are what is held for the staff.
  await page.goto(`/${SLUG}/shifts`);
  await expect(page.getByText('Mobile wallet')).toBeVisible();
  await expect(page.getByText(/Service charge \(1 sales, before GST\)/)).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Service charge (1 sales' })).toContainText('BZ$0.70');
  await expect(page.locator('tr', { hasText: 'Tips for the staff (1)' })).toContainText('BZ$1.34');

  // Back to how the other tests expect the counter.
  await page.request.put('/v1/counter-settings', { headers: API, data: { showUsd: false, serviceChargePercent: null, tips: false } });
  const current = await (await page.request.get('/v1/shifts/current', { headers: API })).json();
  await page.request.post(`/v1/shifts/${current.shift.id}/close`, { headers: API, data: { countedCash: current.report.cash.expected } });
});
