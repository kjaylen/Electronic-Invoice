/**
 * Housekeeping, every few minutes: the platform's billing (trials ending,
 * monthly invoices, overdue status), payment reminders to businesses'
 * customers, email notices to businesses (rejections,
 * outages, certificates, plan reminders), alerts to the operations webhook,
 * and clean-up of expired rate-limit windows and sign-in challenges.
 *
 * Every step is safe to run from several processes at once.
 */

import { sweepIdempotency } from './idempotency.ts';
import { pruneLoggedRequests } from './devlog.ts';
import { type BillingContext, type BillingRunResult, runBilling } from '../billing/billing.ts';
import type { Queryable } from '../db/database.ts';
import { sweepRateLimits } from '../db/ratelimit.ts';
import type { Mailer } from '../mail/mailer.ts';
import { runNotifications, type NotifyResult } from '../notify/notifications.ts';
import { runDailySummaries } from '../notify/daily.ts';
import { heartbeat, opsStatus, type OpsThresholds, sendAlerts } from '../ops/monitoring.ts';
import { backfillDueDates } from '../receivables/receivables.ts';
import { reverseVoidedSales } from '../inventory/stock.ts';
import { runRecurringExpenses } from './recurring-expenses.ts';
import { reverseVoidedLoyalty } from './loyalty.ts';
import { runStockAlerts } from '../commerce/stock-alerts.ts';
import { runCheckoutReminders } from '../commerce/checkouts.ts';
import { sweepBuyerSignIns } from '../commerce/buyers.ts';
import { reverseVoidedGiftCards } from '../commerce/giftcards.ts';

export interface HousekeepingOptions {
  mailer?: Mailer;
  publicUrl?: string;
  alertWebhookUrl?: string;
  environment?: string;
  thresholds?: OpsThresholds;
  /** Runs the platform's billing when given. */
  billing?: () => Promise<BillingContext>;
  /** Checks online payments buyers never came back from. */
  reconcilePayments?: () => Promise<unknown>;
  /** Emails customers about invoices coming due and overdue. */
  reminders?: () => Promise<unknown>;
  /** Issues recurring invoices that are due. */
  recurring?: () => Promise<unknown>;
  /** Erases businesses whose owners closed them more than 30 days ago. */
  eraseClosed?: () => Promise<unknown>;
  intervalMs?: number;
  onError?: (step: string, error: unknown) => void;
}

export interface HousekeepingResult {
  billing: BillingRunResult | null;
  notifications: NotifyResult | null;
  alerts: { fired: string[]; resolved: string[] } | null;
  sweptLimits: number;
}

export async function runHousekeepingOnce(db: Queryable, options: HousekeepingOptions = {}): Promise<HousekeepingResult> {
  const result: HousekeepingResult = { billing: null, notifications: null, alerts: null, sweptLimits: 0 };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      options.onError?.(name, e);
      return null;
    }
  };
  if (options.billing) {
    const billing = options.billing;
    result.billing = await step('billing', async () => runBilling(await billing()));
  }
  if (options.reconcilePayments) await step('payments', options.reconcilePayments);
  // Stock sold on documents that were rejected or cancelled since goes back on the shelf.
  await step('stock', () => reverseVoidedSales(db));
  await step('loyalty', () => reverseVoidedLoyalty(db));
  await step('gift cards', () => reverseVoidedGiftCards(db));
  // Due dates for invoices issued before they were kept (read from the signed XML).
  await step('due dates', () => backfillDueDates(db));
  await step('repeating expenses', () => runRecurringExpenses(db));
  if (options.recurring) await step('recurring invoices', options.recurring);
  if (options.eraseClosed) await step('closed businesses', options.eraseClosed);
  if (options.reminders) await step('reminders', options.reminders);
  if (options.mailer) {
    const mailer = options.mailer;
    result.notifications = await step('notifications', () => runNotifications(db, { mailer, ...(options.publicUrl && { publicUrl: options.publicUrl }) }));
    await step('daily summaries', () => runDailySummaries(db, { mailer, ...(options.publicUrl && { publicUrl: options.publicUrl }) }));
    await step('back in stock', () => runStockAlerts(db, { mailer, ...(options.publicUrl && { publicUrl: options.publicUrl }) }));
    await step('checkout reminders', () => runCheckoutReminders(db, {}, { mailer, ...(options.publicUrl && { publicUrl: options.publicUrl }) }));
  }
  if (options.alertWebhookUrl) {
    const url = options.alertWebhookUrl;
    result.alerts = await step('alerts', async () => sendAlerts(db, await opsStatus(db, options.thresholds), { webhookUrl: url, ...(options.environment && { environment: options.environment }) }));
  }
  result.sweptLimits = (await step('rate limits', () => sweepRateLimits(db))) ?? 0;
  await step('challenges', () => db.query('delete from login_challenges where expires_at < now()'));
  await step('buyer sign-ins', () => sweepBuyerSignIns(db));
  // Webhook bookkeeping: handled outbox rows after a week, deliveries after 30 days.
  await step('outbox', () => db.query("delete from event_outbox where processed_at < now() - interval '7 days'"));
  await step('deliveries', () => db.query("delete from webhook_deliveries where status <> 'pending' and created_at < now() - interval '30 days'"));
  // Answers kept so a retried store order is not placed twice.
  await step('order retries', () => sweepIdempotency(db));
  // The developer log: a week of requests, and no more than each business's newest 10,000.
  await step('developer log', () => pruneLoggedRequests(db));
  await step('heartbeat', () => heartbeat(db, 'housekeeping', { notifications: result.notifications, alerts: result.alerts }));
  return result;
}

export function startHousekeeping(db: Queryable, options: HousekeepingOptions = {}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runHousekeepingOnce(db, options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5 * 60_000);
  timer.unref();
  // First run soon after start, not a full interval later.
  const first = setTimeout(() => void tick(), 15_000);
  first.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
      while (running) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
