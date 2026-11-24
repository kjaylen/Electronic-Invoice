/**
 * Local demo: the full app against a stand-in for BTS, so you can click through
 * sign-up → business → certificate → invoice → PDF without a real BTS certificate.
 *
 *   docker compose up -d db     (PostgreSQL)
 *   npm run web:build           (once, and after changing the web app)
 *   npm run demo                → http://localhost:3000
 *
 * Use TIN 123456 for the business and upload test/certs/signer-123456.pfx with
 * the password "test-pfx-password" (a throwaway test certificate).
 *
 * The stand-in authorizes every document. To see contingency mode, create the
 * file .demo/bts-down: BTS then "fails" until you delete it, and the worker
 * sends the queued documents within ~15 seconds of it coming back.
 *
 * Emails (password resets, invitations, documents) are sent by SMTP to a mail
 * catcher that runs here too: nothing reaches a real person. Look at them at
 * http://localhost:4380, or as .eml files in .demo/outbox.
 *
 * Demo data lives in the local Docker database. The key that encrypts stored
 * certificates is kept in .demo/kek so they stay readable between runs.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applicationResponse, startFakeBts } from '../test/fake-bts.ts';
import { startMailCatcher, startMailViewer } from '../test/mail-catcher.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const demoDir = process.env.DEMO_DIR ?? `${root}.demo`;
mkdirSync(demoDir, { recursive: true });
const kekFile = `${demoDir}/kek`;
if (!existsSync(kekFile)) writeFileSync(kekFile, randomBytes(32).toString('base64'), { mode: 0o600 });
const downFile = `${demoDir}/bts-down`;

const BTS_PORT = Number(process.env.DEMO_BTS_PORT ?? 8443);
const bts = await startFakeBts({ port: BTS_PORT });
const protocol = () => `05000000100${String(randomInt(0, 999_999_999)).padStart(9, '0')}00126012820091024411146627`.slice(0, 44);
const down = () => existsSync(downFile);

for (const path of ['/api/invoice/v1', '/api/taxreceipt/v1', '/api/debitnote/v1', '/api/creditnote/v1', '/api/event/v1']) {
  bts.handle(path, (req) => {
    if (down()) return { status: 500, body: 'Rejection: Server error' };
    const etdui = /<cbc:UUID>(\d{44})<\/cbc:UUID>/.exec(req.body)?.[1] ?? '0'.repeat(44);
    return { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: etdui, protocol: protocol() }) };
  });
}
bts.handle('/api/document/v1', () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ GetDocument: { ResponseCode: '004' } }) }));
bts.handle('/api/status/v1', () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ GetStatus: { ResponseCode: down() ? '009' : '008' } }) }));

// Email leaves the app the way it does in production, by SMTP, and is caught here.
const mailCatcher = await startMailCatcher({ port: Number(process.env.DEMO_MAIL_PORT ?? 4325), dir: `${demoDir}/outbox` });
const mailViewer = await startMailViewer(mailCatcher, Number(process.env.DEMO_MAIL_VIEW_PORT ?? 4380));

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://einvoicing:einvoicing@localhost:5432/einvoicing',
  KEY_ENCRYPTION_KEY: process.env.KEY_ENCRYPTION_KEY ?? readFileSync(kekFile, 'utf8').trim(),
  BTS_BASE_URL: bts.baseUrl,
  BTS_CA_FILE: `${root}test/certs/test-root-ca.cert.pem`,
  BTS_TIMEOUT_MS: '3000',
  COOKIE_SECURE: 'false',
  WORKER_INTERVAL_MS: '15000',
  PORT: process.env.PORT ?? '4300',
  // The catcher offers no STARTTLS, and an smtp:// address carries on without it.
  SMTP_URL: `smtp://127.0.0.1:${mailCatcher.port}`,
  MAIL_FROM: process.env.MAIL_FROM ?? 'Floreo <no-reply@floreo.test>',
  // A business may point its own mail server at this catcher too.
  MAIL_ALLOW_PRIVATE_HOSTS: 'true',
  MAIL_INTERVAL_MS: process.env.MAIL_INTERVAL_MS ?? '2000',
});
process.env.PUBLIC_URL ??= `http://localhost:${process.env.PORT}`;
// Print from the templates: on Windows with the installed Edge (as the end-to-end tests do), elsewhere
// with the Chromium Playwright installs. Without one, documents print with the built-in layouts.
process.env.PDF_RENDERER ??= 'chromium';
if (process.platform === 'win32' && !process.env.CHROMIUM_PATH) process.env.CHROMIUM_CHANNEL ??= 'msedge';
console.log(`Stand-in BTS on ${bts.baseUrl} (create .demo/bts-down to simulate an outage)`);
console.log(`Mail catcher: SMTP on 127.0.0.1:${mailCatcher.port}; look at caught email at http://localhost:${mailViewer.port}`);
await import('../src/server.ts');

// A platform console account for the demo (staff accounts have no sign-up), saved in .demo.
const staffFile = `${demoDir}/platform-admin.txt`;
if (!existsSync(staffFile)) {
  const { default: pg } = await import('pg');
  const { pgDatabase } = await import('../src/db/database.ts');
  const { createPlatformAdmin } = await import('../src/db/platform.ts');
  const db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }));
  const exists = (await db.query<{ n: number }>(`select count(*)::int as n from platform_admins where lower(email) = 'staff@demo.test'`)).rows[0]!.n > 0;
  if (!exists) {
    const password = randomBytes(12).toString('base64url');
    await createPlatformAdmin(db, { email: 'staff@demo.test', name: 'Demo Staff', password });
    writeFileSync(staffFile, `Platform console: http://localhost:${process.env.PORT}/admin\nEmail: staff@demo.test\nPassword: ${password}\nThe first sign-in sets up two-step sign-in: scan the QR code with an authenticator app on your phone.\n`, { mode: 0o600 });
  }
  await db.close();
}
console.log(`\n  Open http://localhost:${process.env.PORT}   (platform console: /admin, sign-in in ${staffFile})\n`);
