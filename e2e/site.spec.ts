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

test('site builder: a ready-made site in one click (and undone in one), a page from a template', async ({ page }) => {
  await logIn(page);
  const preview = await openSite(page);
  page.on('dialog', (d) => void d.accept());
  const before = await draftOf(page);

  await page.getByRole('button', { name: 'Start again from a ready-made site' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Food and drink/ }).click();
  await expect(page.getByText('Your new site is ready to edit.')).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Come by' })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Favourites' })).toBeVisible();
  await saved(page);
  const made = await draftOf(page);
  expect(made.theme.preset).toBe('market');
  // The page she made earlier is still hers; the starter's own pages came with it.
  expect(made.pages.map((x: { slug: string }) => x.slug)).toEqual(expect.arrayContaining(['about-us', 'about', 'contact', 'questions']));
  await preview.getByRole('link', { name: 'Contact' }).first().click();
  await expect(preview.getByRole('heading', { name: 'Write to us' })).toBeVisible();

  // One undo brings the old site back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await saved(page);
  expect((await draftOf(page)).home).toEqual(before.home);

  // A page from a template.
  await page.getByRole('combobox', { name: 'Page' }).selectOption('home');
  await expect(preview.getByRole('heading', { level: 1 })).not.toHaveText('This page is not available');
  await page.getByRole('button', { name: '+ New page' }).click();
  await page.getByLabel('Start from').selectOption({ label: 'Delivery and returns' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'Delivery and returns' })).toBeVisible();
  await expect(preview.getByText('If something arrives damaged')).toBeVisible();
  await page.getByText('Page settings').click();
  await expect(page.getByLabel('Address')).toHaveValue('delivery-and-returns');
  await page.getByRole('button', { name: 'Delete this page' }).click();
  await saved(page);
});

test('site builder: a photo straight from a phone is made smaller and uploads', async ({ page }) => {
  await logIn(page);
  await openSite(page);
  await openBanner(page);
  // A 3000 x 2250 photo of noise: several megabytes as a JPEG, more than the server takes.
  const photo = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2250;
    const g = canvas.getContext('2d')!;
    const data = g.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i++) data.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
    g.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.97));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  const buffer = Buffer.from(photo, 'base64');
  expect(buffer.length).toBeGreaterThan(2 * 1024 * 1024);
  await page.getByRole('button', { name: /^(Choose|Change) a|the picture$/ }).first().click();
  const name = `phone-${Date.now()}.jpg`;
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name, mimeType: 'image/jpeg', buffer });
  // It is chosen as the banner's picture, and what was stored is well under the limit.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.se-image-thumb img').first()).toBeVisible();
  const assets = (await (await page.request.get('/v1/templates/assets', { headers: API })).json()).data as Array<{ name: string; bytes: number }>;
  const stored = assets.find((a) => a.name === name);
  expect(stored).toBeTruthy();
  expect(stored!.bytes).toBeLessThan(2 * 1024 * 1024);
  // Tidy up: the banner goes back to having no picture.
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await saved(page);
});

test('site builder: type in the preview, add a section where you are, reuse a saved section on another page', async ({ page }) => {
  await logIn(page);
  const preview = await openSite(page);
  page.on('dialog', (d) => void d.accept());

  // Click the headline in the page itself and type: the form and the draft follow.
  const headline = preview.locator('section.site-hero h1 .site-editable');
  await headline.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Typed right on the page');
  await expect(page.getByLabel('Headline')).toHaveValue('Typed right on the page');
  await page.keyboard.press('Enter');
  await saved(page);
  expect((await draftOf(page)).home.sections[0].settings.heading).toBe('Typed right on the page');
  // And the other way: the form still drives the page.
  await page.getByLabel('Headline').fill('Typed in the form');
  await expect(headline).toHaveText('Typed in the form');

  // "Add section" under the banner, from the page: the new one lands right after it.
  await preview.locator('section.site-hero').hover();
  await preview.locator('.site-slot:has(> section.site-hero) > .site-insert').click();
  await page.getByRole('dialog').getByRole('button', { name: /^Promotion strip/ }).click();
  await expect(page.getByLabel('Message')).toBeVisible();
  const strip = `Reused strip ${Date.now()}`;
  await page.getByLabel('Message').fill(strip);
  await saved(page);
  const home = (await draftOf(page)).home.sections as Array<{ type: string; settings: { text?: string } }>;
  expect(home[1]!.type).toBe('banner');
  expect(home[1]!.settings.text).toBe(strip);

  // Keep it, then put a copy on the About page.
  await page.getByRole('button', { name: 'Save for reuse' }).click();
  await page.getByLabel('Name for the saved section').fill('My strip');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. Find it under “Add section” on any page.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove section' }).click();
  await page.getByRole('combobox', { name: 'Page' }).selectOption({ label: 'About us' });
  await page.getByRole('button', { name: '+ Add section' }).click();
  const kept = page.getByRole('dialog').locator('.se-list li', { hasText: 'My strip' }).first();
  await kept.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(preview.getByText(strip)).toBeVisible();
  await page.getByRole('button', { name: 'Remove section' }).click();
  // Tidy up the saved section.
  await page.getByRole('button', { name: '+ Add section' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove My strip' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await saved(page);
});

test('site builder: looking for a product to link to asks the server once per pause, not in a loop', async ({ page }) => {
  await logIn(page);
  await openSite(page);
  await openBanner(page);
  let asked = 0;
  page.on('request', (r) => {
    if (r.url().includes('/v1/products?status=active&q=')) asked++;
  });
  await page.getByLabel('Button link').first().selectOption({ label: 'A product' });
  await page.getByLabel('Find a product').first().fill('reef');
  await expect(page.locator('.se-search-results')).toContainText('Reef Hoodie');
  await page.waitForTimeout(1500);
  expect(asked).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Undo' }).click();
});
