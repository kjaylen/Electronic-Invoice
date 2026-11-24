/**
 * A mail catcher for development: npm run mail:catch
 *
 * An SMTP server on 127.0.0.1:1025 that accepts every message and delivers
 * none, and a page at http://localhost:1080 to look at what it caught. Point
 * the app at it with
 *
 *   SMTP_URL=smtp://127.0.0.1:1025
 *
 * or, to try the settings pages, enter 127.0.0.1, port 1025, no encryption
 * in the platform console (and in a business's Settings → Email, with
 * MAIL_ALLOW_PRIVATE_HOSTS=true set on the server).
 *
 *   MAIL_CATCH_PORT       SMTP port (default 1025)
 *   MAIL_CATCH_VIEW_PORT  the page's port (default 1080)
 *   MAIL_CATCH_DIR        also write each message as an .eml file here; the
 *                         .eml files already in it are shown too (the demo's
 *                         .demo/outbox, or what `npm run mail:proof` left)
 *   MAIL_CATCH_USER, MAIL_CATCH_PASS   require this sign-in (to try wrong passwords)
 *
 * `npm run demo` starts one of its own; this is for running the server by hand.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMail, startMailCatcher, startMailViewer } from '../test/mail-catcher.ts';

const env = process.env;
// What an earlier run left in the folder, oldest first.
const earlier = env.MAIL_CATCH_DIR && existsSync(env.MAIL_CATCH_DIR) ? readdirSync(env.MAIL_CATCH_DIR).filter((f) => f.endsWith('.eml')).sort() : [];
const catcher = await startMailCatcher({
  port: Number(env.MAIL_CATCH_PORT ?? 1025),
  ...(env.MAIL_CATCH_DIR && { dir: env.MAIL_CATCH_DIR }),
  ...(env.MAIL_CATCH_USER && env.MAIL_CATCH_PASS && { auth: { user: env.MAIL_CATCH_USER, pass: env.MAIL_CATCH_PASS } }),
});
for (const file of earlier) {
  const raw = readFileSync(join(env.MAIL_CATCH_DIR!, file), 'utf8');
  const mail = readMail(raw);
  const stamp = Date.parse(file.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
  catcher.mails.push({ id: catcher.mails.length + 1, from: mail.headers.from ?? '', to: [(mail.headers.to ?? '').replace(/^.*<([^>]+)>.*$/, '$1')], raw, ...mail, encrypted: false, user: null, receivedAt: new Date(Number.isNaN(stamp) ? Date.now() : stamp) });
}
const viewer = await startMailViewer(catcher, Number(env.MAIL_CATCH_VIEW_PORT ?? 1080));
console.log(`Catching mail on smtp://127.0.0.1:${catcher.port} (nothing is delivered).`);
console.log(`Look at it at http://localhost:${viewer.port}${earlier.length ? ` (${earlier.length} from earlier)` : ''}`);
