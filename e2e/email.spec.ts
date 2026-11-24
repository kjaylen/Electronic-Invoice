/**
 * Settings → Email for a business, and the platform console's Email page:
 * a preset, the form with its explained errors, a password that is only ever
 * shown as saved, a test email that really goes (to the mail catcher the
 * test server runs), the log with "send again", the do-not-send list, the
 * deliverability guide, and going back to the platform's sender.
 *
 * Runs after app.spec.ts, on the business it sets up.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { pgDatabase } from '../src/db/database.ts';
import { createPlatformAdmin } from '../src/db/platform.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTBOX = `${root}.demo-e2e/outbox`;
const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
// The mail catcher the test server started (e2e/server.ts, or e2e/view.ts with E2E_VIEW=1).
const SMTP_PORT = process.env.E2E_VIEW === '1' ? Number(process.env.VIEW_MAIL_PORT ?? 3135) : Number(process.env.E2E_MAIL_PORT ?? 3125);
const DATABASE = (() => {
  const url = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://einvoicing:einvoicing@localhost:5432/einvoicing');
  url.pathname = `/${process.env.E2E_DATABASE_NAME ?? 'einvoicing_e2e'}`;
  return url.toString();
})();

function totp(secretB32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/\s/g, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The newest caught email to `to` with this in its subject, as raw text (waiting for it). */
async function caught(to: string, subject: RegExp, after: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (existsSync(OUTBOX)) {
      for (const f of readdirSync(OUTBOX).filter((x) => x.endsWith('.eml') && x.includes(to)).sort().reverse()) {
        const stamp = Date.parse(f.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
        const raw = readFileSync(`${OUTBOX}/${f}`, 'utf8');
        if (stamp >= after - 1000 && subject.test(raw)) return raw;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no email to ${to} matching ${subject}`);
}

/** Pick from one of the app's select menus (a button that opens a list). */
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: new RegExp(`^${label}`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function logIn(page: Page) {
  await page.goto(`/${SLUG}/login`);
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

test('a business sets up its own mail server: preset, explained errors, saved password, a real test email, back to the platform’s sender', async ({ page }) => {
  await logIn(page);
  // From nothing, whatever an earlier run left.
  await page.request.delete('/v1/mail/settings', { headers: { 'X-Requested-With': 'etd-web', 'X-Business': SLUG } });
  await page.goto(`/${SLUG}/settings?tab=email`);
  // Without a server of its own, it is told where its email goes.
  await expect(page.getByRole('heading', { name: 'How your email is sent' })).toBeVisible();
  await expect(page.getByText(/Your emails go out from no-reply@floreo\.test under the name “Corner Store”/)).toBeVisible();

  await page.getByRole('button', { name: 'Send from your own address' }).click();
  const form = page.locator('.mail-form');
  const box = (name: string) => form.getByRole('textbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) });
  // A preset fills in what the provider publishes, and says what it needs.
  await choose(page, 'Mail provider', 'Gmail / Google Workspace');
  await expect(box('Server')).toHaveValue('smtp.gmail.com');
  await expect(box('Port')).toHaveValue('587');
  await expect(form.getByRole('combobox', { name: /^Encryption/ })).toHaveText('STARTTLS');
  await expect(form.locator('.mail-note')).toContainText('Gmail / Google Workspace needs an app password');
  await choose(page, 'Mail provider', 'Zoho Mail');
  await expect(box('Server')).toHaveValue('smtp.zoho.com');
  await expect(box('Port')).toHaveValue('465');
  await expect(form.getByRole('combobox', { name: /^Encryption/ })).toHaveText('SSL/TLS');

  // The test server's own catcher, with mistakes first: each is explained under its field.
  await choose(page, 'Mail provider', 'Another mail server');
  await box('Server').fill('smtp://127.0.0.1');
  await box('Port').fill(String(SMTP_PORT));
  await choose(page, 'Encryption', 'None');
  await box('Username').fill('rosa@cornerstore.test');
  await box('From address').fill('not an address');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.locator('.field-problem')).toHaveCount(3);
  await expect(form).toContainText('Leave out the part before the name');
  await expect(form).toContainText('Enter the password for this username');
  await expect(form).toContainText('The from address must be one address');
  await box('Server').fill('127.0.0.1');
  await form.locator('input[type=password]').fill('an app password 1234');
  await box('From address').fill('hello@cornerstore.test');
  await box('Reply-to (optional)').fill('orders@cornerstore.test');
  const saved = page.waitForResponse((r) => r.url().endsWith('/v1/mail/settings') && r.request().method() === 'PUT');
  await form.getByRole('button', { name: 'Save' }).click();
  const answer = await (await saved).text();
  expect(answer).not.toContain('an app password 1234');
  await expect(page.getByText('Email settings saved')).toBeVisible();
  await expect(form.locator('.mail-warning')).toContainText('With no encryption');
  // The password is never shown again: only that one is saved, and a way to replace it.
  await expect(form.locator('.mail-secret-set')).toContainText('Saved');
  await expect(form.locator('input[type=password]')).toHaveCount(0);
  await form.getByRole('button', { name: 'Replace' }).click();
  await expect(form.locator('input[type=password]')).toHaveValue('');
  await expect(form).toContainText('Leave empty to keep the saved password.');
  // The catcher asks for no sign-in: clear the username (and with it the password) and save.
  await box('Username').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.mail-summary')).toContainText('Corner Store <hello@cornerstore.test>');
  await expect(page.locator('.mail-summary')).toContainText(`127.0.0.1, port ${SMTP_PORT}, no encryption`);
  await form.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.card').first().locator('.badge').first()).toHaveText('Not tested yet');

  // A real test email, and the server's own answer.
  const asked = Date.now();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByLabel('Send a test email to')).toHaveValue(OWNER.email);
  await page.locator('.mail-test').getByRole('button', { name: 'Send test email' }).click();
  await expect(page.locator('.mail-result.ok')).toContainText('The mail server accepted it.');
  await expect(page.locator('.mail-result.ok')).toContainText(/250 2\.0\.0 OK: caught as \d+/);
  const mail = await caught(OWNER.email, /Subject: Test email from Corner Store/, asked);
  expect(mail).toMatch(/From: Corner Store <hello@cornerstore\.test>/);
  expect(mail).toMatch(/Reply-To: orders@cornerstore\.test/);
  await expect(page.locator('.card').first().locator('.badge').first()).toHaveText('Working');

  // A wrong port: the reason in plain words, and what the server (or the network) said.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await box('Port').fill('2525');
  await form.getByRole('button', { name: 'Send test email' }).click();
  await form.locator('.mail-test').getByRole('button', { name: 'Send test email' }).click();
  await expect(form.locator('.mail-result.failed')).toContainText('The test email was not sent.');
  await expect(form.locator('.mail-result.failed')).toContainText(/refused the connection on this port|did not answer/);
  await form.getByRole('button', { name: 'Cancel' }).click();

  // The log: the test is there, sent; an earlier invoice can be sent again.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Email log' }).click();
  const log = page.locator('table.mail-log');
  await expect(log.locator('tbody tr').first()).toContainText('Test email');
  await choose(page, 'Kind', 'Invoice or receipt');
  const invoice = log.locator('tbody tr', { hasText: 'accounts@placenciadive.test' }).first();
  await expect(invoice).toContainText('Sent');
  await expect(invoice).toContainText('2 attachments');
  const again = Date.now();
  await invoice.getByRole('button', { name: 'Send again' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByText('Sent again to accounts@placenciadive.test')).toBeVisible();
  // It goes through the business's own server now, from its own address, attachments and all.
  const resent = await caught('accounts@placenciadive.test', /Subject: Tax Invoice 001-000000001 from Corner Store/, again);
  expect(resent).toMatch(/From: Corner Store <hello@cornerstore\.test>/);
  expect(resent).toMatch(/application\/pdf/);
  await page.getByLabel('Search').fill('nobody-at-all');
  await expect(page.getByText('No emails match.')).toBeVisible();

  // The do-not-send list.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Do-not-send list' }).click();
  await page.getByLabel('Add an address').fill('gone@buyer.test');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const blocked = page.locator('tbody tr', { hasText: 'gone@buyer.test' });
  await expect(blocked).toContainText('Added by hand');
  await blocked.getByRole('button', { name: 'Take off the list' }).click();
  await expect(page.getByText('No addresses on the list.')).toBeVisible();

  // Deliverability: the three records, explained, for the domain it now sends from.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Deliverability' }).click();
  await expect(page.getByText('Checking cornerstore.test, the domain of your from address.')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('ol.guide > li')).toHaveCount(3);
  await expect(page.locator('ol.guide')).toContainText('SPF: who may send for your domain');
  await expect(page.locator('ol.guide')).toContainText('DKIM: a signature on every email');
  await expect(page.locator('ol.guide')).toContainText('DMARC: what to do with forgeries');
  await expect(page.locator('.mail-dns')).toHaveCount(3);

  // Back to the platform's sender.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Sending' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(/Your emails go out from no-reply@floreo\.test/)).toBeVisible();
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Deliverability' }).click();
  await expect(page.getByText('Nothing for you to set up.')).toBeVisible();
});

test('platform console: staff see where email goes, every business’s log, and can test the server', async ({ browser }) => {
  // A staff account of this test's own (the first sign-in shows the authenticator secret once).
  const db = pgDatabase(new pg.Pool({ connectionString: DATABASE, max: 1 }));
  const password = 'staff password for the email page';
  const staffEmail = `mail-staff-${Date.now()}@demo.test`;
  try {
    await createPlatformAdmin(db, { email: staffEmail, name: 'Mail Staff', password });
  } finally {
    await db.close();
  }
  const page = await (await browser.newContext()).newPage();
  await page.goto('/admin');
  await page.getByLabel('Email').fill(staffEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  const secret = (await page.locator('.secret-key').textContent())!;
  await page.getByLabel(/Enter the 6-digit code/).fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  await download;
  await page.getByRole('button', { name: 'I saved them' }).click();
  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Email' }).click();

  await expect(page.getByRole('heading', { name: 'The platform’s mail server' })).toBeVisible();
  await expect(page.getByText(/Nothing is saved here\. Email goes through 127\.0\.0\.1, from no-reply@floreo\.test/)).toBeVisible();
  const asked = Date.now();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByLabel('Send a test email to')).toHaveValue(staffEmail);
  await page.locator('.mail-test').getByRole('button', { name: 'Send test email' }).click();
  await expect(page.locator('.mail-result.ok')).toContainText('The mail server accepted it.');
  await caught(staffEmail, /Subject: Test email from Floreo/, asked);

  // Saving a server here takes over from the environment; the password is only ever "saved".
  await page.getByRole('button', { name: 'Set up a mail server here' }).click();
  const form = page.locator('.mail-form');
  const box = (name: string) => form.getByRole('textbox', { name: new RegExp(`^${name}`) });
  await choose(page, 'Mail provider', 'Another mail server');
  await box('Server').fill('127.0.0.1');
  await box('Port').fill(String(SMTP_PORT));
  await choose(page, 'Encryption', 'None');
  await box('From name').fill('Floreo');
  await box('From address').fill('hello@floreo.test');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.mail-summary')).toContainText('Floreo <hello@floreo.test>');
  await form.getByRole('button', { name: 'Close' }).click();

  // Every business's email, by name.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Email log' }).click();
  const log = page.locator('table.mail-log');
  await expect(log.locator('thead')).toContainText('Business');
  await page.getByLabel('Search').fill('placenciadive');
  await expect(log.locator('tbody tr').first()).toContainText('Corner Store');

  // And back to what the environment sets, so later tests see the same sender.
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Sending' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(/Nothing is saved here\. Email goes through 127\.0\.0\.1/)).toBeVisible();
});
