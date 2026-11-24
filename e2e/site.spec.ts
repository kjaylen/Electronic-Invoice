/**
 * The site builder, in a real browser: work is never lost (saved on leaving,
 * retried, kept on the device, never overwritten by someone else unnoticed),
 * and the editing a store owner does day to day.
 *
 * Runs after app.spec.ts, on the business it sets up (whose owner has reset
 * her password by then, and has published a site with an "About us" page).
 */

import { expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const p = (path = '') => `/${SLUG}${path === '/' ? '' : path}`;
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };

async function logIn(page: Page) {
  await page.goto(p('/login'));
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

async function openSite(page: Page) {
  await page.goto(p('/site'));
  await expect(page.locator('.se-sections')).toBeVisible();
  return page.frameLocator('iframe[title="Preview of your store"]');
}

const openBanner = (page: Page) => page.locator('.se-sections').getByRole('button', { name: /^Banner/ }).first().click();
const saved = (page: Page) => expect(page.locator('.se-status')).not.toHaveText(/Saving|Not saved/);
const draftOf = async (page: Page) => (await (await page.request.get('/v1/store-site', { headers: API })).json()).draft;

test('site builder: a change made just before leaving the editor is saved', async ({ page }) => {
  await logIn(page);
  await openSite(page);
  await openBanner(page);
  const text = `Leaving at ${Date.now()}`;
  await page.getByLabel('Headline').fill(text);
  // Straight to another page, sooner than the editor saves by itself.
  await page.getByRole('navigation').getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rosa');
  const preview = await openSite(page);
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText(text);
});

test('site builder: a save that fails is said, retried, and the work is kept on the device', async ({ page }) => {
  await logIn(page);
  await openSite(page);
  page.on('dialog', (d) => void d.accept());
  await openBanner(page);

  // The connection drops: the editor says so and keeps trying.
  await page.route('**/v1/store-site/draft', (route) => route.abort());
  await page.getByLabel('Headline').fill('Typed while offline');
  await expect(page.getByText('Your last changes are not saved yet')).toBeVisible();
  await expect(page.locator('.se-status')).toHaveText('Not saved');
  await page.unroute('**/v1/store-site/draft');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Your last changes are not saved yet')).toBeHidden();
  await saved(page);

  // The tab is closed before a change could be saved: it is offered back next time.
  await page.route('**/v1/store-site/draft', (route) => route.abort());
  await page.getByLabel('Headline').fill('Never reached the server');
  await expect(page.locator('.se-status')).toHaveText('Not saved');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('etd.site.unsaved.corner-store') ?? '')).toContain('Never reached the server');
  // Opening the editor again (here in a second tab, as after a crash): the server has the older text, the device the newer.
  const again = await page.context().newPage();
  const preview = await openSite(again);
  await expect(again.getByText('You have changes that were never saved')).toBeVisible();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Typed while offline');
  await again.getByRole('button', { name: 'Bring them back' }).click();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Never reached the server');
  await saved(again);
  await page.close();
  await again.reload();
  await expect(again.locator('.se-sections')).toBeVisible();
  await expect(again.getByText('You have changes that were never saved')).toBeHidden();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Never reached the server');
});

test('site builder: someone else changes the site meanwhile; nothing is overwritten without a choice', async ({ page }) => {
  await logIn(page);
  const preview = await openSite(page);
  await openBanner(page);
  await page.getByLabel('Headline').fill('Mine');
  await saved(page);

  // Another tab saves its own version.
  const theirs = await draftOf(page);
  theirs.home.sections.find((s: { type: string }) => s.type === 'hero').settings.heading = 'Theirs';
  expect((await page.request.put('/v1/store-site/draft', { headers: API, data: { site: theirs } })).ok()).toBe(true);

  await page.getByLabel('Headline').fill('Mine, again');
  await expect(page.getByText('changed the site while you were editing')).toBeVisible();
  expect((await draftOf(page)).home.sections[0].settings.heading).toBe('Theirs');
  await page.getByRole('button', { name: 'Load their version' }).click();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Theirs');

  await expect(page.getByLabel('Headline')).toHaveValue('Theirs');

  // And the other way: keeping mine replaces theirs.
  await page.getByLabel('Headline').fill('Mine once more');
  await saved(page);
  theirs.home.sections.find((s: { type: string }) => s.type === 'hero').settings.heading = 'Theirs again';
  await page.request.put('/v1/store-site/draft', { headers: API, data: { site: theirs } });
  await page.getByLabel('Headline').fill('Mine wins');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await saved(page);
  expect((await draftOf(page)).home.sections[0].settings.heading).toBe('Mine wins');
});

test('site builder: undo and redo; a page address typed with hyphens, never the same as another page', async ({ page }) => {
  await logIn(page);
  const preview = await openSite(page);
  page.on('dialog', (d) => void d.accept());
  await openBanner(page);
  const before = await page.getByLabel('Headline').inputValue();
  await page.getByLabel('Headline').fill('To be undone');
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('To be undone');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText(before);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(preview.getByRole('heading', { level: 1 })).toHaveText('To be undone');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: '← Sections' }).click();

  // A new page; its address is typed freely, hyphens and all.
  const title = `Visit ${Date.now()}`;
  await page.getByRole('button', { name: '+ New page' }).click();
  await page.getByLabel('Page title').fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText('Page settings').click();
  const address = page.getByLabel('Address');
  const slug = `find-us-${Date.now()}`;
  await address.fill('');
  await address.pressSequentially(slug);
  await address.blur();
  await expect(address).toHaveValue(slug);
  // The address another page has is not taken from it.
  await address.fill('about-us');
  await address.blur();
  await expect(address).toHaveValue('about-us-2');
  await saved(page);
  const pages = (await draftOf(page)).pages as Array<{ slug: string; title: string }>;
  expect(pages.find((x) => x.title === title)?.slug).toBe('about-us-2');
  expect(pages.filter((x) => x.slug === 'about-us')).toHaveLength(1);
  // Deleting it again.
  await page.getByRole('button', { name: 'Delete this page' }).click();
  await saved(page);
  expect(((await draftOf(page)).pages as Array<{ title: string }>).some((x) => x.title === title)).toBe(false);
});
