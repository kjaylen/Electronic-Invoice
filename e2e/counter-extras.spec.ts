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
  // A shift of this test's own: close any still open (an earlier test's till may have left one), then open one.
  const listed = await (await page.request.get('/v1/shifts', { headers: API })).json();
  for (const open of (listed.data ?? []).filter((x: { status: string }) => x.status === 'open')) {
    const detail = await (await page.request.get(`/v1/shifts/${open.id}`, { headers: API })).json();
    await page.request.post(`/v1/shifts/${open.id}/close`, { headers: API, data: { countedCash: detail.report.cash.expected } });
  }
  const registers = await (await page.request.get('/v1/registers', { headers: API })).json();
  const registerId = (registers.data ?? registers)[0].id as string;
  const opened = await page.request.post('/v1/shifts', { headers: API, data: { openingFloat: '20.00', registerId } });
  expect(opened.status(), await opened.text()).toBe(201);

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
  await expect(page.getByText('Mobile wallet').first()).toBeVisible();
  await expect(page.locator('tr', { hasText: /Service charge \(\d+ sales, before GST\)/ })).toContainText('BZ$');
  await expect(page.locator('tr', { hasText: /Tips for the staff \(\d+\)/ })).toContainText('BZ$');
  const report = (await (await page.request.get('/v1/shifts/current', { headers: API })).json()).report;
  expect(Number(report.serviceCharge.total)).toBeGreaterThanOrEqual(0.7);
  expect(Number(report.tips.byMeans.wallet)).toBeGreaterThanOrEqual(1.34);
  expect(Number(report.takings.wallet)).toBeGreaterThanOrEqual(8.66);

  // Back to how the other tests expect the counter.
  await page.request.put('/v1/counter-settings', { headers: API, data: { showUsd: false, serviceChargePercent: null, tips: false } });
});

test('layaway: started at the counter with a deposit, paid off, handed over; another one cancelled with the money back', async ({ page }) => {
  await logIn(page);
  // A customer of this test's own.
  const name = `Marta Layaway ${Date.now() % 100000}`;
  const made = await page.request.post('/v1/customers', { headers: API, data: { name, contact: { telephone: '+501 610-2233' } } });
  expect(made.status()).toBe(201);

  const start = async (deposit: string) => {
    await page.goto(`/${SLUG}/counter`);
    const search = page.getByRole('combobox', { name: 'Add an item' });
    await search.fill('4*7501000000017');
    await search.press('Enter');
    await expect(page.locator('.cart .grand')).toContainText('BZ$15.75');
    await page.getByText('Customer on the receipt').click();
    await page.getByRole('combobox', { name: 'Saved customer' }).fill(name);
    await page.getByRole('option', { name: new RegExp(name) }).click();
    await page.getByRole('group', { name: 'Payment' }).getByRole('button', { name: 'On account' }).click();
    await page.getByRole('group', { name: 'On account' }).getByRole('button', { name: 'Layaway' }).click();
    await page.getByRole('group', { name: 'Kept for' }).getByRole('button', { name: '8 weeks' }).click();
    await page.getByLabel('Deposit now').fill('99');
    await expect(page.getByText('A deposit up to the total, please')).toBeVisible();
    await page.getByLabel('Deposit now').fill(deposit);
    await expect(page.locator('.tender.account')).toContainText(`Still to pay: BZ$${(15.75 - Number(deposit)).toFixed(2)}`);
    await page.getByRole('button', { name: /Start the layaway/ }).click();
    await expect(page.locator('.last-sale')).toContainText('Authorized');
  };

  await start('5.00');
  await page.getByRole('navigation').getByRole('link', { name: 'Layaways' }).click();
  const row = page.locator('table.layaways tbody tr', { hasText: name }).first();
  await expect(row).toContainText('4 × Coconut water');
  await expect(row).toContainText('BZ$15.75');
  await expect(row).toContainText('BZ$10.75');
  await expect(row).toContainText('56 days left');
  await expect(row.getByRole('link', { name: 'Remind on WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/5016102233\?text=/);

  // She pays the rest; then the goods can be handed over, and not before.
  await expect(row.getByRole('button', { name: 'Hand over' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Take a payment' }).click();
  const pay = page.getByRole('dialog');
  await expect(pay.getByLabel('Amount')).toHaveValue('10.75');
  await pay.getByLabel('Amount').fill('20');
  await expect(pay.getByText('An amount up to BZ$10.75')).toBeVisible();
  await pay.getByLabel('Amount').fill('10.75');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText(`Paid in full. ${name} can collect.`)).toBeVisible();
  await expect(row).toContainText('Paid: ready to collect');
  await row.getByRole('button', { name: 'Hand over' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Collected' }).click();
  await expect(page.getByText('No open layaways.')).toBeVisible();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Collected' }).click();
  await expect(page.locator('table.layaways tbody tr', { hasText: name })).toHaveCount(1);

  // A second one is cancelled: the deposit is given back.
  await start('4.00');
  await page.getByRole('navigation').getByRole('link', { name: 'Layaways' }).click();
  const second = page.locator('table.layaways tbody tr', { hasText: name }).first();
  await second.getByRole('button', { name: 'Cancel' }).click();
  const cancel = page.getByRole('dialog');
  await expect(cancel).toContainText(`${name} has paid BZ$4.00. It is given back now.`);
  await cancel.getByRole('button', { name: 'Cancel the layaway' }).click();
  await expect(page.getByText(`Cancelled. Give ${name} back BZ$4.00.`)).toBeVisible();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Cancelled' }).click();
  await expect(page.locator('table.layaways tbody tr', { hasText: name })).toContainText('BZ$4.00 given back');
});
