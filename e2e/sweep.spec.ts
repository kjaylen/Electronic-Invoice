/**
 * Every page of the app, opened as the owner and as a visitor, at a computer's
 * width and a phone's: none may throw, log an error, get a failed answer from
 * the server, be without a heading, or scroll sideways on a phone.
 *
 * Runs after app.spec.ts, on the business and the data it leaves.
 * SWEEP_REPORT=<file> also writes what was seen on each page (requests, time,
 * unlabelled controls) for a closer look.
 */

import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const b = (path: string) => `/${SLUG}${path === '/' ? '' : path}`;

/** Messages the browser logs by itself for answers the app expects and handles. */
const EXPECTED = [
  // "Who is signed in?" asked by a visitor.
  /status of 401/,
];

interface Seen { path: string; size: string; errors: string[]; failed: string[]; requests: number; ms: number; heading: string | null; sideways: number; unlabelled: string[] }

async function visit(page: Page, path: string, size: 'computer' | 'phone'): Promise<Seen> {
  const errors: string[] = [];
  const failed: string[] = [];
  let requests = 0;
  const onConsole = (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !EXPECTED.some((e) => e.test(m.text()))) errors.push(m.text().slice(0, 300));
  };
  const onPageError = (e: Error) => errors.push(`uncaught: ${e.message.slice(0, 300)}`);
  const onResponse = (r: { status: () => number; url: () => string; request: () => { method: () => string } }) => {
    requests++;
    const url = r.url().replace(/^https?:\/\/[^/]+/, '');
    // On a sign-in page, asking who is signed in is answered "no one"; everything else that fails is a finding
    // (a storefront page asking for the staff session would be one: buyers are not staff).
    const signIn = /\/(login|forgot-password|admin)(\/|$|\?)/.test(path);
    if (r.status() >= 400 && !(r.status() === 401 && signIn && /\/v1\/(platform\/)?auth\/session$/.test(url))) failed.push(`${r.status()} ${r.request().method()} ${url.slice(0, 160)}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  const started = Date.now();
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => {});
  const ms = Date.now() - started;
  const heading = await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => null);
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  // Controls a screen reader would announce as nothing: buttons and links without a name, fields without a label.
  const unlabelled = await page.evaluate(() => {
    const name = (el: Element) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') || '').trim();
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    const out: string[] = [];
    for (const el of document.querySelectorAll('button, a[href]')) if (visible(el) && !name(el) && !el.getAttribute('aria-labelledby')) out.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
    for (const el of document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not([type=file]), select, textarea')) {
      if (!visible(el)) continue;
      const labelled = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      if (!labelled) out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('name') ?? el.getAttribute('placeholder') ?? el.type}]`.slice(0, 80));
    }
    for (const el of document.querySelectorAll('img:not([alt])')) if (visible(el)) out.push(`img without alt: ${(el as HTMLImageElement).src.slice(-50)}`);
    return [...new Set(out)];
  });
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('response', onResponse);
  return { path, size, errors, failed, requests, ms, heading, sideways: Math.max(0, scroll - width), unlabelled };
}

async function sweep(page: Page, paths: string[]): Promise<Seen[]> {
  const seen: Seen[] = [];
  for (const size of ['computer', 'phone'] as const) {
    await page.setViewportSize(size === 'computer' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    for (const path of paths) seen.push(await visit(page, path, size));
  }
  return seen;
}

function check(seen: Seen[], name: string) {
  if (process.env.SWEEP_REPORT) writeFileSync(process.env.SWEEP_REPORT.replace(/(\.json)?$/, `-${name}.json`), JSON.stringify(seen, null, 1));
  const problems = seen.flatMap((s) => [
    ...s.errors.map((e) => `${s.path} (${s.size}): ${e}`),
    ...s.failed.map((f) => `${s.path} (${s.size}): ${f}`),
    ...(s.heading === null ? [`${s.path} (${s.size}): no heading`] : []),
    ...(s.size === 'phone' && s.sideways > 0 ? [`${s.path}: scrolls sideways by ${s.sideways}px on a phone`] : []),
  ]);
  expect(problems, problems.join('\n')).toEqual([]);
}

test('every page of the business app loads cleanly, on a computer and on a phone', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(b('/login'));
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');

  // One of each kind of record, for the pages that show one.
  const first = async (url: string) => {
    const r = await page.request.get(url, { headers: API });
    const data = r.ok() ? (await r.json()).data : null;
    return (Array.isArray(data) ? data[0]?.id : null) as string | null;
  };
  const one = {
    document: await first('/v1/documents?limit=1'), customer: await first('/v1/customers?limit=1'), order: await first('/v1/orders?limit=1'),
    product: await first('/v1/products?status=all'), item: await first('/v1/items?limit=1'), expense: await first('/v1/expenses?limit=1'),
    supplier: await first('/v1/suppliers'), quote: await first('/v1/quotes?limit=1'), recurring: await first('/v1/recurring'),
    shift: await first('/v1/shifts?limit=1'), purchaseOrder: await first('/v1/purchase-orders?limit=1'),
  };
  const detail = (id: string | null, path: (id: string) => string) => (id ? [path(id)] : []);

  const paths = [
    '/', '/counter', '/documents', '/documents/new', '/documents/new?type=01', '/customers', '/orders', '/products', '/products/new', '/products?tab=items', '/products?tab=collections',
    '/items', '/reports', '/reports?view=profit', '/receivables', '/expenses', '/expenses?tab=suppliers', '/inventory', '/inventory?filter=orders', '/inventory/receive', '/inventory/orders/new',
    '/shifts', '/gift-cards', '/site', '/quotes', '/quotes/new', '/work', '/recurring', '/recurring/new', '/labels', '/templates',
    '/settings', ...['account', 'business', 'plan', 'store', 'tills', 'users', 'activity', 'keys', 'integrations'].map((t) => `/settings?tab=${t}`),
    ...detail(one.document, (id) => `/documents/${id}`), ...detail(one.customer, (id) => `/customers/${id}`), ...detail(one.order, (id) => `/orders/${id}`),
    ...detail(one.product, (id) => `/products/${id}`), ...detail(one.item, (id) => `/items/${id}`), ...detail(one.expense, (id) => `/expenses/${id}`),
    ...detail(one.supplier, (id) => `/suppliers/${id}`), ...detail(one.quote, (id) => `/quotes/${id}`), ...detail(one.quote, (id) => `/quotes/${id}/edit`),
    ...detail(one.recurring, (id) => `/recurring/${id}`), ...detail(one.shift, (id) => `/shifts/${id}`), ...detail(one.purchaseOrder, (id) => `/inventory/orders/${id}`),
    '/no-such-page',
  ].map(b);
  check(await sweep(page, paths), 'business');
});

test('every page a visitor can open loads cleanly, on a computer and on a phone', async ({ page }) => {
  test.setTimeout(300_000);
  const paths = [
    '/', '/signup', '/pricing', '/docs', '/terms', '/privacy', '/admin',
    ...['/login', '/forgot-password', '/shop', '/shop/all', '/shop/collections', '/shop/cart', '/shop/checkout', '/shop/account', '/shop/gift-card', '/shop/products/reef-hoodie', '/shop/pages/about-us', '/shop/products/no-such-product', '/shop/pages/no-such-page'].map(b),
  ];
  const seen = await sweep(page, paths);
  // Pages for something that is not there say so; the server's "not found" for them is the right answer, not a finding.
  for (const s of seen) if (/no-such-/.test(s.path)) s.failed = s.failed.filter((f) => !/^404 GET .*no-such-/.test(f)), s.errors = s.errors.filter((e) => !/status of 404/.test(e));
  check(seen, 'visitor');
});
