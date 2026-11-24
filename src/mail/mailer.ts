/**
 * Outgoing email, as the rest of the app sees it.
 *
 *   Mailer          what every part of the app calls: `mailer.send(message)`.
 *                   In the running app this is the mail service (service.ts):
 *                   it checks the message, queues it and returns; delivery,
 *                   retries and the log happen behind it.
 *   MailTransport   where a message finally goes when no SMTP server is set
 *                   up: a folder of .eml files (development, the demo) or a
 *                   list in memory (tests). Real delivery is SMTP (smtp.ts),
 *                   from the settings saved in the app or SMTP_URL.
 *
 * Without any of them, routes that need email answer 503.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsFromEnv } from './settings.ts';
import { composeEml, type Delivery, type MailAttachment, type OutgoingMail, smtpSend } from './smtp.ts';
import type { MailType } from './types.ts';

export type { MailAttachment, OutgoingMail } from './smtp.ts';
export { simpleHtml, escapeHtml } from './layout.ts';

export interface MailMessage {
  /** What this email is (types.ts): decides who it is from and how it is treated. */
  type: MailType;
  /** The business it is from or about; its log shows it. Leave out for the platform's own. */
  tenantId?: string | null;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** Extra headers; only List-Unsubscribe, List-Unsubscribe-Post and Auto-Submitted are kept. */
  headers?: Record<string, string>;
  /** Who caused it, for the log. */
  userId?: string | null;
}

export interface MailReceipt {
  id: string;
  /** 'suppressed': not sent, because the address is on the do-not-send list. */
  status: 'queued' | 'sent' | 'failed' | 'suppressed';
}

export interface Mailer {
  /** Resolves once the message is safely queued. Rejects only when it cannot be (no mail set up, a bad address). */
  send(message: MailMessage): Promise<MailReceipt | void>;
}

export interface MailTransport {
  deliver(mail: OutgoingMail, about: { type: MailType; tenantId: string | null }): Promise<Delivery>;
}

export class MailNotConfigured extends Error {
  override name = 'MailNotConfigured';
}

/** Writes each message as an .eml file (the local demo, development). */
export function outboxTransport(dir: string): MailTransport {
  mkdirSync(dir, { recursive: true });
  return {
    async deliver(mail) {
      const message = await composeEml(mail);
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mail.to.replace(/[^a-z0-9@.-]/gi, '_')}.eml`;
      // Write then rename, so anyone watching the folder never reads a half-written message.
      const tmp = join(dir, `.${name}.tmp`);
      writeFileSync(tmp, message);
      renameSync(tmp, join(dir, name));
      return { response: `250 written to ${name}`, messageId: name };
    },
  };
}

export type SentMail = OutgoingMail & { type?: MailType; tenantId?: string | null };

/**
 * Keeps messages in memory (tests). A transport for the mail service, and a Mailer on its own for code tested without one.
 *
 * To look at what the tests send: with MAIL_MIRROR_SMTP=smtp://127.0.0.1:1025 set, every message kept here
 * is also sent to that server, which must be a mail catcher (`npm run mail:proof` does this for the whole suite).
 */
export function memoryMailer(): Mailer & MailTransport & { sent: SentMail[] } {
  const sent: SentMail[] = [];
  const mirrorTo = process.env.MAIL_MIRROR_SMTP;
  const mirror = async (mail: OutgoingMail, type: MailType) => {
    if (!mirrorTo) return;
    const server = settingsFromEnv(mirrorTo, 'Floreo <no-reply@localhost>');
    await smtpSend(server, { ...mail, from: mail.from || 'Floreo <no-reply@localhost>', headers: { ...mail.headers, 'X-Floreo-Type': type } }, { connectTimeoutMs: 5000 }).catch(() => {});
  };
  return {
    sent,
    async send(m) {
      sent.push({ ...m, from: '' });
      await mirror({ from: '', to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo, attachments: m.attachments, headers: m.headers }, m.type);
    },
    async deliver(mail, about) {
      sent.push({ ...mail, ...about });
      await mirror(mail, about.type);
      return { response: '250 kept in memory', messageId: `<${sent.length}@memory>` };
    },
  };
}

export const noMailer: Mailer = {
  async send() {
    throw new MailNotConfigured('Email is not set up on this server');
  },
};
