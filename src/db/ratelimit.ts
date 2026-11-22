/**
 * Rate limits kept in the database, so every server process shares them
 * (a fixed window per key: the first hit opens the window, it resets after).
 * One statement per hit, atomic under concurrency.
 */

import type { Queryable } from './database.ts';

/** Count a hit. True when this hit is over the limit for the window. */
export async function overLimit(db: Queryable, key: string, limit: number, windowMs: number): Promise<boolean> {
  return (await countHit(db, key, windowMs)) > limit;
}

/** Count a hit without checking (for example a failed sign-in); returns the count in the window. */
export async function countHit(db: Queryable, key: string, windowMs: number): Promise<number> {
  const r = await db.query<{ count: number }>(
    `insert into rate_limits (key, count, reset_at) values ($1, 1, now() + make_interval(secs => $2::double precision / 1000))
     on conflict (key) do update set
       count = case when rate_limits.reset_at <= now() then 1 else rate_limits.count + 1 end,
       reset_at = case when rate_limits.reset_at <= now() then excluded.reset_at else rate_limits.reset_at end
     returning count`,
    [key, windowMs],
  );
  // Now and then, clear out windows long gone (the worker also sweeps).
  if (Math.random() < 0.001) await sweepRateLimits(db);
  return r.rows[0]!.count;
}

/** True when the key already has `limit` hits in its window (does not count this check). */
export async function atLimit(db: Queryable, key: string, limit: number): Promise<boolean> {
  const r = await db.query<{ count: number }>('select count from rate_limits where key = $1 and reset_at > now()', [key]);
  return (r.rows[0]?.count ?? 0) >= limit;
}

/** Forget a key (for example the failures of an account that just signed in). */
export async function clearLimit(db: Queryable, key: string): Promise<void> {
  await db.query('delete from rate_limits where key = $1', [key]);
}

export async function sweepRateLimits(db: Queryable): Promise<number> {
  return (await db.query('delete from rate_limits where reset_at < now() returning key')).rows.length;
}
