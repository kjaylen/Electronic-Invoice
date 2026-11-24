/**
 * Business tax and dates to remember: the owner sets a second kind of
 * receipt and a date of their own in Settings, sees the worksheet under
 * Reports, and what is coming up on the overview.
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

test('business tax: kinds and rates in Settings, the worksheet under Reports, and what is coming up on the overview', async ({ page }) => {
  await logIn(page);
  // From the defaults, whatever an earlier run saved.
  const reset = await page.request.put('/v1/tax-settings', { headers: API, data: { kinds: [{ name: 'Trade or business', rate: '1.75' }], gstReturn: true, businessTax: true, email: true, dates: [] } });
  expect(reset.status(), await reset.text()).toBe(200);

  // Settings: a second kind of receipt, and the trade licence five days from now.
  await page.goto(`/${SLUG}/settings?tab=business`);
  const card = page.locator('section#taxes');
  await expect(card.getByLabel('Kind of receipt')).toHaveValue('Trade or business');
  await expect(card.getByLabel('Rate (%)')).toHaveValue('1.75');
  await card.getByRole('button', { name: '+ Rents (3%)' }).click();
  await expect(card.getByLabel('Kind of receipt').nth(1)).toHaveValue('Rents');
  await card.getByLabel('Rate (%)').nth(1).fill('99');
  await expect(card.getByRole('button', { name: 'Save' })).toBeDisabled();
  await card.getByLabel('Rate (%)').nth(1).fill('3');
  await card.getByRole('button', { name: '+ Add a date' }).click();
  await card.getByLabel('What', { exact: true }).fill('Trade licence');
  const soon = new Date(Date.now() - 6 * 3600_000 + 5 * 86_400_000).toISOString().slice(0, 10);
  await card.getByLabel('Date', { exact: true }).fill(soon);
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. The business tax worksheet is under Reports.')).toBeVisible();
  const saved = await (await page.request.get('/v1/tax-settings', { headers: API })).json();
  expect(saved.kinds.map((k: { name: string; rate: string }) => [k.name, k.rate])).toEqual([['Trade or business', '1.75'], ['Rents', '3']]);
  expect(saved.dates.map((d: { name: string; repeats: string; date: string }) => [d.name, d.repeats, d.date])).toEqual([['Trade licence', 'yearly', soon]]);

  // Reports: the worksheet for this month, matching what the server works out.
  await page.goto(`/${SLUG}/reports?view=business-tax`);
  const month = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const sheet = await (await page.request.get(`/v1/reports/business-tax?from=${month.slice(0, 7)}-01&to=${month}`, { headers: API })).json();
  await expect(page.locator('.gst-result .gst-amount')).toContainText(Number(sheet.toPay.replace('-', '')).toLocaleString('en-US', { minimumFractionDigits: 2 }));
  const table = page.locator('table.business-tax');
  await expect(table.locator('tbody tr').first()).toContainText('Trade or business');
  await expect(table.locator('tbody tr').first()).toContainText('1.75%');
  await expect(table.locator('tbody tr').nth(1)).toContainText('Rents');
  await expect(table.locator('tbody tr').nth(1)).toContainText('No categories chosen yet');
  await expect(page.getByRole('link', { name: 'PDF' })).toHaveAttribute('href', /business-tax\.pdf\?from=/);
  const pdf = await page.request.get(`/v1/reports/business-tax.pdf?from=${month.slice(0, 7)}-01&to=${month}`, { headers: API });
  expect(pdf.headers()['content-type']).toContain('application/pdf');

  // The overview: the trade licence is coming up, in five days.
  await page.goto(`/${SLUG}/`);
  const coming = page.locator('.coming-up');
  await expect(coming.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  const licence = coming.locator('li', { hasText: 'Trade licence' });
  await expect(licence).toContainText('in 5 days');
  // The returns too, when the 15th is within the month ahead; each opens its worksheet for the month it covers.
  const due = (await (await page.request.get('/v1/reports/due-dates?days=30', { headers: API })).json()).data as Array<{ kind: string; period?: { from: string } }>;
  const tax = due.find((d) => d.kind === 'business-tax');
  if (tax) {
    await coming.getByRole('link', { name: /Business tax for/ }).click();
    await expect(page).toHaveURL(new RegExp(`view=business-tax&from=${tax.period!.from}`));
    await expect(page.locator('table.business-tax')).toBeVisible();
  }

  // Tidy up: no dates of this test's left for the others.
  await page.request.put('/v1/tax-settings', { headers: API, data: { kinds: [{ name: 'Trade or business', rate: '1.75' }], dates: [] } });
});
