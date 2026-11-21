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
 *   BTS_TIMEOUT_MS       default 30000
 *
 *   npm start
 */

import pg from 'pg';
import { buildApp } from './api/app.ts';
import { startWorker } from './api/worker.ts';
import { migrate, pgDatabase } from './db/database.ts';
import { keyEncryptionKeyFromEnv, localKeyProtector } from './db/keystore.ts';
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
  timeoutMs: Number(env.BTS_TIMEOUT_MS ?? 30_000),
});
const pipeline = { db, keys: localKeyProtector(keyEncryptionKeyFromEnv(env)), clients };

const app = await buildApp({ pipeline, ...(env.ADMIN_TOKEN && { adminToken: env.ADMIN_TOKEN }), logger: true });
if (applied.length) app.log.info({ applied }, 'database migrations applied');

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
