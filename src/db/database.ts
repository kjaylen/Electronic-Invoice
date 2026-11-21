/**
 * A small database interface the pipeline is written against, with adapters
 * for node-postgres (production) and PGlite (tests: real PostgreSQL compiled
 * to WebAssembly, no server needed).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run a script of several statements, without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Run fn in a transaction; commit if it resolves, roll back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Adapter for a node-postgres Pool. */
export function pgDatabase(pool: Pool): Database {
  return {
    query: async (sql, params) => pool.query(sql, params) as never,
    exec: async (sql) => void (await pool.query(sql)),
    async transaction(fn) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({
          query: async (sql, params) => client.query(sql, params) as never,
          exec: async (sql) => void (await client.query(sql)),
        });
        await client.query('commit');
        return result;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Structural type for PGlite, so production code does not depend on it. */
interface PGliteTx {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<unknown>;
}
export interface PGliteLike extends PGliteTx {
  transaction<T>(fn: (tx: PGliteTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgliteDatabase(db: PGliteLike): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    exec: async (sql) => void (await db.exec(sql)),
    transaction: (fn) =>
      db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params), exec: async (sql) => void (await tx.exec(sql)) })),
    close: () => db.close(),
  };
}

/** node-postgres returns bigint columns as strings, PGlite as BigInt; normalize to BigInt. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`Expected an integer from the database, got ${String(value)}`);
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Apply migrations/NNN_*.sql in order, once each. */
export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
