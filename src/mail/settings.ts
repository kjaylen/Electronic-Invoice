/**
 * Outgoing mail servers: the platform's own (scope 'platform') and one for
 * each business that sends from its own address (scope = the business's id).
 *
 * The password is encrypted with the server's key, bound to the row it
 * belongs to, and is never part of what `publicSettings` returns: once
 * saved, a browser only learns that one is set.
 */

import type { Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { checkAddress, checkDisplayName, MailAddressError, parseFrom } from './address.ts';

export type MailSecurity = 'none' | 'starttls' | 'tls';
export const SECURITY_MODES: readonly MailSecurity[] = ['none', 'starttls', 'tls'];

/** A server and who mail is from, ready to connect with. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  password: string | null;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  /** From SMTP_URL only: encrypt when the server offers it and carry on when it does not (how smtp:// has always been read). */
  opportunisticTls?: boolean;
}

export interface StoredMailSettings extends SmtpSettings {
  scope: string;
  enabled: boolean;
  verifiedAt: Date | null;
  failures: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  pausedUntil: Date | null;
  updatedAt: Date;
}

/** What a settings form sends. `password` left out keeps the saved one; null removes it. */
export interface MailSettingsInput {
  host?: unknown;
  port?: unknown;
  security?: unknown;
  username?: unknown;
  password?: unknown;
  fromName?: unknown;
  fromAddress?: unknown;
  replyTo?: unknown;
  enabled?: unknown;
}

/** What is wrong, by field, in words for the person filling in the form. */
export class MailSettingsError extends Error {
  override name = 'MailSettingsError';
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? 'These email settings are not complete');
    this.fields = fields;
  }
}

// Ports mail servers listen on. A business's server must use one of them, so the form cannot be used to knock on other doors.
export const MAIL_PORTS = [25, 465, 587, 2525];

export interface ValidateOptions {
  /** A password is already saved (so leaving the box empty is fine). */
  hasPassword?: boolean;
  /** A business's own server: standard mail ports only. */
  restrictPorts?: boolean;
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/** Check a form; returns the settings (password undefined = keep the saved one) and things worth a warning. */
export function validateMailSettings(input: MailSettingsInput, options: ValidateOptions = {}): { settings: Omit<SmtpSettings, 'password'> & { password: string | null | undefined }; enabled: boolean; warnings: string[] } {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  let host = text(input.host);
  if (!host) fields.host = 'Enter the mail server’s name, like smtp.gmail.com';
  else if (/^[a-z]+:\/\//i.test(host)) fields.host = 'Leave out the part before the name (smtp://, https://): just the server’s name, like smtp.gmail.com';
  else if (/\s/.test(host)) fields.host = 'The server’s name cannot have spaces';
  else if (/^[^[\]]+:\d+$/.test(host)) fields.host = 'Put the port in its own box, and only the server’s name here';
  else if (host.includes('@')) fields.host = 'This looks like an email address. Enter the mail server’s name, like smtp.gmail.com';
  else if (!HOST.test(host) && !/^[0-9a-f:.]+$/i.test(host)) fields.host = 'This is not a server name. It should look like smtp.example.com';
  host = host.replace(/\.$/, '').toLowerCase();

  const port = typeof input.port === 'number' ? input.port : /^\d{1,5}$/.test(text(input.port)) ? Number(text(input.port)) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fields.port = 'Enter the port as a number: usually 587 or 465';
  else if (options.restrictPorts && !MAIL_PORTS.includes(port)) fields.port = `Use one of the ports mail servers listen on: ${MAIL_PORTS.join(', ')}`;

  const security = text(input.security) as MailSecurity;
  if (!SECURITY_MODES.includes(security)) fields.security = 'Choose the encryption: STARTTLS, SSL/TLS or none';
  else if (!fields.port) {
    if (port === 465 && security !== 'tls') warnings.push('Port 465 normally uses SSL/TLS. If the test fails, change the encryption to SSL/TLS, or the port to 587.');
    if (port === 587 && security === 'tls') warnings.push('Port 587 normally uses STARTTLS. If the test fails, change the encryption to STARTTLS, or the port to 465.');
    if (security === 'none') warnings.push('With no encryption, the password and every email travel across the internet unprotected. Use it only for a server on your own network.');
  }

  const username = text(input.username);
  if (username.length > 320 || /[\u0000-\u001f\u007f]/.test(username)) fields.username = 'The username is too long or has characters that cannot be typed';

  let password: string | null | undefined;
  if (input.password === null) password = null;
  else if (typeof input.password === 'string' && input.password !== '') {
    if (input.password.length > 1024 || /[\r\n\u0000]/.test(input.password)) fields.password = 'The password is too long or has a line break in it';
    else password = input.password;
  }
  if (username && password === undefined && !options.hasPassword) fields.password = 'Enter the password for this username';
  if (username && password === null) fields.password = 'A username needs a password. Enter it, or clear the username if the server needs no sign-in';
  if (!username && typeof password === 'string') fields.username = 'Enter the username that goes with this password (often your full email address)';
  // No username: no password is kept either.
  if (!username && !fields.username) password = null;

  let fromName = '';
  let fromAddress = '';
  let replyTo: string | null = null;
  const field = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e instanceof MailAddressError)) throw e;
      fields[name] = e.message;
    }
  };
  field('fromName', () => (fromName = checkDisplayName(input.fromName, 'The from name')));
  field('fromAddress', () => (fromAddress = checkAddress(input.fromAddress, 'The from address')));
  if (text(input.replyTo)) field('replyTo', () => (replyTo = checkAddress(input.replyTo, 'The reply-to address')));

  if (Object.keys(fields).length) throw new MailSettingsError(fields);
  return {
    settings: { host, port, security, username: username || null, password, fromName, fromAddress, replyTo },
    enabled: input.enabled !== false,
    warnings,
  };
}

// ---------- presets ----------

export interface MailPreset {
  key: string;
  name: string;
  host: string;
  port: number;
  security: MailSecurity;
  /** What goes in the username box. */
  username: string;
  /** What a person needs to know before it works. */
  note: string;
  appPassword: boolean;
  /** What the sending domain's SPF record must include, and where its DKIM key usually is. */
  spfInclude?: string;
  dkimSelectors?: string[];
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    key: 'google', name: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls', username: 'Your full email address', appPassword: true,
    note: 'Google needs an app password, not your normal one. Turn on 2-Step Verification for the account, then make an app password at myaccount.google.com/apppasswords and paste it here.',
    spfInclude: '_spf.google.com', dkimSelectors: ['google'],
  },
  {
    key: 'microsoft', name: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls', username: 'Your full email address', appPassword: true,
    note: 'Your Microsoft 365 administrator must turn on “Authenticated SMTP” for this mailbox (admin centre → Users → the user → Mail → Manage email apps). If the account uses multi-factor sign-in, use an app password. Microsoft is phasing out password sign-in for SMTP: if the test says sign-in is disabled, ask your administrator or use another server.',
    spfInclude: 'spf.protection.outlook.com', dkimSelectors: ['selector1', 'selector2'],
  },
  {
    key: 'zoho', name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'tls', username: 'Your full Zoho email address', appPassword: true,
    note: 'If the account uses two-factor sign-in, make an application-specific password in Zoho Accounts → Security and use it here. Paid organisation accounts use the server smtppro.zoho.com.',
    spfInclude: 'zohomail.com', dkimSelectors: ['zmail', 'zoho'],
  },
  {
    key: 'ses', name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls', username: 'The SMTP username from the SES console', appPassword: false,
    note: 'Use the SMTP credentials made in the SES console (Account dashboard → Create SMTP credentials), not your AWS password or access keys. Change the server to your own SES region, and verify the from address or its domain in SES first. A new SES account only sends to verified addresses until Amazon moves it out of the sandbox.',
    spfInclude: 'amazonses.com',
  },
];

// ---------- storage ----------

interface Row {
  scope: string; host: string; port: number; security: MailSecurity; username: string | null; password_enc: string | null;
  from_name: string; from_address: string; reply_to: string | null; enabled: boolean;
  verified_at: Date | string | null; failures: number; last_error: string | null; last_error_at: Date | string | null; paused_until: Date | string | null; updated_at: Date | string;
}

const date = (v: Date | string | null) => (v === null ? null : new Date(v));
const context = (scope: string) => `mail-settings:${scope}`;
export const PLATFORM_SCOPE = 'platform';

/** A server's settings with its password decrypted, or null when none are saved. */
export async function loadMailSettings(db: Queryable, keys: KeyProtector, scope: string): Promise<StoredMailSettings | null> {
  const r = (await db.query<Row>('select * from mail_settings where scope = $1', [scope])).rows[0];
  if (!r) return null;
  return {
    scope: r.scope, host: r.host, port: r.port, security: r.security, username: r.username,
    password: r.password_enc ? (await keys.decrypt(r.password_enc, context(scope))).toString('utf8') : null,
    fromName: r.from_name, fromAddress: r.from_address, replyTo: r.reply_to, enabled: r.enabled,
    verifiedAt: date(r.verified_at), failures: r.failures, lastError: r.last_error, lastErrorAt: date(r.last_error_at), pausedUntil: date(r.paused_until), updatedAt: new Date(r.updated_at),
  };
}

/** What a browser may see: everything but the password. */
export function publicSettings(s: StoredMailSettings) {
  return {
    host: s.host, port: s.port, security: s.security, username: s.username ?? '', passwordSet: s.password !== null,
    fromName: s.fromName, fromAddress: s.fromAddress, replyTo: s.replyTo ?? '', enabled: s.enabled,
    verifiedAt: s.verifiedAt?.toISOString() ?? null, lastError: s.lastError, lastErrorAt: s.lastErrorAt?.toISOString() ?? null,
    pausedUntil: s.pausedUntil && s.pausedUntil.getTime() > Date.now() ? s.pausedUntil.toISOString() : null,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Check and save. Returns the saved settings and any warnings. Throws MailSettingsError. */
export async function saveMailSettings(
  db: Queryable, keys: KeyProtector, scope: string, input: MailSettingsInput, options: { by?: string | null; restrictPorts?: boolean } = {},
): Promise<{ settings: StoredMailSettings; warnings: string[] }> {
  const existing = await loadMailSettings(db, keys, scope);
  const { settings, enabled, warnings } = validateMailSettings(input, { hasPassword: existing?.password != null, ...(options.restrictPorts && { restrictPorts: true }) });
  const password = settings.password === undefined ? existing?.password ?? null : settings.password;
  const enc = password === null ? null : await keys.encrypt(Buffer.from(password, 'utf8'), context(scope));
  // Saving is a fresh start: what went wrong with the old settings no longer says anything.
  await db.query(
    `insert into mail_settings (scope, tenant_id, host, port, security, username, password_enc, from_name, from_address, reply_to, enabled, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (scope) do update set host = excluded.host, port = excluded.port, security = excluded.security, username = excluded.username, password_enc = excluded.password_enc,
       from_name = excluded.from_name, from_address = excluded.from_address, reply_to = excluded.reply_to, enabled = excluded.enabled, updated_by = excluded.updated_by,
       updated_at = now(), failures = 0, last_error = null, last_error_at = null, paused_until = null, verified_at = null`,
    [scope, scope === PLATFORM_SCOPE ? null : scope, settings.host, settings.port, settings.security, settings.username, enc, settings.fromName, settings.fromAddress, settings.replyTo, enabled, options.by ?? null],
  );
  return { settings: (await loadMailSettings(db, keys, scope))!, warnings };
}

export async function deleteMailSettings(db: Queryable, scope: string): Promise<boolean> {
  return (await db.query('delete from mail_settings where scope = $1 returning scope', [scope])).rows.length > 0;
}

/** A form's values over the saved ones (the saved password when the form leaves it out), for a test before saving. */
export async function settingsForTest(db: Queryable, keys: KeyProtector, scope: string, input: MailSettingsInput | undefined, options: { restrictPorts?: boolean } = {}): Promise<SmtpSettings | null> {
  const existing = await loadMailSettings(db, keys, scope);
  if (!input) return existing;
  const { settings } = validateMailSettings(input, { hasPassword: existing?.password != null, ...(options.restrictPorts && { restrictPorts: true }) });
  return { ...settings, password: settings.password === undefined ? existing?.password ?? null : settings.password };
}

// ---------- the environment (before any settings are saved) ----------

/**
 * SMTP_URL and MAIL_FROM as settings: how the server was set up before there
 * was a settings page, and still a way to start one without touching the
 * database. Settings saved in the platform console take over from it.
 */
export function settingsFromEnv(url: string, from: string): SmtpSettings {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const tls = u.protocol === 'smtps:';
  const port = u.port ? Number(u.port) : tls ? 465 : 587;
  const { name, address } = parseFrom(from);
  return {
    host: u.hostname, port,
    security: tls ? 'tls' : 'starttls',
    ...(!tls && { opportunisticTls: true }),
    username: u.username ? decodeURIComponent(u.username) : null, password: u.password ? decodeURIComponent(u.password) : null,
    fromName: name || 'Floreo', fromAddress: address, replyTo: null,
  };
}
