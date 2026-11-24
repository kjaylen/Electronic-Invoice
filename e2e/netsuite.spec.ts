/**
 * A NetSuite connection's two add-ons, from its card in Settings →
 * Integrations: the BTS QR code on NetSuite's own invoices (a guide with the
 * template block to download or copy), and instant sending (a guide with the
 * script to download).
 *
 * There is no NetSuite to talk to here, so the connection is marked as set up
 * straight in the database; what needs a live NetSuite (turning the QR field
 * on, which tests the connection) is covered by test/netsuite.test.ts.
 *
 * Runs after app.spec.ts, on the business it sets up (on the Pro plan by then).
 */

import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';

const SLUG = 'corner-store';
const OWNER = { email: 'rosa@cornerstore.test', password: 'my brand new password' };
const API = { 'X-Requested-With': 'etd-web', 'X-Business': SLUG };
const DATABASE = (() => {
  const url = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://einvoicing:einvoicing@localhost:5432/einvoicing');
  url.pathname = '/einvoicing_e2e';
  return url.toString();
})();

async function logIn(page: Page) {
  await page.goto(`/${SLUG}/login`);
  await page.getByLabel('Email or username').fill(OWNER.email);
  await page.getByLabel(/^Password/).fill(OWNER.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.locator('.biz-card')).toContainText('Corner Store');
}

test('NetSuite add-ons: the QR code guide gives the template block; the instant sending guide gives the script', async ({ page }) => {
  await logIn(page);
  // A NetSuite connection, as it is once its details have been saved and tested.
  const made = await page.request.post('/v1/connectors', { headers: API, data: { kind: 'netsuite', name: 'NetSuite' } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = await made.json() as { id: string };
  const db = new pg.Client({ connectionString: DATABASE });
  await db.connect();
  try {
    await db.query(`update connector_links set config = config || '{"accountId":"1234567_SB1","clientId":"abc","certificateId":"cert-1"}'::jsonb where id = $1`, [id]);

    await page.goto(`/${SLUG}/settings?tab=integrations`);
    const card = page.locator('.connector-link', { hasText: 'NetSuite' }).last();
    const qr = card.locator('.addon', { hasText: 'BTS QR code on NetSuite invoices' });
    const instant = card.locator('.addon', { hasText: 'Instant sending' });
    await expect(qr).toContainText('Not set up');
    await expect(instant).toContainText('Every minute');

    // The QR guide: what to create in NetSuite, and the block for the invoice template, written for this connection's fields.
    await qr.getByRole('button', { name: 'Set up' }).click();
    const guide = page.getByRole('dialog', { name: 'BTS QR code on NetSuite invoices' });
    await expect(guide.locator('.guide-spec').first()).toContainText('_bts_qr');
    await expect(guide.locator('.guide-spec').first()).toContainText('Free-Form Text');
    await expect(guide.locator('.guide-code')).toContainText('<barcode codetype="qrcode"');
    const download = page.waitForEvent('download');
    await guide.getByRole('button', { name: 'Download the block' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('floreo-bts-qr-block.xml');
    const block = readFileSync(await file.path(), 'utf8');
    expect(block).toContain('value="${record.custbody_bts_qr}"');
    expect(block).toContain('BTS No. ${record.custbody_bts_number}');
    expect(block).toContain('Pending of BTS authorization');
    expect(block).toContain('<#if record.custbody_bts_qr?has_content>');
    // Another field name: the block follows it.
    await guide.getByLabel('QR code field').fill('custbody_my_qr');
    await expect(guide.locator('.guide-code')).toContainText('record.custbody_my_qr');
    await expect(guide.locator('.guide-spec').first()).toContainText('_my_qr');
    await guide.getByRole('button', { name: 'Done' }).click();

    // Once Floreo fills the field, the card says so.
    await db.query(`update connector_links set config = config || '{"qrField":"custbody_bts_qr"}'::jsonb where id = $1`, [id]);
    await page.reload();
    await expect(page.locator('.connector-link', { hasText: 'NetSuite' }).last().locator('.addon', { hasText: 'BTS QR code on NetSuite invoices' })).toContainText('On');

    // Instant sending: the three steps, and the script (which needs this server to have a public https address).
    await page.locator('.connector-link', { hasText: 'NetSuite' }).last().locator('.addon', { hasText: 'Instant sending' }).getByRole('button', { name: 'Set up' }).click();
    const steps = page.getByRole('dialog', { name: 'Instant sending' });
    await expect(steps.locator('.guide-step')).toHaveCount(3);
    await expect(steps).toContainText('Invoice · Cash Sale · Credit Memo');
    await steps.getByRole('button', { name: 'Download the script' }).click();
    await expect(steps.getByRole('alert')).toContainText('https://');
  } finally {
    await db.query('update connector_links set removed_at = now() where id = $1', [id]);
    await db.end();
  }
});
