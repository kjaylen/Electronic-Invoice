/**
 * The only code that talks SMTP (through nodemailer). Everything else hands
 * a finished message to the mail service (service.ts).
 *
 *   smtpSend(settings, mail)   one message through one server: connect, the
 *                              chosen encryption, sign in, send, disconnect.
 *   explainFailure(error)      what a failure means: whose fault, whether to
 *                              try again, and a hint for a person.
 *   composeEml(mail)           the message as a file (development outbox).
 *
 * Encryption:
 *   tls       encrypted from the first byte (port 465)
 *   starttls  connects plain, must upgrade before anything else (port 587)
 *   none      never encrypted (a relay on the same machine or network)
 *
 * Nothing here logs. Errors carry the server's own words (never the password).
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import nodemailer from 'nodemailer';
import { isPrivateAddress } from '../webhooks/webhooks.ts';
import type { SmtpSettings } from './settings.ts';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType: string;
}

/** A message ready to go: every header decided. */
export interface OutgoingMail {
  from: string;
  to: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  attachments?: MailAttachment[] | undefined;
  headers?: Record<string, string> | undefined;
}

export interface Delivery {
  /** The server's answer to the message, e.g. "250 2.0.0 OK 1700000000 queued". */
  response: string;
  messageId: string;
}

/**
 * Why a message was not delivered.
 *
 *   auth        the server refused the username or password
 *   connection  the server could not be reached (name, port, firewall, time-out)
 *   tls         the encryption did not match, or the certificate was refused
 *   sender      the server will not send from this from address
 *   settings    something else about how the server is set up (relaying, a private address)
 *   mailbox     the recipient's mailbox does not exist: do not write to it again
 *   recipient   the recipient's server refused this message for good
 *   message     the server refused the message itself (too big, looks like spam)
 *   temporary   try again later
 */
export type FailureKind = 'auth' | 'connection' | 'tls' | 'sender' | 'settings' | 'mailbox' | 'recipient' | 'message' | 'temporary';

export class MailDeliveryError extends Error {
  override name = 'MailDeliveryError';
  readonly kind: FailureKind;
  /** The server's own words, or the network error. */
  readonly detail: string;
  /** The likely cause, for a person. */
  readonly hint: string;
  readonly responseCode: number | null;
  constructor(kind: FailureKind, detail: string, hint: string, responseCode: number | null = null) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
    this.hint = hint;
    this.responseCode = responseCode;
  }
  /** The mail server (or how it is set up) is at fault, not the message or its recipient: another server may well deliver it. */
  get serverFault(): boolean {
    return this.kind === 'auth' || this.kind === 'connection' || this.kind === 'tls' || this.kind === 'sender' || this.kind === 'settings';
  }
  /** Trying again will not help. */
  get permanent(): boolean {
    return this.kind === 'mailbox' || this.kind === 'recipient' || this.kind === 'message';
  }
}

interface NodemailerError extends Error {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
  cause?: unknown;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 500);

/** What went wrong, from nodemailer's error or any other. */
export function explainFailure(error: unknown): MailDeliveryError {
  if (error instanceof MailDeliveryError) return error;
  const e = (error ?? {}) as NodemailerError;
  const code = e.code ?? '';
  const rc = typeof e.responseCode === 'number' ? e.responseCode : null;
  const cause = (e.cause ?? {}) as { code?: string; message?: string };
  const words = oneLine(e.response || e.message || String(error));
  const all = `${code} ${cause.code ?? ''} ${e.message ?? ''} ${cause.message ?? ''} ${e.response ?? ''}`;
  const command = (e.command ?? '').toUpperCase();

  // Signing in.
  if (code === 'EAUTH' || code === 'ENOAUTH' || code === 'EOAUTH2' || rc === 535 || rc === 534 || (rc === 530 && /auth/i.test(all))) {
    const disabled = /disabled|basic auth|SmtpClientAuthentication/i.test(all);
    return new MailDeliveryError('auth', words, disabled
      ? 'The mail server has password sign-in turned off for this mailbox. Ask its administrator to allow SMTP sign-in (Microsoft 365: “Authenticated SMTP”), or use another server.'
      : 'The username or password was refused. Check both. Gmail, Outlook and Zoho need an app password when two-step sign-in is on: your normal password will not work.', rc);
  }
  // Encryption and certificates.
  if (/wrong version number|ssl routines|EPROTO\b|unknown protocol/i.test(all)) {
    return new MailDeliveryError('tls', words, 'The encryption does not match the port. Port 465 uses SSL/TLS; port 587 uses STARTTLS. Change one to match the other.', rc);
  }
  if (/self[- ]signed|unable to verify|certificate|altnames|CERT_|DEPTH_ZERO/i.test(all)) {
    return new MailDeliveryError('tls', words, 'The mail server’s security certificate was not accepted: it has expired, is self-signed, or is for another name. Check the server name is the one your provider gives, exactly.', rc);
  }
  if (code === 'ETLS' || code === 'EREQUIRETLS' || /STARTTLS/i.test(e.message ?? '')) {
    return new MailDeliveryError('tls', words, 'The server did not accept STARTTLS on this port. Try SSL/TLS on port 465, or check the port.', rc);
  }
  // Reaching the server.
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) {
    return new MailDeliveryError('connection', words, 'No server was found with this name. Check the spelling of the server name.', rc);
  }
  if (/Greeting never received/i.test(all)) {
    return new MailDeliveryError('connection', words, 'The server answered but never said hello. This usually means the encryption does not match the port: port 465 uses SSL/TLS, port 587 uses STARTTLS.', rc);
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|timed? ?out/i.test(all)) {
    const refused = /ECONNREFUSED/i.test(all);
    return new MailDeliveryError('connection', words, refused
      ? 'The server refused the connection on this port. Check the port (usually 587 or 465) and the server name.'
      : 'The server did not answer. The port may be blocked (many networks block port 25), or the server name or port is wrong.', rc);
  }
  // The server answered and said no.
  if (rc !== null && rc >= 400 && rc < 500) {
    return new MailDeliveryError('temporary', words, 'The server asked to try again later. The message stays in the queue and is tried again.', rc);
  }
  if (rc !== null && rc >= 500) {
    if (/relay|not permitted to relay|relaying denied/i.test(all)) {
      return new MailDeliveryError('settings', words, 'The server will not pass on mail to other domains without signing in. Enter the username and password for it.', rc);
    }
    if (command === 'MAIL FROM' || /sender (address )?rejected|not owned by user|sender verify|from address|send ?as|SendAsDenied|not authorized to send/i.test(all)) {
      return new MailDeliveryError('sender', words, 'The server will not send from this from address. Use the address of the account you sign in with, or one that account is allowed to send as.', rc);
    }
    if (command === 'RCPT TO' || code === 'EENVELOPE') {
      const dead = /5\.1\.[1236]\b|5\.1\.10\b|user unknown|unknown user|no such (user|recipient|mailbox|address)|does ?n.t exist|not exist|mailbox (unavailable|not found)|recipient (address )?rejected|invalid (recipient|mailbox)|address rejected/i.test(all);
      return dead
        ? new MailDeliveryError('mailbox', words, 'The recipient’s mail server says this mailbox does not exist. Check the address for a typing mistake.', rc)
        : new MailDeliveryError('recipient', words, 'The recipient’s mail server refused the message.', rc);
    }
    return new MailDeliveryError('message', words, rc === 552 || /too (big|large)|size/i.test(all)
      ? 'The server refused the message: it is too big. The attachments may be over its limit.'
      : 'The server refused the message itself. It may have judged it as spam, or the account may have reached its sending limit.', rc);
  }
  return new MailDeliveryError('temporary', words, 'Something went wrong while sending. The message stays in the queue and is tried again.', rc);
}

export interface SmtpOptions {
  /** Refuse servers on private, loopback and link-local addresses (a business's own server, in production). */
  publicOnly?: boolean;
  /** Extra TLS options (tests: a certificate authority to trust). */
  tls?: ConnectionOptions;
  /** How long to wait: to connect and be greeted, and between answers. */
  connectTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * The address to connect to. With `publicOnly`, the name is resolved here and
 * the connection goes to that very address (so a name cannot answer with a
 * public address for the check and a private one for the connection).
 */
async function resolveHost(host: string, publicOnly: boolean): Promise<{ host: string; servername?: string }> {
  if (!publicOnly) return { host };
  const inside = () => new MailDeliveryError('settings', `${host} is a private address`, 'This server’s address is inside a private network, which cannot be used here. Enter the public name of your mail server, like smtp.example.com.');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw inside();
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw inside();
    return { host };
  }
  let found;
  try {
    found = await lookup(host, { all: true });
  } catch (e) {
    throw explainFailure(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'EDNS', cause: e }));
  }
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw inside();
  return { host: found[0]!.address, servername: host };
}

function transportFor(settings: SmtpSettings, target: { host: string; servername?: string }, options: SmtpOptions) {
  const tls: ConnectionOptions = { minVersion: 'TLSv1.2', ...(target.servername && { servername: target.servername }), ...options.tls };
  return nodemailer.createTransport({
    host: target.host,
    port: settings.port,
    secure: settings.security === 'tls',
    ...(settings.security === 'starttls' && !settings.opportunisticTls && { requireTLS: true }),
    ...(settings.security === 'none' && { ignoreTLS: true }),
    ...(target.servername && { servername: target.servername }),
    ...(settings.username && { auth: { user: settings.username, pass: settings.password ?? '' } }),
    tls,
    connectionTimeout: options.connectTimeoutMs ?? 15_000,
    greetingTimeout: options.connectTimeoutMs ?? 15_000,
    dnsTimeout: options.connectTimeoutMs ?? 15_000,
    socketTimeout: options.socketTimeoutMs ?? 60_000,
    // A message is exactly what it was given: nothing read from disk or fetched from a URL.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });
}

/** Send one message through a server. Throws a MailDeliveryError saying what went wrong. */
export async function smtpSend(settings: SmtpSettings, mail: OutgoingMail, options: SmtpOptions = {}): Promise<Delivery> {
  const target = await resolveHost(settings.host, options.publicOnly === true);
  const transport = transportFor(settings, target, options);
  try {
    const info = await transport.sendMail({
      from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      ...(mail.html !== undefined && { html: mail.html }),
      ...(mail.replyTo && { replyTo: mail.replyTo }),
      ...(mail.attachments?.length && { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }),
      ...(mail.headers && { headers: mail.headers }),
    });
    // One recipient per message: a refusal of it is a failure, whatever else the server said.
    const rejected = (info.rejected ?? []) as unknown[];
    if (rejected.length) throw Object.assign(new Error(String(info.response ?? 'Recipient rejected')), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: String(info.response ?? '') });
    return { response: oneLine(String(info.response ?? '')), messageId: String(info.messageId ?? '') };
  } catch (e) {
    throw explainFailure(e);
  } finally {
    transport.close();
  }
}

/** The message as it would go over the wire (an .eml file), without sending it. */
export async function composeEml(mail: OutgoingMail): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix', disableFileAccess: true, disableUrlAccess: true });
  const info = await transport.sendMail({
    from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
    ...(mail.html !== undefined && { html: mail.html }),
    ...(mail.replyTo && { replyTo: mail.replyTo }),
    ...(mail.attachments?.length && { attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }),
    ...(mail.headers && { headers: mail.headers }),
  });
  return info.message as Buffer;
}
