/**
 * A local mail catcher: an SMTP server that accepts mail and keeps it instead
 * of delivering it. No test or development email ever reaches a real person.
 *
 * Used three ways:
 *   - the tests, to check every encryption mode, sign-in, refusals and retries
 *     against a real SMTP conversation;
 *   - the demo and the browser tests, which send through it (scripts/demo.ts);
 *   - `npm run mail:catch`, to look at what the app sends (scripts/mail-catcher.ts).
 *
 * It speaks enough SMTP for a client: EHLO, STARTTLS, AUTH PLAIN and LOGIN,
 * MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT, and TLS from the first byte
 * (`secure`). `refuse` lets a test make it answer the way real servers do
 * when something is wrong. It is not a mail server and must never face the internet.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';

export interface CaughtMail {
  /** 1, 2, 3… in the order they arrived. */
  id: number;
  /** The envelope: who the server was told it is from and for. */
  from: string;
  to: string[];
  /** The whole message as sent. */
  raw: string;
  headers: Record<string, string>;
  subject: string;
  /** The parts, decoded. */
  text: string;
  html: string;
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
  /** Whether the connection was encrypted when the message was handed over, and who signed in. */
  encrypted: boolean;
  user: string | null;
  receivedAt: Date;
}

export interface MailCatcherOptions {
  port?: number;
  host?: string;
  /** TLS from the first byte (how port 465 works). Needs key and cert. */
  secure?: boolean;
  /** Offer STARTTLS (how port 587 works). Needs key and cert. */
  starttls?: boolean;
  key?: string;
  cert?: string;
  /** Require this username and password before mail is accepted. */
  auth?: { user: string; pass: string };
  /** Also write each message as an .eml file here. */
  dir?: string;
}

/** Ways to make the catcher refuse, as real servers do. Each returns an SMTP reply ("550 5.1.1 No such user") or null to accept. */
export interface Refusals {
  mailFrom?: (address: string) => string | null;
  rcptTo?: (address: string) => string | null;
  data?: (mail: CaughtMail) => string | null;
}

export interface MailCatcher {
  port: number;
  mails: CaughtMail[];
  refuse: Refusals;
  /** How many connections were opened (to check nothing connected). */
  connections: number;
  clear(): void;
  /** The newest message to an address, waiting up to `timeoutMs` for it. */
  waitFor(to: string, timeoutMs?: number): Promise<CaughtMail>;
  close(): Promise<void>;
}

// ---------- reading a message ----------

function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, _charset: string, enc: string, data: string) =>
    enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64').toString('utf8') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeWords(line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeBody(body: string, encoding: string): Buffer {
  const e = encoding.toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (e === 'quoted-printable') {
    const bytes: number[] = [];
    const text = body.replace(/=\r?\n/g, '');
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(text[i]!, 'utf8'));
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'utf8');
}

function readParts(raw: string, into: Pick<CaughtMail, 'text' | 'html' | 'attachments'>): void {
  const { headers, body } = splitHeaders(raw);
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      readParts(part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), into);
    }
    return;
  }
  const content = decodeBody(body, headers['content-transfer-encoding'] ?? '7bit');
  const disposition = headers['content-disposition'] ?? '';
  const filename = /filename\*?="?([^";]+)"?/i.exec(disposition)?.[1] ?? /name="?([^";]+)"?/i.exec(type)?.[1];
  if (/attachment/i.test(disposition) || (filename && !/^text\/(plain|html)/i.test(type))) {
    into.attachments.push({ filename: decodeWords(filename ?? 'attachment'), contentType: type.split(';')[0]!.trim(), content });
  } else if (/^text\/html/i.test(type)) into.html += content.toString('utf8');
  else if (/^text\/plain/i.test(type)) into.text += content.toString('utf8');
}

/** A raw message into its headers and decoded parts. */
export function readMail(raw: string): Pick<CaughtMail, 'headers' | 'subject' | 'text' | 'html' | 'attachments'> {
  const parts = { text: '', html: '', attachments: [] as CaughtMail['attachments'] };
  readParts(raw, parts);
  const { headers } = splitHeaders(raw);
  return { headers, subject: headers.subject ?? '', ...parts };
}

// ---------- the server ----------

const address = (arg: string) => (/<([^>]*)>/.exec(arg)?.[1] ?? arg.replace(/^[^:]*:/, '').trim().split(/\s+/)[0] ?? '').trim();

export async function startMailCatcher(options: MailCatcherOptions = {}): Promise<MailCatcher> {
  const mails: CaughtMail[] = [];
  const sockets = new Set<Socket>();
  const context = options.key && options.cert ? createSecureContext({ key: options.key, cert: options.cert }) : undefined;
  if ((options.secure || options.starttls) && !context) throw new Error('secure and starttls need a key and a cert');
  if (options.dir) mkdirSync(options.dir, { recursive: true });
  const catcher: MailCatcher = {
    port: 0, mails, refuse: {}, connections: 0,
    clear: () => void mails.splice(0),
    async waitFor(to, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const found = [...mails].reverse().find((m) => m.to.some((t) => t.toLowerCase() === to.toLowerCase()));
        if (found) return found;
        if (Date.now() > until) throw new Error(`No email to ${to} arrived within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };

  const serve = (first: Socket, encryptedAtStart: boolean) => {
    catcher.connections++;
    let socket: Socket = first;
    let encrypted = encryptedAtStart;
    let user: string | null = null;
    let from = '';
    let to: string[] = [];
    let buffer = '';
    let inData = false;
    let pending: ((line: string) => void) | null = null;
    const say = (line: string) => void (socket.writable && socket.write(`${line}\r\n`));
    const authed = () => !options.auth || user !== null;
    const check = (u: string, p: string) => {
      if (options.auth && u === options.auth.user && p === options.auth.pass) {
        user = u;
        say('235 2.7.0 Authentication successful');
      } else say('535 5.7.8 Username and Password not accepted');
    };

    const command = (line: string) => {
      if (pending) {
        const next = pending;
        pending = null;
        return next(line);
      }
      const verb = line.split(/[ :]/)[0]!.toUpperCase();
      const arg = line.slice(verb.length).trim();
      if (verb === 'EHLO' || verb === 'HELO') {
        const lines = ['localhost', 'SIZE 31457280', '8BITMIME'];
        if (options.starttls && !encrypted) lines.push('STARTTLS');
        if (options.auth) lines.push('AUTH PLAIN LOGIN');
        return say(lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}`).join('\r\n'));
      }
      if (verb === 'STARTTLS') {
        if (!options.starttls || encrypted) return say('502 5.5.1 STARTTLS not available');
        say('220 2.0.0 Ready to start TLS');
        const plain = socket;
        plain.removeAllListeners('data');
        const secure = new TLSSocket(plain, { isServer: true, secureContext: context! });
        secure.on('error', () => plain.destroy());
        socket = secure;
        encrypted = true;
        buffer = '';
        listen();
        return;
      }
      if (verb === 'AUTH') {
        if (!options.auth) return say('503 5.5.1 AUTH not available');
        const [method, initial] = arg.split(/\s+/);
        if (method?.toUpperCase() === 'PLAIN') {
          const done = (b64: string) => {
            const [, u = '', p = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
            check(u, p);
          };
          if (initial) return done(initial);
          say('334 ');
          pending = done;
          return;
        }
        if (method?.toUpperCase() === 'LOGIN') {
          say('334 VXNlcm5hbWU6');
          pending = (u) => {
            say('334 UGFzc3dvcmQ6');
            pending = (p) => check(Buffer.from(u, 'base64').toString('utf8'), Buffer.from(p, 'base64').toString('utf8'));
          };
          return;
        }
        return say('504 5.5.4 Unrecognized authentication type');
      }
      if (verb === 'MAIL') {
        if (!authed()) return say('530 5.7.0 Authentication required');
        const a = address(arg);
        const no = catcher.refuse.mailFrom?.(a);
        if (no) return say(no);
        from = a;
        to = [];
        return say('250 2.1.0 OK');
      }
      if (verb === 'RCPT') {
        if (!authed()) return say('530 5.7.0 Authentication required');
        const a = address(arg);
        const no = catcher.refuse.rcptTo?.(a);
        if (no) return say(no);
        to.push(a);
        return say('250 2.1.5 OK');
      }
      if (verb === 'DATA') {
        if (!to.length) return say('554 5.5.1 No valid recipients');
        inData = true;
        return say('354 Go ahead');
      }
      if (verb === 'RSET') {
        from = '';
        to = [];
        return say('250 2.0.0 OK');
      }
      if (verb === 'NOOP') return say('250 2.0.0 OK');
      if (verb === 'QUIT') {
        say('221 2.0.0 Bye');
        return void socket.end();
      }
      say('502 5.5.2 Command not recognized');
    };

    const message = (data: string) => {
      const raw = data.replace(/\r\n\.\./g, '\r\n.');
      const mail: CaughtMail = { id: mails.length + 1, from, to: [...to], raw, ...readMail(raw), encrypted, user, receivedAt: new Date() };
      const no = catcher.refuse.data?.(mail);
      if (no) return say(no);
      mails.push(mail);
      if (options.dir) {
        for (const t of mail.to) {
          const name = `${mail.receivedAt.toISOString().replace(/[:.]/g, '-')}-${String(mail.id).padStart(4, '0')}-${t.replace(/[^a-z0-9@.-]/gi, '_')}.eml`;
          const tmp = join(options.dir, `.${name}.tmp`);
          writeFileSync(tmp, raw);
          renameSync(tmp, join(options.dir, name));
        }
      }
      say(`250 2.0.0 OK: caught as ${mail.id}`);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.startsWith('.\r\n') ? 0 : buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buffer.slice(0, end);
          buffer = buffer.slice(end === 0 ? 3 : end + 5);
          inData = false;
          message(data);
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        command(line);
      }
    };
    function listen() {
      socket.on('data', onData);
    }
    sockets.add(first);
    first.on('close', () => sockets.delete(first));
    first.on('error', () => {});
    listen();
    say('220 localhost ESMTP mail catcher (nothing is delivered)');
  };

  const server: Server = options.secure
    ? createTlsServer({ key: options.key!, cert: options.cert! }, (s) => serve(s, true))
    : createServer((s) => serve(s, false));
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  catcher.port = (server.address() as { port: number }).port;
  return catcher;
}
