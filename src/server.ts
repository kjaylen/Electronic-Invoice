/**
 * Server entry point: API plus background worker.
 *
 *   DATABASE_URL         PostgreSQL connection string                      (required)
 *   KEY_ENCRYPTION_KEY   32 random bytes, Base64; encrypts taxpayers' keys (required)
 *   ADMIN_TOKEN          enables /v1/admin; at least 32 characters         (optional)
 *   PORT                 default 3000
 *   HOST                 default 0.0.0.0
 *   WORKER_INTERVAL_MS   default 60000; 0 disables the worker in this process
 *   BTS_BASE_URL         override the BTS host (e.g. a proxy); default per tenant environment
 *   BTS_CA_FILE          extra CA certificate (PEM) to trust for the BTS host (e.g. a test double)
 *   BTS_TIMEOUT_MS       default 30000
 *   WEB_ROOT             built web app to serve; default web/dist when it exists
 *   COOKIE_SECURE        "false" only for local plain-HTTP development; default true
 *   ALLOW_SIGNUP         "false" to close self-service sign-up; default true
 *   PUBLIC_URL           public address of the web app (links in emails, share links), e.g. https://app.example.bz
 *   SMTP_URL             outgoing mail server, e.g. smtps://user:pass@smtp.example.com:465
 *   MAIL_FROM            sender address, e.g. "eInvoicing <no-reply@example.bz>"
 *   MAIL_OUTBOX_DIR      instead of SMTP: write each email as an .eml file here (development)
 *
 *   npm start
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './api/app.ts';
import { startWorker } from './api/worker.ts';
import { migrate, pgDatabase } from './db/database.ts';
import { keyEncryptionKeyFromEnv, localKeyProtector } from './db/keystore.ts';
import { type Mailer, outboxMailer, smtpMailer } from './mail/mailer.ts';
import { cachingClientProvider } from './pipeline/clients.ts';

const env = process.env;
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = pgDatabase(new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_SIZE ?? 20) }));
const applied = await migrate(db);
const clients = cachingClientProvider({
  ...(env.BTS_BASE_URL && { baseUrl: env.BTS_BASE_URL }),
  ...(env.BTS_CA_FILE && { ca: readFileSync(env.BTS_CA_FILE, 'utf8') }),
  timeoutMs: Number(env.BTS_TIMEOUT_MS ?? 30_000),
});
const pipeline = { db, keys: localKeyProtector(keyEncryptionKeyFromEnv(env)), clients };

const defaultWebRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));
const webRoot = env.WEB_ROOT ?? (existsSync(defaultWebRoot) ? defaultWebRoot : undefined);
const mailFrom = env.MAIL_FROM ?? 'eInvoicing <no-reply@localhost>';
const mailer: Mailer | undefined = env.SMTP_URL ? smtpMailer(env.SMTP_URL, mailFrom) : env.MAIL_OUTBOX_DIR ? outboxMailer(env.MAIL_OUTBOX_DIR, mailFrom) : undefined;
const app = await buildApp({
  pipeline,
  ...(mailer && { mailer }),
  ...(env.PUBLIC_URL && { publicUrl: env.PUBLIC_URL }),
  ...(env.ADMIN_TOKEN && { adminToken: env.ADMIN_TOKEN }),
  ...(webRoot && { webRoot }),
  cookieSecure: env.COOKIE_SECURE !== 'false',
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  logger: true,
});
if (applied.length) app.log.info({ applied }, 'database migrations applied');
if (!mailer) app.log.warn('No SMTP_URL or MAIL_OUTBOX_DIR: password reset and emailing documents are off');
if (!env.PUBLIC_URL) app.log.warn('No PUBLIC_URL: password reset, welcome links and share links are off');

const intervalMs = Number(env.WORKER_INTERVAL_MS ?? 60_000);
const worker = intervalMs > 0
  ? startWorker(pipeline, {
      intervalMs,
      onTick: (r) => r.tenants && app.log.info(r, 'worker tick'),
      onError: (tenantId, e) => app.log.error({ tenantId, err: e }, 'worker failure'),
    })
  : undefined;

await app.listen({ port: Number(env.PORT ?? 3000), host: env.HOST ?? '0.0.0.0' });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await worker?.stop();
  await app.close();
  clients.closeAll();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
