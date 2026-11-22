/** The app on a phone: no sideways scrolling, menu works, counter usable. Runs after app.spec.ts set up the business. */

import { expect, test } from '@playwright/test';

test('phone layout: every page fits the screen and the menu opens', async ({ page }) => {
  await page.goto('/corner-store/login');
  await page.getByLabel('Email or username').fill('rosa@cornerstore.test');
  await page.getByLabel(/^Password/).fill('my brand new password');
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');

  for (const path of ['/', '/counter', '/documents', '/documents/new?type=01', '/orders', '/products', '/customers', '/reports', '/settings', '/shop', '/shop/products/reef-hoodie', '/shop/checkout']) {
    await page.goto(`/corner-store${path === '/' ? '' : path}`);
    await expect(page.locator('h1')).toBeVisible();
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(width);
  }

  await page.goto('/corner-store');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Counter' }).click();
  await expect(page).toHaveURL(/\/counter$/);
  await page.getByRole('group', { name: 'Quick buttons' }).getByRole('button', { name: /Coconut water/ }).click();
  await expect(page.locator('.cart .grand')).toContainText('BZ$3.94');
});
