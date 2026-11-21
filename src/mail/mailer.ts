/**
 * Outgoing email: password resets, invitations, documents sent to customers.
 *
 *   smtpMailer(url, from)    real delivery (SMTP_URL, e.g. smtps://user:pass@smtp.example.com)
 *   outboxMailer(dir, from)  writes each message as an .eml file (local demo, development)
 *   memoryMailer()           keeps messages in memory (tests)
 *
 * Without any of them configured, routes that need email answer 503.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class MailNotConfigured extends Error {
  override name = 'MailNotConfigured';
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(m) {
      await transport.sendMail({ from, ...m });
    },
  };
}

export function outboxMailer(dir: string, from: string): Mailer {
  mkdirSync(dir, { recursive: true });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    async send(m) {
      const info = await transport.sendMail({ from, ...m });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${m.to.replace(/[^a-z0-9@.-]/gi, '_')}.eml`;
      writeFileSync(join(dir, name), info.message as Buffer);
    },
  };
}

export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}

export const noMailer: Mailer = {
  async send() {
    throw new MailNotConfigured('Email is not set up on this server');
  },
};

/** Minimal HTML escaping for the few values put into email bodies. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A plain, readable HTML email: one heading, paragraphs, an optional button. */
export function simpleHtml(opts: { heading: string; paragraphs: string[]; button?: { label: string; url: string } }): string {
  const p = opts.paragraphs.map((t) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(t)}</p>`).join('');
  const b = opts.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(opts.button.url)}" style="background:#160923;color:#fbf8f1;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(opts.button.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#efe7d6;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#160923">
<div style="max-width:520px;margin:0 auto;background:#fbf8f1;border:1px solid #e0d6c3;border-radius:12px;padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(opts.heading)}</h1>${p}${b}</div></body></html>`;
}
