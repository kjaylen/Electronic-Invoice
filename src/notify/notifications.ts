/**
 * Emails to a business's owners and admins when something needs them:
 *
 *   - BTS rejected a document (one email per run listing the new ones)
 *   - BTS became unreachable (contingency started) and when it is back
 *   - the BTS certificate expires in 30, 14, 7 or 1 days (and when it has expired)
 *   - their plan: the trial ends in 3 days, an invoice is overdue, issuing was paused
 *
 * Each notice is sent once: its key is claimed in notifications_sent before
 * sending, and released again if sending fails, so the next run retries.
 * Safe to run from several processes at once.
 */

import type { Queryable } from '../db/database.ts';
import { type Mailer, simpleHtml } from '../mail/mailer.ts';

export interface NotifyOptions {
  mailer: Mailer;
  /** Links in the emails go here, e.g. https://app.example.bz. */
  publicUrl?: string;
  /** Only look back this far for rejections (so turning this on does not email old ones). Default 3 days. */
  lookbackMs?: number;
}

export interface NotifyResult {
  sent: number;
  failed: number;
}

export const CERTIFICATE_WARNING_DAYS = [30, 14, 7, 1] as const;

interface Business {
  id: string;
  slug: string;
  name: string;
  email: string;
}

/** Claim keys not sent yet; returns the ones this caller now owns. */
async function claim(db: Queryable, tenantId: string, keys: string[]): Promise<string[]> {
  const claimed: string[] = [];
  for (const key of keys) {
    const r = await db.query<{ key: string }>('insert into notifications_sent (key, tenant_id) values ($1, $2) on conflict do nothing returning key', [key, tenantId]);
    if (r.rows.length) claimed.push(key);
  }
  return claimed;
}

async function release(db: Queryable, keys: string[]): Promise<void> {
  if (keys.length) await db.query('delete from notifications_sent where key = any($1::text[])', [keys]);
}

/** Owners' and admins' emails; the business email when none has one. */
export async function recipients(db: Queryable, business: Business): Promise<string[]> {
  const rows = (await db.query<{ email: string }>(
    `select distinct lower(email) as email from users where tenant_id = $1 and role in ('owner', 'admin') and status = 'active' and email is not null`,
    [business.id],
  )).rows.map((r) => r.email);
  return rows.length ? rows : [business.email];
}

async function businessOf(db: Queryable, tenantId: string): Promise<Business> {
  return (await db.query<Business>('select id, slug, coalesce(trade_name, legal_name) as name, email from tenants where id = $1', [tenantId])).rows[0]!;
}

function link(options: NotifyOptions, business: Business, path: string): string | undefined {
  return options.publicUrl ? `${options.publicUrl.replace(/\/$/, '')}/${business.slug}${path}` : undefined;
}

async function send(options: NotifyOptions, db: Queryable, business: Business, message: { subject: string; heading: string; paragraphs: string[]; button?: { label: string; path: string } }): Promise<void> {
  const url = message.button ? link(options, business, message.button.path) : undefined;
  const footer = `You get this email because you are an owner or admin of ${business.name}.`;
  const text = [...message.paragraphs, ...(url ? [url] : []), '', footer].join('\n\n');
  const html = simpleHtml({ heading: message.heading, paragraphs: [...message.paragraphs, footer], ...(url && message.button && { button: { label: message.button.label, url } }) });
  for (const to of await recipients(db, business)) {
    await options.mailer.send({ type: 'notice', tenantId: business.id, to, subject: `${business.name}: ${message.subject}`, text, html, replyTo: business.email });
  }
}

/** Claim, send, release on failure. */
async function once(db: Queryable, tenantId: string, keys: string[], result: NotifyResult, fn: (claimed: string[]) => Promise<void>): Promise<void> {
  const claimed = await claim(db, tenantId, keys);
  if (!claimed.length) return;
  try {
    await fn(claimed);
    result.sent++;
  } catch {
    await release(db, claimed);
    result.failed++;
  }
}

const TYPE_NAMES: Record<string, string> = { '01': 'Tax invoice', '02': 'Tax receipt', '03': 'Debit note', '04': 'Credit note' };

export async function runNotifications(db: Queryable, options: NotifyOptions): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0 };
  const since = new Date(Date.now() - (options.lookbackMs ?? 3 * 86_400_000)).toISOString();

  // ---------- rejections ----------
  const rejected = (await db.query<{ id: string; tenant_id: string; etd_type: string; series_number: number; serial: string; status_detail: { conditions?: Array<{ code: string; description?: string }> } | null }>(
    `select d.id, d.tenant_id, d.etd_type, d.series_number, d.serial::text as serial, d.status_detail from documents d
     where d.status = 'rejected' and d.created_at > $1
       and not exists (select 1 from notifications_sent n where n.key = 'rejected:' || d.id::text)
     order by d.created_at limit 500`,
    [since],
  )).rows;
  const byTenant = new Map<string, typeof rejected>();
  for (const d of rejected) byTenant.set(d.tenant_id, [...(byTenant.get(d.tenant_id) ?? []), d]);
  for (const [tenantId, docs] of byTenant) {
    const business = await businessOf(db, tenantId);
    await once(db, tenantId, docs.map((d) => `rejected:${d.id}`), result, async (claimed) => {
      const mine = docs.filter((d) => claimed.includes(`rejected:${d.id}`));
      const lines = mine.slice(0, 10).map((d) => {
        const why = (d.status_detail?.conditions ?? []).map((c) => c.description ?? c.code).join('; ');
        return `${TYPE_NAMES[d.etd_type] ?? 'Document'} ${String(d.series_number).padStart(3, '0')}-${d.serial.padStart(9, '0')}${why ? `: ${why}` : ''}`;
      });
      if (mine.length > 10) lines.push(`…and ${mine.length - 10} more.`);
      await send(options, db, business, {
        subject: mine.length === 1 ? 'BTS rejected a document' : `BTS rejected ${mine.length} documents`,
        heading: mine.length === 1 ? 'BTS rejected a document' : `BTS rejected ${mine.length} documents`,
        paragraphs: ['A rejected document has no legal value. Fix the problem and issue it again.', ...lines],
        button: { label: 'See rejected documents', path: '/documents?status=rejected' },
      });
    });
  }

  // ---------- outages (contingency periods) ----------
  const periods = (await db.query<{ id: string; tenant_id: string; reason: string; started_at: Date; ended_at: Date | null; queued: number }>(
    `select p.id, p.tenant_id, p.reason, p.started_at, p.ended_at,
       (select count(*)::int from documents d where d.contingency_period_id = p.id) as queued
     from contingency_periods p
     where (p.ended_at is null or p.ended_at > $1)
       and (not exists (select 1 from notifications_sent n where n.key = 'outage-start:' || p.id::text)
            or (p.ended_at is not null and not exists (select 1 from notifications_sent n where n.key = 'outage-end:' || p.id::text)))`,
    [since],
  )).rows;
  for (const p of periods) {
    const business = await businessOf(db, p.tenant_id);
    if (!p.ended_at) {
      await once(db, p.tenant_id, [`outage-start:${p.id}`], result, () => send(options, db, business, {
        subject: 'BTS cannot be reached',
        heading: 'BTS cannot be reached',
        paragraphs: [
          `Since ${new Date(p.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, documents are issued as "Pending of BTS authorization". You can keep selling; they are sent automatically when BTS is back.`,
          `Reason: ${p.reason}`,
        ],
        button: { label: 'Open the app', path: '' },
      }));
    } else {
      // A short blip (start and end in the same run) gets one email: that it is over.
      await claim(db, p.tenant_id, [`outage-start:${p.id}`]);
      await once(db, p.tenant_id, [`outage-end:${p.id}`], result, () => send(options, db, business, {
        subject: 'BTS is back',
        heading: 'BTS is back',
        paragraphs: [
          `The outage that started ${new Date(p.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC is over.`,
          p.queued ? `${p.queued} document(s) issued meanwhile are being sent to BTS. Check that none were rejected.` : 'No documents were issued meanwhile.',
        ],
        button: { label: 'See documents', path: '/documents' },
      }));
    }
  }

  // ---------- certificates about to expire ----------
  const certs = (await db.query<{ id: string; tenant_id: string; valid_to: Date; days: number }>(
    `select c.id, c.tenant_id, c.valid_to, floor(extract(epoch from (c.valid_to - now())) / 86400)::int as days
     from certificates c where c.status = 'active' and c.valid_to < now() + interval '31 days'`,
  )).rows;
  for (const c of certs) {
    const business = await businessOf(db, c.tenant_id);
    const expired = c.days < 0;
    // Every threshold already crossed is claimed together, so a certificate installed
    // with five days left gets one email, not four.
    const keys = expired ? [`cert:${c.id}:expired`] : CERTIFICATE_WARNING_DAYS.filter((d) => c.days < d).map((d) => `cert:${c.id}:${d}`);
    if (!keys.length) continue;
    await once(db, c.tenant_id, keys, result, () => send(options, db, business, {
      subject: expired ? 'Your BTS certificate has expired' : `Your BTS certificate expires in ${Math.max(c.days, 0)} day${c.days === 1 ? '' : 's'}`,
      heading: expired ? 'Your BTS certificate has expired' : 'Renew your BTS certificate',
      paragraphs: [
        expired
          ? 'Documents cannot be signed until a new certificate is installed.'
          : `It expires on ${new Date(c.valid_to).toISOString().slice(0, 10)}. Without a valid certificate, documents cannot be signed.`,
        'Get the new certificate from BTS, then install it in Settings → Business.',
      ],
      button: { label: 'Install the certificate', path: '/settings?tab=business' },
    }));
  }
  // ---------- the platform plan ----------
  const trials = (await db.query<{ tenant_id: string; trial_ends_at: Date; plan: string }>(
    "select tenant_id, trial_ends_at, plan from subscriptions where status = 'trialing' and trial_ends_at > now() and trial_ends_at < now() + interval '3 days'",
  )).rows;
  for (const s of trials) {
    const business = await businessOf(db, s.tenant_id);
    const day = new Date(s.trial_ends_at).toISOString().slice(0, 10);
    await once(db, s.tenant_id, [`trial-ending:${s.tenant_id}:${day}`], result, () => send(options, db, business, {
      subject: 'Your free trial ends soon',
      heading: 'Your free trial ends soon',
      paragraphs: [
        `Your trial ends on ${day}. Your plan then continues as ${s.plan === 'starter' ? 'Starter (free)' : `the ${s.plan[0]!.toUpperCase()}${s.plan.slice(1)} plan, invoiced monthly`}.`,
        'Choose or change your plan any time in Settings → Plan.',
      ],
      button: { label: 'Choose a plan', path: '/settings?tab=plan' },
    }));
  }
  const overdue = (await db.query<{ id: string; tenant_id: string; total_cents: unknown; due_at: Date }>(
    "select id, tenant_id, total_cents, due_at from billing_invoices where status = 'open' and due_at < now()",
  )).rows;
  for (const inv of overdue) {
    const business = await businessOf(db, inv.tenant_id);
    const pause = new Date(new Date(inv.due_at).getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    await once(db, inv.tenant_id, [`invoice-overdue:${inv.id}`], result, () => send(options, db, business, {
      subject: 'Your Floreo invoice is overdue',
      heading: 'Your invoice is overdue',
      paragraphs: [
        `BZ$${(Number(String(inv.total_cents)) / 100).toFixed(2)} was due on ${new Date(inv.due_at).toISOString().slice(0, 10)}.`,
        `If it is still unpaid on ${pause}, issuing new documents pauses until it is paid. Your documents always stay available.`,
      ],
      button: { label: 'See your plan', path: '/settings?tab=plan' },
    }));
  }
  const suspended = (await db.query<{ tenant_id: string; invoice: string | null }>(
    `select s.tenant_id, (select i.id from billing_invoices i where i.tenant_id = s.tenant_id and i.status = 'open' order by i.due_at limit 1) as invoice
     from subscriptions s where s.status = 'suspended'`,
  )).rows;
  for (const s of suspended) {
    const business = await businessOf(db, s.tenant_id);
    await once(db, s.tenant_id, [`suspended:${s.tenant_id}:${s.invoice ?? 'none'}`], result, () => send(options, db, business, {
      subject: 'Issuing is paused',
      heading: 'Issuing is paused',
      paragraphs: [
        'An invoice for your Floreo plan is more than 14 days overdue, so new documents cannot be issued for now.',
        'Pay it and issuing resumes as soon as the payment is recorded. Everything you issued stays available to view, print and download.',
      ],
      button: { label: 'See your plan', path: '/settings?tab=plan' },
    }));
  }
  return result;
}
