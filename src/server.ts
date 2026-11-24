/**
 * Server entry point: API plus background worker.
 *
 *   DATABASE_URL         PostgreSQL connection string                      (required)
 *   KEY_ENCRYPTION_KEY   32 random bytes, Base64; encrypts taxpayers' keys (required)
 *   ADMIN_TOKEN          enables /v1/admin; at least 32 characters         (optional)
 *   PORT                 default 3000
 *   HOST                 default 0.0.0.0
 *   KEY_ENCRYPTION_KEYS_PREVIOUS  older keys still accepted for reading, comma separated (key rotation)
 *   S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_URL, S3_FORCE_PATH_STYLE
 *                        product photos in S3-compatible storage behind a CDN (see src/storage/objects.ts)
 *   PLATFORM_BILLING_TENANT        address (slug) of the platform's own business, which issues subscribers' e-invoices
 *   PLATFORM_PAYMENT_INSTRUCTIONS  how subscribers pay (bank details), shown on the plan page and invoices
 *   API_RATE_LIMIT_PER_MINUTE   requests per minute per API key (default 600)
 *   WEBHOOK_INTERVAL_MS         how often webhooks are sent, from the worker's process (default 5000)
 *   STORE_DOMAIN_TARGET         the host businesses point their store domains at (CNAME), e.g. stores.example.bz
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT   the platform's Intuit app (QuickBooks Online integration); needs PUBLIC_URL
 *   LEGAL_NAME, CONTACT_EMAIL   who runs the service, shown on the pricing, terms and privacy pages
 *   WORKER_INTERVAL_MS   default 60000; 0 disables the worker in this process
 *   HOUSEKEEPING_INTERVAL_MS  default 300000 (notification emails, alerts, clean-up); 0 disables
 *   ALERT_WEBHOOK_URL    post operations alerts here (Slack/Teams/Discord-style JSON with "text")
 *   METRICS_TOKEN        enables GET /metrics with this bearer token (32+ characters)
 *   DEPLOY_ENVIRONMENT   shown in alerts, e.g. "production" or "staging"
 *   BTS_BASE_URL         override the BTS host (e.g. a proxy); default per tenant environment
 *   BTS_CA_FILE          extra CA certificate (PEM) to trust for the BTS host (e.g. a test double)
 *   BTS_TIMEOUT_MS       default 30000
 *   WEB_ROOT             built web app to serve; default web/dist when it exists
 *   COOKIE_SECURE        "false" only for local plain-HTTP development; default true
 *   ALLOW_SIGNUP         "false" to close self-service sign-up; default true
 *   PUBLIC_URL           public address of the web app (links in emails, share links), e.g. https://app.example.bz
 *   SMTP_URL             outgoing mail server, e.g. smtps://user:pass@smtp.example.com:465
 *   MAIL_FROM            sender address, e.g. "Floreo <no-reply@example.bz>"
 *   MAIL_OUTBOX_DIR      instead of SMTP: write each email as an .eml file here (development)
 *   PDF_RENDERER         "chromium" to print documents from the businesses' templates (needs a Chromium:
 *                        `npx playwright install chromium`); unset: the built-in layouts
 *   CHROMIUM_PATH        a Chromium or Chrome to use instead of Playwright's
 *   CHROMIUM_CHANNEL     or an installed browser: "chrome" or "msedge"
 *
 *   npm start
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from './api/app.ts';
import { billingContextFactory } from './api/billing.ts';
import { gatewayOptions, reconcilePayments } from './api/payments.ts';
import { startHousekeeping } from './api/housekeeping.ts';
import { runReminders } from './api/receivables.ts';
import { runRecurring } from './api/recurring.ts';
import { startWorker } from './api/worker.ts';
import { startWebhookDispatcher } from './webhooks/webhooks.ts';
import { objectStoreFromEnv } from './storage/objects.ts';
import { runQuickBooksSync } from './integrations/quickbooks.ts';
import { migrate, pgDatabase } from './db/database.ts';
import { eraseDueBusinesses } from './db/closure.ts';
import { keyringFromEnv } from './db/keystore.ts';
import { type Mailer, noMailer, outboxMailer, smtpMailer } from './mail/mailer.ts';
import { cachingClientProvider } from './pipeline/clients.ts';
import { chromiumRenderer } from './render/browser-pdf.ts';
import { processConnectorImports } from './connectors/imports.ts';
import { pollDueNetSuite } from './connectors/netsuite.ts';

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
const pipeline = { db, keys: keyringFromEnv(env), clients };

const defaultWebRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));
const webRoot = env.WEB_ROOT ?? (existsSync(defaultWebRoot) ? defaultWebRoot : undefined);
const mailFrom = env.MAIL_FROM ?? 'Floreo <no-reply@localhost>';
const mailer: Mailer | undefined = env.SMTP_URL ? smtpMailer(env.SMTP_URL, mailFrom) : env.MAIL_OUTBOX_DIR ? outboxMailer(env.MAIL_OUTBOX_DIR, mailFrom) : undefined;
const objectStore = objectStoreFromEnv(env);
// E-Kyash's API addresses, given by Belize Bank (the same for every merchant).
const ekyash = env.EKYASH_SANDBOX_URL || env.EKYASH_LIVE_URL
  ? { ...(env.EKYASH_SANDBOX_URL && { sandboxUrl: env.EKYASH_SANDBOX_URL }), ...(env.EKYASH_LIVE_URL && { liveUrl: env.EKYASH_LIVE_URL }) }
  : undefined;
const quickbooksApp = env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET
  ? { clientId: env.QBO_CLIENT_ID, clientSecret: env.QBO_CLIENT_SECRET, environment: env.QBO_ENVIRONMENT === 'production' ? 'production' as const : 'sandbox' as const }
  : undefined;
const app = await buildApp({
  pipeline,
  ...(mailer && { mailer }),
  ...(env.PUBLIC_URL && { publicUrl: env.PUBLIC_URL }),
  ...(ekyash && { ekyash }),
  ...(env.ADMIN_TOKEN && { adminToken: env.ADMIN_TOKEN }),
  ...(env.METRICS_TOKEN && { metricsToken: env.METRICS_TOKEN }),
  ...(objectStore && { objectStore }),
  ...(env.API_RATE_LIMIT_PER_MINUTE && { apiRateLimitPerMinute: Number(env.API_RATE_LIMIT_PER_MINUTE) }),
  ...(env.STORE_DOMAIN_TARGET && { storeDomainTarget: env.STORE_DOMAIN_TARGET }),
  ...(quickbooksApp && { quickbooks: quickbooksApp }),
  site: { legalName: env.LEGAL_NAME || 'Altiora Technologies', ...(env.CONTACT_EMAIL && { contactEmail: env.CONTACT_EMAIL }) },
  ...((env.PLATFORM_BILLING_TENANT || env.PLATFORM_PAYMENT_INSTRUCTIONS) && {
    billing: { ...(env.PLATFORM_BILLING_TENANT && { tenantSlug: env.PLATFORM_BILLING_TENANT }), ...(env.PLATFORM_PAYMENT_INSTRUCTIONS && { paymentInstructions: env.PLATFORM_PAYMENT_INSTRUCTIONS }) },
  }),
  ...(webRoot && { webRoot }),
  ...(env.PDF_RENDERER === 'chromium' && { pdfRenderer: chromiumRenderer({ ...(env.CHROMIUM_PATH && { executablePath: env.CHROMIUM_PATH }), ...(env.CHROMIUM_CHANNEL && { channel: env.CHROMIUM_CHANNEL }) }) }),
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

const billingSettings = { ...(env.PLATFORM_BILLING_TENANT && { tenantSlug: env.PLATFORM_BILLING_TENANT }), ...(env.PLATFORM_PAYMENT_INSTRUCTIONS && { paymentInstructions: env.PLATFORM_PAYMENT_INSTRUCTIONS }) };
const backgroundCtx = {
  mailer: mailer ?? noMailer,
  mailConfigured: Boolean(mailer),
  ...(env.PUBLIC_URL && { publicUrl: env.PUBLIC_URL }),
  cookieSecure: env.COOKIE_SECURE !== 'false',
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  billing: billingSettings,
};
const billing = billingContextFactory(pipeline, backgroundCtx);
const slugOf = async (tenantId: string) => (await db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
const housekeepingMs = Number(env.HOUSEKEEPING_INTERVAL_MS ?? 300_000);
const housekeeping = housekeepingMs > 0
  ? startHousekeeping(db, {
      intervalMs: housekeepingMs,
      billing,
      reconcilePayments: () => reconcilePayments(pipeline, backgroundCtx, gatewayOptions(pipeline, slugOf, { ...(env.PUBLIC_URL && { publicUrl: env.PUBLIC_URL }), ...(ekyash && { ekyash }) })),
      reminders: () => runReminders(pipeline, backgroundCtx, { ...(ekyash && { ekyash }) }),
      recurring: () => runRecurring(pipeline, backgroundCtx, { ...(ekyash && { ekyash }) }),
      // Businesses their owners closed more than 30 days ago are erased for good.
      eraseClosed: async () => {
        for (const e of await eraseDueBusinesses(db, { ...(objectStore && { objects: objectStore }), onError: (id, err) => app.log.error({ tenantId: id, err }, 'could not erase a closed business') })) app.log.info({ slug: e.slug, rows: e.rows, files: e.files }, 'closed business erased');
      },
      ...(mailer && { mailer }),
      ...(env.PUBLIC_URL && { publicUrl: env.PUBLIC_URL }),
      ...(env.ALERT_WEBHOOK_URL && { alertWebhookUrl: env.ALERT_WEBHOOK_URL }),
      ...(env.DEPLOY_ENVIRONMENT && { environment: env.DEPLOY_ENVIRONMENT }),
      onError: (step, e) => app.log.error({ step, err: e }, 'housekeeping failure'),
    })
  : undefined;

// Webhooks go out from the process that runs the worker.
const webhooks = intervalMs > 0
  ? startWebhookDispatcher(db, {
      keys: pipeline.keys,
      intervalMs: Number(env.WEBHOOK_INTERVAL_MS ?? 5_000),
      onError: (e) => app.log.error({ err: e }, 'webhook dispatch failure'),
      onDisabled: async (tenantId, endpointId, url) => app.log.warn({ tenantId, endpointId, url }, 'webhook endpoint switched off after repeated failures'),
    })
  : undefined;

// Accounting integrations sync from the worker's process too.
let syncing = false;
const integrationTimer = intervalMs > 0 && quickbooksApp && env.PUBLIC_URL
  ? setInterval(() => {
      if (syncing) return;
      syncing = true;
      const config = { ...quickbooksApp, redirectUri: `${env.PUBLIC_URL!.replace(/\/$/, '')}/v1/integrations/quickbooks/callback` };
      void runQuickBooksSync({ db, keys: pipeline.keys, config })
        .then((r) => (r.synced || r.failed) && app.log.info(r, 'quickbooks sync'))
        .catch((e) => app.log.error({ err: e }, 'quickbooks sync failure'))
        .finally(() => (syncing = false));
    }, Number(env.INTEGRATION_SYNC_INTERVAL_MS ?? 60_000))
  : undefined;
integrationTimer?.unref();

// Documents picked up by connectors (QuickBooks Desktop and Point of Sale) are issued here, a few at a time.
let importing = false;
const connectorTimer = intervalMs > 0
  ? setInterval(() => {
      if (importing) return;
      importing = true;
      void processConnectorImports(pipeline)
        .then((r) => (r.issued || r.held || r.rejected) && app.log.info(r, 'connector imports'))
        .catch((e) => app.log.error({ err: e }, 'connector imports failure'))
        .finally(() => (importing = false));
    }, Number(env.CONNECTOR_INTERVAL_MS ?? 10_000))
  : undefined;
connectorTimer?.unref();

// NetSuite accounts are read here: each every 5 minutes (NETSUITE_POLL_MINUTES), or at once when asked.
let readingNetSuite = false;
const netsuiteTimer = intervalMs > 0
  ? setInterval(() => {
      if (readingNetSuite) return;
      readingNetSuite = true;
      void pollDueNetSuite(pipeline, { everyMinutes: Number(env.NETSUITE_POLL_MINUTES ?? 5) })
        .then((r) => (r.picked || r.written || r.errors) && app.log.info(r, 'netsuite'))
        .catch((e) => app.log.error({ err: e }, 'netsuite failure'))
        .finally(() => (readingNetSuite = false));
    }, Number(env.NETSUITE_INTERVAL_MS ?? 15_000))
  : undefined;
netsuiteTimer?.unref();

await app.listen({ port: Number(env.PORT ?? 3000), host: env.HOST ?? '0.0.0.0' });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await worker?.stop();
  await webhooks?.stop();
  if (integrationTimer) clearInterval(integrationTimer);
  if (connectorTimer) clearInterval(connectorTimer);
  if (netsuiteTimer) clearInterval(netsuiteTimer);
  await housekeeping?.stop();
  await app.close();
  clients.closeAll();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
