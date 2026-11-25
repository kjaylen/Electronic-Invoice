/**
 * What is due this month: once a month, a week before the returns are due,
 * the owners and admins of a business get one email listing what is coming
 * up: the GST return and the business tax return (the 15th, with about how
 * much each comes to from the records so far), and the dates the owner added
 * (trade licence, Social Security, insurance).
 *
 * Sent once per business per month (its key is claimed in notifications_sent
 * first), from the 8th at 7 am Belize time; a business that turned the
 * reminder off, or has nothing coming up, gets nothing.
 */

import type { Queryable } from '../db/database.ts';
import { belizeToday, type DueDate, dueDates, loadTaxSettings } from '../api/business-tax.ts';
import { type Mailer, simpleHtml } from '../mail/mailer.ts';
import { recipients } from './notifications.ts';

export interface FilingOptions {
  mailer: Mailer;
  publicUrl?: string;
  /** For tests: the time now. */
  now?: Date;
}

/** The day of the month the reminder goes out from: a week before the 15th. */
export const REMINDER_DAY = 8;
const longDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** One line of the email for one thing that is due. */
export function dueLine(d: DueDate): string {
  const when = `${longDay(d.dueOn)} (${d.daysLeft === 0 ? 'today' : d.daysLeft === 1 ? 'tomorrow' : `in ${d.daysLeft} days`})`;
  if (d.amount === undefined) return `${d.name}: ${when}.`;
  const credit = d.amount.startsWith('-');
  const about = d.amount === '0.00' ? 'nothing to pay from the records so far' : credit ? `a credit of about BZ$${d.amount.slice(1)} from the records so far` : `about BZ$${d.amount} to pay from the records so far`;
  return `${d.name}: due ${when}; ${about}.`;
}

export async function runFilingReminders(db: Queryable, options: FilingOptions): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const result = { sent: 0, failed: 0 };
  const today = belizeToday(now);
  const day = Number(today.slice(8, 10));
  // From the 8th at 7 am until the returns are due; later than that it would only be noise.
  if (day < REMINDER_DAY || day > 15 || (day === REMINDER_DAY && new Date(now.getTime() - 6 * 3600_000).getUTCHours() < 7)) return result;
  const tenants = (await db.query<{ id: string; slug: string; name: string; email: string }>(
    "select id, slug, coalesce(trade_name, legal_name) as name, email from tenants where closed_at is null and coalesce(tax_settings ->> 'email', 'true') <> 'false'",
  )).rows;
  for (const t of tenants) {
    const key = `filing-reminder:${t.id}:${today.slice(0, 7)}`;
    const claimed = await db.query('insert into notifications_sent (key, tenant_id) values ($1, $2) on conflict do nothing returning key', [key, t.id]);
    if (!claimed.rows.length) continue;
    try {
      const settings = await loadTaxSettings(db, t.id);
      // Up to the same day next month: everything before the next reminder.
      const due = await dueDates(db, t.id, today, 31);
      // A business that has issued nothing and added no dates has nothing to be reminded of.
      const active = (await db.query('select 1 from documents where tenant_id = $1 limit 1', [t.id])).rows.length > 0;
      if (!due.length || (!active && !settings.dates.length)) continue;
      const base = options.publicUrl ? `${options.publicUrl.replace(/\/$/, '')}/${t.slug}` : undefined;
      const paragraphs = [
        ...due.map(dueLine),
        'The amounts are worked out from your tax documents and recorded expenses up to now. Open the worksheets under Reports to see how, and check them with your accountant before you file.',
      ];
      const footer = `You get this once a month because you are an owner or admin of ${t.name}. Turn it off, or add dates of your own, in Settings, Business.`;
      const subject = `${t.name}: what is due this month`;
      const html = simpleHtml({ heading: 'What is due this month', paragraphs, footer: [footer], ...(base && { button: { label: 'Open the worksheets', url: `${base}/reports` } }) });
      const text = ['What is due this month', ...paragraphs, ...(base ? [`${base}/reports`] : []), '', footer].join('\n\n');
      for (const to of await recipients(db, { id: t.id, slug: t.slug, name: t.name, email: t.email })) {
        await options.mailer.send({ type: 'filing-reminder', tenantId: t.id, to, subject, text, html, replyTo: t.email });
      }
      result.sent++;
    } catch {
      await db.query('delete from notifications_sent where key = $1', [key]).catch(() => {});
      result.failed++;
    }
  }
  return result;
}
