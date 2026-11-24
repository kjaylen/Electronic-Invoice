/**
 * The server the browser tests run against: the local demo (stand-in BTS,
 * emails to an outbox folder) on its own port, with a fresh database and
 * demo folder every run, so the tests never touch your demo data.
 *
 * Needs PostgreSQL (docker compose up -d db) and a built web app (npm run web:build).
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const admin = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://einvoicing:einvoicing@localhost:5432/einvoicing';
// E2E_DB: another database, for a second run beside this one (another checkout's tests).
const name = process.env.E2E_DB ?? 'einvoicing_e2e';

const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query(`drop database if exists ${name} with (force)`);
await client.query(`create database ${name}`);
await client.end();

const url = new URL(admin);
url.pathname = `/${name}`;
const demoDir = `${root}.demo-e2e`;
rmSync(demoDir, { recursive: true, force: true });

Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  DEMO_DIR: demoDir,
  PORT: process.env.E2E_PORT ?? '3100',
  DEMO_BTS_PORT: process.env.E2E_BTS_PORT ?? '8543',
  WORKER_INTERVAL_MS: '3000',
  CONNECTOR_INTERVAL_MS: '2000',
});
await import('../scripts/demo.ts');
