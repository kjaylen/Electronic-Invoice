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
 *   MAIL_CATCH_DIR        also write each message as an .eml file here
 *   MAIL_CATCH_USER, MAIL_CATCH_PASS   require this sign-in (to try wrong passwords)
 *
 * `npm run demo` starts one of its own; this is for running the server by hand.
 */

import { startMailCatcher, startMailViewer } from '../test/mail-catcher.ts';

const env = process.env;
const catcher = await startMailCatcher({
  port: Number(env.MAIL_CATCH_PORT ?? 1025),
  ...(env.MAIL_CATCH_DIR && { dir: env.MAIL_CATCH_DIR }),
  ...(env.MAIL_CATCH_USER && env.MAIL_CATCH_PASS && { auth: { user: env.MAIL_CATCH_USER, pass: env.MAIL_CATCH_PASS } }),
});
const viewer = await startMailViewer(catcher, Number(env.MAIL_CATCH_VIEW_PORT ?? 1080));
console.log(`Catching mail on smtp://127.0.0.1:${catcher.port} (nothing is delivered).`);
console.log(`Look at it at http://localhost:${viewer.port}`);
