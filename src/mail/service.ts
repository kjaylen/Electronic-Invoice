/**
 * The mail service: the one way email leaves the platform.
 *
 * send() checks a message (the address, the headers, the do-not-send list),
 * writes it to mail_messages and returns. Nothing a person is waiting for
 * ever waits on a mail server.
 *
 * In the background each message is tried:
 *   1. An email from a business goes through that business's own server when
 *      it has set one up. If that server fails for a reason that is the
 *      server's (sign-in, connection, encryption, the from address, a quota),
 *      the message goes on to step 2 in the same attempt, and the business's
 *      settings page says what happened.
 *   2. The platform's server (saved in the platform console, else SMTP_URL,
 *      else a development outbox), with the business's name as the from name
 *      and its address as the reply-to.
 * A temporary failure is tried again after 1 min, 5 min, 30 min and 2 h, and
 * the message is marked failed after 5 attempts. A refusal that will not
 * change (the mailbox does not exist) fails at once, and that address goes on
 * the do-not-send list.
 *
 * mail_messages is the log too. A message whose text holds a link or code
 * that lets someone in is scrubbed once it is delivered or has failed.
 *
 * Safe to run from several server processes: a message is claimed by one.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConnectionOptions } from 'node:tls';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { countHit } from '../db/ratelimit.ts';
import { checkAddress, cleanHeaders, cleanSubject, formatFrom, isAddress } from './address.ts';
import { emailHtml, emailText, escapeHtml, withFooterLine } from './layout.ts';
import { type Mailer, type MailMessage, MailNotConfigured, type MailReceipt, type MailTransport } from './mailer.ts';
import { loadMailSettings, PLATFORM_SCOPE, type SmtpSettings, type StoredMailSettings } from './settings.ts';
import { type Delivery, explainFailure, MailDeliveryError, type MailAttachment, type OutgoingMail, smtpSend } from './smtp.ts';
import { type MailType, mailTypeDef } from './types.ts';

export const DEFAULT_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 15 * 60_000;

export interface MailServiceOptions {
  /** SMTP_URL and MAIL_FROM, as settings: used until settings are saved in the platform console. */
  envSettings?: SmtpSettings;
  /** Where mail goes when there is no SMTP server at all: an outbox folder, or memory (tests). */
  transport?: MailTransport;
  /** The sender when mail goes to `transport`, e.g. "Floreo <no-reply@localhost>". */
  from?: { name: string; address: string };
  /** For the links that stop optional emails. */
  publicUrl?: string;
  /**
   * true: send() returns as soon as the message is queued, and start() delivers (the server).
   * false (default): send() also makes the first attempt before returning (tests, scripts); a failure is recorded, not thrown.
   */
  background?: boolean;
  /** Attempts before a message is marked failed. Default 5. */
  maxAttempts?: number;
  /** How long to wait after each failed attempt. Default 1 min, 5 min, 30 min, 2 h. */
  backoffMs?: number[];
  /** Emails one business may send in an hour and in a day; more wait their turn. Defaults 300 and 2000. */
  ratePerHour?: number;
  ratePerDay?: number;
  /** Days the log is kept (default 90), and days a message's text and attachments are kept for resending (default 30). */
  logDays?: number;
  contentDays?: number;
  /** Let a business's server be on a private address (development and tests only). */
  allowPrivateHosts?: boolean;
  /** Extra TLS options for SMTP connections (tests). */
  tls?: ConnectionOptions;
  connectTimeoutMs?: number;
  socketTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export class MailError extends Error {
  override name = 'MailError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface MessageRow {
  id: string; tenant_id: string | null; type: string; category: string; sender: 'business' | 'platform'; to_address: string; subject: string; reply_to: string | null;
  status: string; attempts: number; next_attempt_at: Date | string; expires_at: Date | string | null; sensitive: boolean; payload: string | null; attachments: number;
  via: string | null; from_address: string | null; server_response: string | null; error: string | null; error_code: string | null; note: string | null;
  resend_of: string | null; created_at: Date | string; sent_at: Date | string | null; failed_at: Date | string | null; tenant_name?: string | null;
}

interface Payload {
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
  headers?: Record<string, string>;
}

export interface MailLogEntry {
  id: string; tenantId: string | null; tenantName: string | null; type: string; typeLabel: string; to: string; subject: string; status: string; attempts: number;
  via: string | null; from: string | null; error: string | null; errorCode: string | null; note: string | null; serverResponse: string | null; attachments: number;
  createdAt: string; sentAt: string | null; failedAt: string | null; nextAttemptAt: string | null; resendOf: string | null; canResend: boolean;
}

export interface TestResult {
  ok: boolean;
  /** The server's answer when it took the message. */
  response?: string;
  /** What went wrong: the server's own words, and the likely cause. */
  error?: { kind: string; detail: string; hint: string };
  from: string;
  to: string;
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const payloadContext = (id: string) => `mail:${id}`;

export interface MailService extends Mailer {
  send(message: MailMessage): Promise<MailReceipt>;
  /** Whether mail can go out at all (the platform has a server or a development transport). */
  readonly configured: boolean;
  /** Look again at whether the platform has a server (after its settings change). */
  refresh(): Promise<boolean>;
  /** Try every message that is due. Returns how many were tried. */
  runOnce(limit?: number): Promise<number>;
  /** Deliver in the background from now on. */
  start(intervalMs?: number): void;
  stop(): Promise<void>;
  /** Send a test message through `settings` now, outside the queue, and say exactly what happened. */
  sendTest(scope: string, settings: SmtpSettings | null, to: string, options?: { saved?: boolean; userId?: string | null }): Promise<TestResult>;
  list(filter: { tenantId?: string | null; all?: boolean; status?: string; type?: string; q?: string; before?: string; limit?: number }): Promise<{ data: MailLogEntry[]; nextBefore: string | null }>;
  /** Queue a copy of a message that was sent or failed. */
  resend(id: string, scope: { tenantId?: string | null; all?: boolean }, userId?: string | null): Promise<MailReceipt>;
  /** The link in an optional email: who it stops, and (with `confirm`) stop it. */
  unsubscribe(token: string, confirm: boolean): Promise<{ email: string; business: string | null; what: string } | null>;
  /** Drop old log rows and old message bodies. */
  purge(): Promise<{ deleted: number; scrubbed: number }>;
  /** Where the platform's own mail goes right now, and who it is from. */
  describe(): Promise<MailRoute>;
  /** The limits in force, for the settings pages. */
  readonly limits: { perHour: number; perDay: number; maxAttempts: number; logDays: number; contentDays: number; allowPrivateHosts: boolean };
}

export interface MailRoute {
  /** saved: the platform console's settings. environment: SMTP_URL. outbox: files or memory (development). none: nothing set up. */
  source: 'saved' | 'environment' | 'outbox' | 'none';
  host: string | null;
  from: { name: string; address: string } | null;
}

export async function createMailService(db: Queryable, keys: KeyProtector, options: MailServiceOptions = {}): Promise<MailService> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const ratePerHour = options.ratePerHour ?? 300;
  const ratePerDay = options.ratePerDay ?? 2000;
  const smtpOptions = {
    ...(options.tls && { tls: options.tls }),
    ...(options.connectTimeoutMs && { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.socketTimeoutMs && { socketTimeoutMs: options.socketTimeoutMs }),
  };
  const fallbackFrom = options.from ?? (options.envSettings ? { name: options.envSettings.fromName, address: options.envSettings.fromAddress } : { name: 'Floreo', address: 'no-reply@localhost' });
  const hasBuiltIn = Boolean(options.envSettings || options.transport);
  let savedPlatform = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | null = null;
  let again = false;
  const report = (e: unknown) => options.onError?.(e);

  const refresh = async () => {
    savedPlatform = (await db.query('select 1 from mail_settings where scope = $1 and enabled', [PLATFORM_SCOPE])).rows.length > 0;
    return savedPlatform || hasBuiltIn;
  };
  await refresh();

  // ---------- the message's content, encrypted at rest ----------

  const seal = async (id: string, payload: Payload) => keys.encrypt(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')), payloadContext(id));
  const unseal = async (id: string, blob: string): Promise<Payload> => JSON.parse(gunzipSync(await keys.decrypt(blob, payloadContext(id))).toString('utf8')) as Payload;

  // ---------- the do-not-send list ----------

  const suppression = async (q: Queryable, tenantId: string | null, email: string) =>
    (await q.query<{ reason: string; detail: string | null }>(
      'select reason, detail from mail_suppressions where email = $1 and tenant_id is not distinct from $2', [email.toLowerCase(), tenantId],
    )).rows[0] ?? null;

  const suppress = async (tenantId: string | null, email: string, reason: 'bounced' | 'unsubscribed' | 'manual', detail: string | null) => {
    await db.query(
      `insert into mail_suppressions (id, tenant_id, email, reason, detail) values ($1, $2, $3, $4, $5)
       on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), email) do nothing`,
      [randomUUID(), tenantId, email.toLowerCase(), reason, detail?.slice(0, 500) ?? null],
    );
  };

  // ---------- queueing ----------

  async function send(m: MailMessage): Promise<MailReceipt> {
    const type = m.type;
    const def = mailTypeDef(type);
    if (!def) throw new MailError('unknown_type', `"${String(type)}" is not a kind of email this platform sends`);
    const tenantId = m.tenantId ?? null;
    const to = checkAddress(m.to, 'The recipient’s email address');
    // A reply-to that is not an address is left out rather than losing the email.
    const replyTo = m.replyTo && isAddress(m.replyTo) ? m.replyTo.trim() : null;
    const subject = cleanSubject(m.subject) || '(no subject)';
    let headers = cleanHeaders(m.headers);
    let text = m.text;
    let html = m.html;
    const attachments = m.attachments ?? [];
    const size = attachments.reduce((n, a) => n + (typeof a.content === 'string' ? Buffer.byteLength(a.content) : a.content.length), 0);
    if (size > MAX_ATTACHMENT_BYTES) throw new MailError('too_big', 'The attachments are over 20 MB, more than email can carry');
    for (const a of attachments) {
      if (/[\r\n\u0000]/.test(a.filename) || /[\r\n\u0000]/.test(a.contentType)) throw new MailError('bad_attachment', 'An attachment’s name has a line break in it');
    }

    if (!savedPlatform && !hasBuiltIn) {
      // A business with a server of its own can still send its own emails.
      const own = def.sender === 'business' && tenantId
        ? (await db.query('select 1 from mail_settings where scope = $1 and enabled', [tenantId])).rows.length > 0
        : false;
      if (!own) throw new MailNotConfigured('Email is not set up on this server');
    }

    const id = randomUUID();
    const stopped = await suppression(db, tenantId, to);
    if (stopped && (stopped.reason !== 'unsubscribed' || def.category === 'optional')) {
      const why = stopped.reason === 'unsubscribed' ? 'This person asked not to get these emails' : stopped.reason === 'bounced'
        ? `Not sent: an earlier email to this address came back (${stopped.detail ?? 'the mailbox does not exist'}). Take it off the do-not-send list to try again.`
        : 'Not sent: this address is on the do-not-send list';
      await db.query(
        `insert into mail_messages (id, tenant_id, type, category, sender, to_address, subject, reply_to, status, sensitive, attachments, error, error_code, created_by, failed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'suppressed', $9, $10, $11, 'suppressed', $12, now())`,
        [id, tenantId, type, def.category, def.sender, to, subject, replyTo, Boolean(def.sensitive), attachments.length, why, m.userId ?? null],
      );
      return { id, status: 'suppressed' };
    }

    // An email that is not about something the person did or owes always carries a way to stop it.
    let unsubscribeHash: string | null = null;
    if (def.category === 'optional' && !headers['List-Unsubscribe']) {
      if (!options.publicUrl) throw new MailNotConfigured('PUBLIC_URL is not set: an email people can opt out of needs it for its unsubscribe link');
      const token = randomBytes(24).toString('base64url');
      unsubscribeHash = tokenHash(token);
      const base = options.publicUrl.replace(/\/$/, '');
      headers = { ...headers, 'List-Unsubscribe': `<${base}/v1/mail/unsubscribe/${token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
      const page = `${base}/v1/mail/unsubscribe/${token}`;
      text = `${text}\n\nTo stop getting these emails: ${page}`;
      if (html !== undefined) html = withFooterLine(html, `<a href="${escapeHtml(page)}" style="color:#646b7b">Stop getting these emails</a>`);
    }

    const payload: Payload = {
      text,
      ...(html !== undefined && { html }),
      ...(attachments.length && { attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: (typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content).toString('base64') })) }),
      ...(Object.keys(headers).length && { headers }),
    };
    await db.query(
      `insert into mail_messages (id, tenant_id, type, category, sender, to_address, subject, reply_to, status, sensitive, payload, attachments, unsubscribe_hash, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12, $13, now() + make_interval(mins => $14))`,
      [id, tenantId, type, def.category, def.sender, to, subject, replyTo, Boolean(def.sensitive), await seal(id, payload), attachments.length, unsubscribeHash, m.userId ?? null,
        def.lifetimeMinutes ?? 3 * 24 * 60],
    );
    if (options.background) {
      kick();
      return { id, status: 'queued' };
    }
    const row = await claimOne(id);
    if (row) await attempt(row).catch(report);
    const status = (await db.query<{ status: string }>('select status from mail_messages where id = $1', [id])).rows[0]?.status;
    return { id, status: status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'queued' };
  }

  // ---------- delivery ----------

  const CLAIM = `status = 'sending', attempts = attempts + 1, locked_until = now() + interval '10 minutes'`;

  const claimOne = async (id: string) =>
    (await db.query<MessageRow>(`update mail_messages set ${CLAIM} where id = $1 and status = 'queued' returning *`, [id])).rows[0] ?? null;

  const claimDue = async (limit: number) =>
    (await db.query<MessageRow>(
      `update mail_messages set ${CLAIM}
       where id in (
         select id from mail_messages
         where (status = 'queued' and next_attempt_at <= now()) or (status = 'sending' and locked_until < now())
         order by next_attempt_at limit $1 for update skip locked)
       returning *`,
      [limit],
    )).rows;

  const finish = async (row: MessageRow, sent: { via: 'business' | 'platform'; from: string; delivery: Delivery; note: string | null }) => {
    await db.query(
      `update mail_messages set status = 'sent', sent_at = now(), via = $2, from_address = $3, server_response = $4, note = $5, error = null, error_code = null, locked_until = null,
         payload = case when sensitive then null else payload end
       where id = $1`,
      [row.id, sent.via, sent.from, sent.delivery.response.slice(0, 500), sent.note],
    );
  };

  const fail = async (row: MessageRow, code: string, error: string, note: string | null = null) => {
    await db.query(
      `update mail_messages set status = 'failed', failed_at = now(), error = $2, error_code = $3, note = coalesce($4, note), locked_until = null,
         payload = case when sensitive then null else payload end
       where id = $1`,
      [row.id, error.slice(0, 1000), code, note],
    );
  };

  const retryLater = async (row: MessageRow, code: string, error: string, note: string | null) => {
    if (row.attempts >= maxAttempts) return fail(row, code, `${error} (gave up after ${row.attempts} attempts)`, note);
    const wait = backoff[Math.min(row.attempts - 1, backoff.length - 1)] ?? 60_000;
    await db.query(
      `update mail_messages set status = 'queued', next_attempt_at = now() + make_interval(secs => $2::double precision / 1000), error = $3, error_code = $4, note = coalesce($5, note), locked_until = null where id = $1`,
      [row.id, wait, error.slice(0, 1000), code, note],
    );
  };

  /** A business's server answered, or did not: keep what its settings page shows up to date. */
  const recordOutcome = async (scope: string, error: MailDeliveryError | null) => {
    if (!error) {
      await db.query('update mail_settings set verified_at = now(), failures = 0, last_error = null, last_error_at = null, paused_until = null where scope = $1', [scope]);
      return 0;
    }
    const r = await db.query<{ failures: number }>(
      `update mail_settings set failures = failures + 1, last_error = $2, last_error_at = now(),
         paused_until = case when $4 and failures + 1 >= $3 then now() + make_interval(secs => $5::double precision / 1000) else paused_until end
       where scope = $1 returning failures`,
      [scope, `${error.hint} (${error.detail})`.slice(0, 1000), PAUSE_AFTER_FAILURES, scope !== PLATFORM_SCOPE, PAUSE_MS],
    );
    return r.rows[0]?.failures ?? 0;
  };

  /** Over its hourly or daily limit: when the business may send again, or null. */
  const overRate = async (tenantId: string): Promise<Date | null> => {
    for (const [key, limit, windowMs] of [[`mail|h|${tenantId}`, ratePerHour, 3600_000], [`mail|d|${tenantId}`, ratePerDay, 24 * 3600_000]] as const) {
      if ((await countHit(db, key, windowMs)) > limit) {
        const reset = (await db.query<{ reset_at: Date | string }>('select reset_at from rate_limits where key = $1', [key])).rows[0]?.reset_at;
        return reset ? new Date(reset) : new Date(Date.now() + 60_000);
      }
    }
    return null;
  };

  async function attempt(row: MessageRow): Promise<void> {
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return fail(row, 'expired', 'Not sent: by the time it could go it was no longer of use (a link or code in it had stopped working, or it waited too long)');
    }
    if (!row.payload) return fail(row, 'no_content', 'Not sent: its text is no longer kept');
    if (row.sender === 'business' && row.tenant_id && row.attempts === 1) {
      const until = await overRate(row.tenant_id);
      if (until) {
        await db.query(
          `update mail_messages set status = 'queued', attempts = attempts - 1, next_attempt_at = $2, locked_until = null, note = $3 where id = $1`,
          [row.id, until, 'Waiting: this business has sent as many emails as it may for now. It goes out when the limit resets.'],
        );
        return;
      }
    }
    let payload: Payload;
    try {
      payload = await unseal(row.id, row.payload);
    } catch {
      return fail(row, 'unreadable', 'Not sent: its text could not be read back (the server’s encryption key has changed)');
    }
    const tenant = row.tenant_id
      ? (await db.query<{ name: string; email: string }>('select coalesce(trade_name, legal_name) as name, email from tenants where id = $1', [row.tenant_id])).rows[0] ?? null
      : null;
    const base: Omit<OutgoingMail, 'from' | 'replyTo'> = {
      to: row.to_address, subject: row.subject, text: payload.text,
      ...(payload.html !== undefined && { html: payload.html }),
      ...(payload.attachments?.length && { attachments: payload.attachments.map((a): MailAttachment => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, 'base64') })) }),
      headers: { ...payload.headers, 'X-Floreo-Mail': row.id, 'X-Floreo-Type': row.type },
    };
    let note: string | null = null;

    // 1. The business's own server.
    if (row.sender === 'business' && row.tenant_id) {
      let own: StoredMailSettings | null = null;
      try {
        own = await loadMailSettings(db, keys, row.tenant_id);
      } catch {
        note = 'Sent from the platform’s address: this business’s mail password could not be read back. Enter it again in Settings → Email.';
      }
      if (own?.enabled && !(own.pausedUntil && own.pausedUntil.getTime() > Date.now())) {
        const from = formatFrom(own.fromName, own.fromAddress);
        const replyTo = own.replyTo ?? row.reply_to ?? undefined;
        try {
          const delivery = await smtpSend(own, { ...base, from, ...(replyTo && replyTo.toLowerCase() !== own.fromAddress.toLowerCase() && { replyTo }) }, { ...smtpOptions, publicOnly: !options.allowPrivateHosts });
          await recordOutcome(row.tenant_id, null);
          return finish(row, { via: 'business', from, delivery, note: null });
        } catch (e) {
          const err = explainFailure(e);
          if (err.kind === 'mailbox' || err.kind === 'recipient') {
            if (err.kind === 'mailbox') await suppress(row.tenant_id, row.to_address, 'bounced', err.detail);
            return fail(row, err.kind, `${err.hint} The server said: ${err.detail}`);
          }
          const failures = await recordOutcome(row.tenant_id, err);
          note = `Sent from the platform’s address, because this business’s own mail server did not take it: ${err.hint} (${err.detail})`;
          // The third failure in a row: the server is left alone for a while, and the business is told once.
          if (failures === PAUSE_AFTER_FAILURES && tenant && isAddress(tenant.email)) {
            const parts = {
              heading: 'Your mail server is not accepting email',
              paragraphs: [
                `${tenant.name}’s own mail server has refused the last ${failures} emails. Your emails are still going out, from our address with your business’s name, so nothing is lost.`,
                `What the server said: ${err.detail}`,
                err.hint,
                'To fix it, open Settings → Email, correct the details and press “Send test email”.',
              ],
            };
            await send({ type: 'notice', tenantId: row.tenant_id, to: tenant.email, subject: `${tenant.name}: your mail server is not accepting email`, text: emailText(parts), html: emailHtml(parts) }).catch(report);
          }
        }
      } else if (own?.enabled) {
        note = 'Sent from the platform’s address: this business’s own mail server failed several times and is being left alone for a few minutes.';
      }
    }

    // 2. The platform's server.
    let platform: StoredMailSettings | null = null;
    try {
      platform = await loadMailSettings(db, keys, PLATFORM_SCOPE);
    } catch (e) {
      report(e);
    }
    const settings: SmtpSettings | null = platform?.enabled ? platform : options.envSettings ?? null;
    const sender = settings ? { name: settings.fromName, address: settings.fromAddress } : fallbackFrom;
    const fromBusiness = row.sender === 'business' && tenant;
    const from = formatFrom(fromBusiness ? tenant.name : sender.name, sender.address);
    const replyTo = row.reply_to ?? (fromBusiness && isAddress(tenant.email) ? tenant.email : settings?.replyTo ?? undefined);
    const mail: OutgoingMail = { ...base, from, ...(replyTo && { replyTo }) };
    try {
      let delivery: Delivery;
      if (settings) delivery = await smtpSend(settings, mail, smtpOptions);
      else if (options.transport) delivery = await options.transport.deliver(mail, { type: row.type as MailType, tenantId: row.tenant_id });
      else throw new MailDeliveryError('settings', 'No mail server is set up', 'The platform has no mail server yet. Its staff set one up in the platform console, under Email.');
      if (platform?.enabled) await recordOutcome(PLATFORM_SCOPE, null);
      return finish(row, { via: 'platform', from, delivery, note });
    } catch (e) {
      const err = explainFailure(e);
      if (platform?.enabled && err.serverFault) await recordOutcome(PLATFORM_SCOPE, err);
      const words = `${err.hint} The server said: ${err.detail}`;
      if (err.kind === 'mailbox') await suppress(row.tenant_id, row.to_address, 'bounced', err.detail);
      if (err.permanent) return fail(row, err.kind, words, note);
      return retryLater(row, err.kind, words, note);
    }
  }

  async function runOnce(limit = 20): Promise<number> {
    let done = 0;
    for (;;) {
      const rows = await claimDue(limit);
      if (!rows.length) return done;
      // A few at a time: one slow server does not hold up the rest for long.
      const queue = [...rows];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          await attempt(row).catch(async (e) => {
            report(e);
            await retryLater(row!, 'error', `Something went wrong while sending: ${String((e as Error)?.message ?? e).slice(0, 300)}`, null).catch(report);
          });
          done++;
        }
      }));
      if (rows.length < limit) return done;
    }
  }

  /** One run at a time; a message queued during a run is covered by one more run after it. */
  function kick(): void {
    if (running) {
      again = true;
      return;
    }
    running = runOnce().catch((e) => {
      report(e);
      return 0;
    }).finally(() => {
      running = null;
      if (again) {
        again = false;
        kick();
      }
    });
  }

  // ---------- test, log, resend ----------

  async function sendTest(scope: string, given: SmtpSettings | null, toRaw: string, opts: { saved?: boolean; userId?: string | null } = {}): Promise<TestResult> {
    const to = checkAddress(toRaw, 'The address to send the test to');
    const tenantId = scope === PLATFORM_SCOPE ? null : scope;
    // The platform with nothing given: whatever it uses now (SMTP_URL, else the development transport).
    const settings = given ?? (tenantId ? null : options.envSettings ?? null);
    const sender = settings ? { name: settings.fromName, address: settings.fromAddress } : fallbackFrom;
    const from = formatFrom(sender.name, sender.address);
    const at = new Date().toUTCString();
    const parts = {
      heading: 'Your email settings work',
      brand: { name: sender.name },
      paragraphs: [
        `This is a test from ${sender.name}, sent ${at}.`,
        settings ? `It went through ${settings.host}, port ${settings.port}, ${settings.security === 'tls' ? 'SSL/TLS' : settings.security === 'starttls' ? 'STARTTLS' : 'no encryption'}, from ${settings.fromAddress}.` : 'It went to this server’s development outbox, not to a real mail server.',
        'If it arrived in the spam folder, open the deliverability guide on the settings page: the sending domain’s SPF, DKIM and DMARC records decide that.',
      ],
    };
    const mail: OutgoingMail = { from, to, subject: `Test email from ${sender.name}`, text: emailText(parts), html: emailHtml(parts), ...(settings?.replyTo && { replyTo: settings.replyTo }), headers: { 'X-Floreo-Type': 'test' } };
    const id = randomUUID();
    const log = async (status: 'sent' | 'failed', response: string | null, error: MailDeliveryError | null) => {
      await db.query(
        `insert into mail_messages (id, tenant_id, type, category, sender, to_address, subject, status, attempts, via, from_address, server_response, error, error_code, created_by, sent_at, failed_at)
         values ($1, $2, 'test', 'transactional', $3, $4, $5, $6, 1, $3, $7, $8, $9, $10, $11, case when $6 = 'sent' then now() end, case when $6 = 'failed' then now() end)`,
        [id, tenantId, tenantId ? 'business' : 'platform', to, mail.subject, status, from, response?.slice(0, 500) ?? null, error ? `${error.hint} The server said: ${error.detail}`.slice(0, 1000) : null, error?.kind ?? null, opts.userId ?? null],
      );
    };
    try {
      let delivery: Delivery;
      if (settings) delivery = await smtpSend(settings, mail, { ...smtpOptions, ...(tenantId && { publicOnly: !options.allowPrivateHosts }) });
      else if (options.transport && !tenantId) delivery = await options.transport.deliver(mail, { type: 'test', tenantId });
      else throw new MailDeliveryError('settings', 'No mail server is set up', 'Fill in the server’s details first.');
      await log('sent', delivery.response, null);
      if (opts.saved) await recordOutcome(scope, null);
      return { ok: true, response: delivery.response, from, to };
    } catch (e) {
      const err = explainFailure(e);
      await log('failed', null, err);
      return { ok: false, error: { kind: err.kind, detail: err.detail, hint: err.hint }, from, to };
    }
  }

  const entry = (r: MessageRow): MailLogEntry => ({
    id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name ?? null, type: r.type, typeLabel: mailTypeDef(r.type)?.label ?? r.type, to: r.to_address, subject: r.subject,
    status: r.status, attempts: r.attempts, via: r.via, from: r.from_address, error: r.error, errorCode: r.error_code, note: r.note, serverResponse: r.server_response, attachments: r.attachments,
    createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at), failedAt: iso(r.failed_at), nextAttemptAt: r.status === 'queued' ? iso(r.next_attempt_at) : null, resendOf: r.resend_of,
    canResend: (r.status === 'sent' || r.status === 'failed') && !r.sensitive && r.payload !== null && r.type !== 'test',
  });

  async function list(filter: { tenantId?: string | null; all?: boolean; status?: string; type?: string; q?: string; before?: string; limit?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (!filter.all) add('m.tenant_id is not distinct from ?', filter.tenantId ?? null);
    else if (filter.tenantId) add('m.tenant_id = ?', filter.tenantId);
    if (filter.status) add('m.status = ?', filter.status === 'queued' ? 'queued' : filter.status);
    if (filter.type) add('m.type = ?', filter.type);
    if (filter.q?.trim()) {
      params.push(`%${filter.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(lower(m.to_address) like $${params.length} or lower(m.subject) like $${params.length})`);
    }
    if (filter.before && !Number.isNaN(Date.parse(filter.before))) add('m.created_at < ?', new Date(filter.before));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    params.push(limit + 1);
    const rows = (await db.query<MessageRow>(
      `select m.id, m.tenant_id, m.type, m.category, m.sender, m.to_address, m.subject, m.reply_to, m.status, m.attempts, m.next_attempt_at, m.expires_at, m.sensitive,
         case when m.payload is null then null else '1' end as payload, m.attachments, m.via, m.from_address, m.server_response, m.error, m.error_code, m.note, m.resend_of,
         m.created_at, m.sent_at, m.failed_at, coalesce(t.trade_name, t.legal_name) as tenant_name
       from mail_messages m left join tenants t on t.id = m.tenant_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by m.created_at desc, m.id limit $${params.length}`,
      params,
    )).rows;
    const page = rows.slice(0, limit);
    return { data: page.map(entry), nextBefore: rows.length > limit ? iso(page[page.length - 1]!.created_at) : null };
  }

  async function resend(id: string, scope: { tenantId?: string | null; all?: boolean }, userId: string | null = null): Promise<MailReceipt> {
    const row = (await db.query<MessageRow>('select * from mail_messages where id = $1', [id])).rows[0];
    if (!row || (!scope.all && row.tenant_id !== (scope.tenantId ?? null))) throw new MailError('not_found', 'This email is not in the log');
    if (row.type === 'test') throw new MailError('not_resendable', 'A test email is not sent again: press “Send test email” for a new one');
    if (row.sensitive) throw new MailError('not_resendable', 'This email held a link or code that lets someone in, so its text was not kept. Send a new one from where the first was sent.');
    if (row.status !== 'sent' && row.status !== 'failed') throw new MailError('not_resendable', row.status === 'suppressed' ? 'This email was not sent because the address is on the do-not-send list. Take the address off the list, then send it again from where it was first sent.' : 'This email is still on its way');
    if (!row.payload) throw new MailError('not_resendable', 'This email is too old to send again: its text is no longer kept');
    const stopped = await suppression(db, row.tenant_id, row.to_address);
    if (stopped && (stopped.reason !== 'unsubscribed' || row.category === 'optional')) throw new MailError('suppressed', 'This address is on the do-not-send list. Take it off the list first.');
    const copy = randomUUID();
    const payload = await seal(copy, await unseal(row.id, row.payload));
    await db.query(
      `insert into mail_messages (id, tenant_id, type, category, sender, to_address, subject, reply_to, status, sensitive, payload, attachments, resend_of, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', false, $9, $10, $11, $12, now() + interval '3 days')`,
      [copy, row.tenant_id, row.type, row.category, row.sender, row.to_address, row.subject, row.reply_to, payload, row.attachments, row.id, userId],
    );
    if (options.background) {
      kick();
      return { id: copy, status: 'queued' };
    }
    const claimed = await claimOne(copy);
    if (claimed) await attempt(claimed).catch(report);
    const status = (await db.query<{ status: string }>('select status from mail_messages where id = $1', [copy])).rows[0]?.status;
    return { id: copy, status: status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'queued' };
  }

  async function unsubscribe(token: string, confirm: boolean) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const row = (await db.query<{ tenant_id: string | null; to_address: string; type: string; tenant_name: string | null }>(
      `select m.tenant_id, m.to_address, m.type, coalesce(t.trade_name, t.legal_name) as tenant_name
       from mail_messages m left join tenants t on t.id = m.tenant_id where m.unsubscribe_hash = $1`,
      [tokenHash(token)],
    )).rows[0];
    if (!row) return null;
    const what = mailTypeDef(row.type)?.label ?? 'emails';
    if (confirm) await suppress(row.tenant_id, row.to_address, 'unsubscribed', `Asked to stop: ${what}`);
    return { email: row.to_address, business: row.tenant_name, what };
  }

  async function purge() {
    const logDays = options.logDays ?? 90;
    const contentDays = options.contentDays ?? 30;
    const deleted = (await db.query(`delete from mail_messages where created_at < now() - make_interval(days => $1) and status in ('sent', 'failed', 'suppressed') returning id`, [logDays])).rows.length;
    const scrubbed = (await db.query(
      `update mail_messages set payload = null where payload is not null and status in ('sent', 'failed') and created_at < now() - make_interval(days => $1) returning id`, [contentDays],
    )).rows.length;
    return { deleted, scrubbed };
  }

  async function describe(): Promise<MailRoute> {
    const platform = await loadMailSettings(db, keys, PLATFORM_SCOPE).catch(() => null);
    if (platform?.enabled) return { source: 'saved', host: platform.host, from: { name: platform.fromName, address: platform.fromAddress } };
    if (options.envSettings) return { source: 'environment', host: options.envSettings.host, from: { name: options.envSettings.fromName, address: options.envSettings.fromAddress } };
    if (options.transport) return { source: 'outbox', host: null, from: fallbackFrom };
    return { source: 'none', host: null, from: null };
  }

  return {
    send,
    describe,
    limits: { perHour: ratePerHour, perDay: ratePerDay, maxAttempts, logDays: options.logDays ?? 90, contentDays: options.contentDays ?? 30, allowPrivateHosts: Boolean(options.allowPrivateHosts) },
    get configured() {
      return savedPlatform || hasBuiltIn;
    },
    refresh,
    runOnce,
    start(intervalMs = 5_000) {
      if (timer) return;
      timer = setInterval(() => {
        void refresh().catch(report);
        kick();
      }, intervalMs);
      timer.unref();
      kick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      again = false;
      await running?.catch(() => 0);
    },
    sendTest,
    list,
    resend,
    unsubscribe,
    purge,
  };
}
