/** The app on a phone: no sideways scrolling, menu works, counter usable. Runs after app.spec.ts set up the business. */

import { expect, test } from '@playwright/test';

test('phone layout: every page fits the screen and the menu opens', async ({ page }) => {
  await page.goto('/corner-store/login');
  await page.getByLabel('Email or username').fill('rosa@cornerstore.test');
  await page.getByLabel(/^Password/).fill('my brand new password');
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');

  for (const path of ['/', '/counter', '/documents', '/documents/new?type=01', '/orders', '/products', '/customers', '/reports', '/reports?view=profit', '/inventory', '/inventory?filter=orders', '/inventory/orders/new', '/inventory/receive', '/expenses?tab=suppliers', '/settings', '/site', '/shop', '/shop/products/reef-hoodie', '/shop/checkout']) {
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

test('phone: the site editor shows its settings or the preview, one at a time; the store header keeps its logo', async ({ page }) => {
  await page.goto('/corner-store/login');
  await page.getByLabel('Email or username').fill('rosa@cornerstore.test');
  await page.getByLabel(/^Password/).fill('my brand new password');
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');

  await page.goto('/corner-store/site');
  await expect(page.locator('.se-sections')).toBeVisible();
  const frame = page.locator('iframe[title="Preview of your store"]');
  await expect(frame).toBeHidden();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Preview' }).click();
  await expect(frame).toBeVisible();
  await expect(page.locator('.se-sections')).toBeHidden();
  // Tapping a section in the preview brings its settings up.
  const preview = page.frameLocator('iframe[title="Preview of your store"]');
  await preview.locator('.site-section h1').first().click();
  await expect(page.getByRole('button', { name: '← Sections' })).toBeVisible();
  await expect(frame).toBeHidden();
  // In the store's header the logo is not squeezed away by the buttons beside it.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Preview' }).click();
  const logo = preview.locator('.shop-header .site-logo');
  if (await logo.count()) expect((await logo.boundingBox())!.width).toBeGreaterThan(24);
  const [scroll, width] = await preview.locator('body').evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll).toBeLessThanOrEqual(width);
});
