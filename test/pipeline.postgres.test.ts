/**
 * The pipeline against a real PostgreSQL server, with many connections at once.
 * PGlite (used by the other tests) runs one connection at a time, so only this
 * test proves the per-series row lock holds under true parallel load.
 *
 *   docker compose up -d db
 *   $env:DATABASE_URL = "postgres://einvoicing:einvoicing@localhost:5432/einvoicing"   (PowerShell)
 *   npm test
 *
 * Each run works in its own throwaway schema and drops it afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pgDatabase } from '../src/db/database.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { issueDocument } from '../src/pipeline/issue.ts';
import { AUTHORIZED, invoiceRequest, setupPipeline } from './pipeline-setup.ts';

const url = process.env.DATABASE_URL;

test('real PostgreSQL: 40 documents at once over 10 connections keep every series gap-free and chained', { skip: !url && 'set DATABASE_URL to run' }, async () => {
  const schema = `etd_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  const f = await setupPipeline(pgDatabase(pool));
  try {
    f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const jobs = Array.from({ length: 40 }, (_, i) => ({
      tenant: i % 2 === 0 ? f.tenantA : f.tenantB,
      seriesNumber: i % 4 < 2 ? 1 : 2,
    }));
    const results = await Promise.all(jobs.map((j) => issueDocument(f.deps, j.tenant, invoiceRequest({ seriesNumber: j.seriesNumber }))));
    assert.ok(results.every((r) => r.status === 'authorized'));

    const rows = (
      await f.db.query<{ tenant_id: string; series_number: number; serial: string; sequence_hash: string; previous_sequence_hash: string | null }>(
        'select tenant_id, series_number, serial, sequence_hash, previous_sequence_hash from documents order by tenant_id, series_number, serial',
      )
    ).rows;
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.tenant_id}:${r.series_number}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    assert.equal(groups.size, 4);
    for (const [key, group] of groups) {
      assert.deepEqual(group.map((r) => Number(r.serial)), Array.from({ length: group.length }, (_, i) => i + 1), `${key}: serials 1..n, no gaps or duplicates`);
      for (let i = 1; i < group.length; i++) {
        assert.equal(group[i]!.previous_sequence_hash, group[i - 1]!.sequence_hash, `${key}: chain link ${i}`);
      }
    }
  } finally {
    await f.close();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});
