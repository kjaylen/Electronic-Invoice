/**
 * What a business's integrations have been doing, so its developer can find
 * out why a call fails without asking us: requests made with its API keys
 * (secret keys on /v1/..., publishable keys on the store API).
 *
 *   GET /v1/developer/usage      requests and failures by day, by key, and failures by endpoint and error code (35 days)
 *   GET /v1/developer/requests   the latest requests with their answers, newest first (errors=1, key, limit, cursor)
 *
 * Counts are kept in the rate-limit table (it is a table of counters in
 * windows, shared by every server process, swept by housekeeping): one row
 * per day, key, endpoint and outcome. The requests themselves are rows of
 * api_requests, kept for a week and at most the newest 10,000 per business.
 *
 * Writing never holds a request up: rows wait in this process and go to the
 * database together, a second later at most (or at once when a hundred are
 * waiting). Reading the log writes what this process is holding first, so a
 * request just made is there.
 *
 * Only the path is kept, never the query (it can carry an order's link token)
 * or anything from a body.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listPublishableKeys } from '../commerce/connect.ts';
import type { Queryable } from '../db/database.ts';
import { countHit } from '../db/ratelimit.ts';
import { ApiError } from './errors.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { requirePersonWith } from './permissions.ts';

export interface KeyRef {
  kind: 'secret' | 'publishable';
  /** The key's id; "unknown" for a publishable key the store does not have. */
  id: string;
}

export interface LoggedRequest {
  at: string;
  method: string;
  path: string;
  /** The endpoint, as the reference names it: "/v1/store/:slug/orders". */
  route: string;
  status: number;
  /** The error's code and message, when it failed. */
  code: string | null;
  message: string | null;
  ms: number;
  key: KeyRef;
  /** The site the page was on, for a call from a browser. */
  origin: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Which integration is calling: set once an API key (of either kind) is recognized. */
    integration: { tenantId: string; key: KeyRef } | null;
    /** The error this request was answered with (set by the error handler). */
    apiError: { code: string; message: string } | null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_DAYS = 35;
/** How long a request stays in the log, and how many one business keeps at most. */
export const LOG_DAYS = 7;
export const LOG_PER_BUSINESS = 10_000;
/** Rows waiting to be written: sent after this long, or when this many wait; never more than this many held (a database that is down loses the oldest). */
const FLUSH_MS = 1000;
const FLUSH_ROWS = 100;
const HELD_AT_MOST = 2000;

/** The day in Belize (UTC-6, no daylight saving). */
export const belizeDay = (at = Date.now()) => new Date(at - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);

const counterKey = (tenantId: string, day: string, key: KeyRef, method: string, route: string, status: number, code: string | null) =>
  ['usage', tenantId, day, `${key.kind}:${key.id}`, `${method} ${route}`, String(status), code ?? ''].join('|');

export interface DevLog {
  /** Record a finished request. Never throws, never waits on the database. */
  record(tenantId: string, entry: LoggedRequest): void;
  /** Write the rows this process is holding, now. */
  flush(): Promise<void>;
  /** Stop the timer and write what is left (the server is closing). */
  stop(): Promise<void>;
}

export function createDevLog(db: Queryable, options: { flushMs?: number } = {}): DevLog {
  let held: Array<{ tenantId: string; entry: LoggedRequest }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const write = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!held.length) return;
    const rows = held;
    held = [];
    const col = <T>(pick: (r: { tenantId: string; entry: LoggedRequest }) => T) => rows.map(pick);
    // One statement for all of them. A row that cannot be written (the database is away) is given up, never retried into a pile;
    // one for a business erased meanwhile is left out, so it cannot take the others with it.
    await db.query(
      `insert into api_requests (tenant_id, key_kind, key_id, at, method, route, path, status, code, message, ms, origin)
       select r.tenant_id, r.key_kind, r.key_id, r.at, r.method, r.route, r.path, r.status, r.code, r.message, r.ms, r.origin
       from unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[], $10::text[], $11::int[], $12::text[])
         with ordinality as r(tenant_id, key_kind, key_id, at, method, route, path, status, code, message, ms, origin, n)
       where exists (select 1 from tenants t where t.id = r.tenant_id)
       order by r.n`,
      [col((r) => r.tenantId), col((r) => r.entry.key.kind), col((r) => r.entry.key.id), col((r) => r.entry.at), col((r) => r.entry.method), col((r) => r.entry.route), col((r) => r.entry.path),
        col((r) => r.entry.status), col((r) => r.entry.code), col((r) => r.entry.message), col((r) => r.entry.ms), col((r) => r.entry.origin)],
    ).catch(() => {});
  };
  // One write at a time, in order.
  const flush = () => (writing = writing.then(write, write));
  return {
    record(tenantId, entry) {
      held.push({ tenantId, entry });
      if (held.length > HELD_AT_MOST) held.shift();
      if (held.length >= FLUSH_ROWS) void flush();
      else if (!timer) {
        timer = setTimeout(() => void flush(), options.flushMs ?? FLUSH_MS);
        timer.unref();
      }
      void countHit(db, counterKey(tenantId, belizeDay(), entry.key, entry.method, entry.route, entry.status, entry.code), USAGE_DAYS * DAY_MS).catch(() => {});
    },
    flush,
    stop: flush,
  };
}

interface RequestRow {
  id: string | number;
  key_kind: KeyRef['kind'];
  key_id: string;
  at: Date | string;
  method: string;
  route: string;
  path: string;
  status: number;
  code: string | null;
  message: string | null;
  ms: number;
  origin: string | null;
}

/** A business's latest requests, newest first: `limit` of them from `before` (an id) back; one more is fetched to know whether there are older ones. */
export async function loggedRequests(db: Queryable, tenantId: string, options: { limit: number; before?: number; failedOnly?: boolean; keyId?: string }): Promise<Array<LoggedRequest & { id: number }>> {
  const rows = (await db.query<RequestRow>(
    `select id, key_kind, key_id, at, method, route, path, status, code, message, ms, origin from api_requests
     where tenant_id = $1 and ($2::bigint is null or id < $2) and (not $3::boolean or status >= 400) and ($4::text is null or key_id = $4)
     order by id desc limit $5`,
    [tenantId, options.before ?? null, Boolean(options.failedOnly), options.keyId ?? null, options.limit],
  )).rows;
  return rows.map((r) => ({
    id: Number(r.id), at: new Date(r.at).toISOString(), method: r.method, path: r.path, route: r.route, status: r.status, code: r.code, message: r.message, ms: r.ms,
    key: { kind: r.key_kind, id: r.key_id }, origin: r.origin,
  }));
}

/** Housekeeping: requests older than a week go, and of what is left each business keeps its newest 10,000. Returns how many rows went. */
export async function pruneLoggedRequests(db: Queryable, options: { days?: number; perBusiness?: number } = {}): Promise<number> {
  const old = (await db.query('delete from api_requests where at < now() - make_interval(days => $1::int) returning id', [options.days ?? LOG_DAYS])).rows.length;
  const cap = options.perBusiness ?? LOG_PER_BUSINESS;
  // Only the businesses over their number are looked at again: the oldest row to keep, and everything before it goes.
  const over = (await db.query<{ tenant_id: string }>('select tenant_id from api_requests group by tenant_id having count(*) > $1', [cap])).rows;
  let extra = 0;
  for (const { tenant_id } of over) {
    extra += (await db.query(
      `delete from api_requests where tenant_id = $1 and id < (select id from api_requests where tenant_id = $1 order by id desc offset $2 limit 1) returning id`,
      [tenant_id, cap - 1],
    )).rows.length;
  }
  return old + extra;
}

/** Record every request an integration made, once it has been answered. */
export function registerDevLogHook(app: FastifyInstance, log: DevLog) {
  app.addHook('onClose', async () => log.stop());
  app.addHook('onResponse', async (request, reply) => {
    const who = request.integration;
    if (!who) return;
    const failed = reply.statusCode >= 400;
    log.record(who.tenantId, {
      at: new Date().toISOString(),
      method: request.method,
      path: request.url.split('?')[0]!.slice(0, 300),
      route: request.routeOptions.url ?? '(no such endpoint)',
      status: reply.statusCode,
      code: failed ? request.apiError?.code ?? null : null,
      message: failed ? request.apiError?.message.slice(0, 500) ?? null : null,
      ms: Math.round(reply.elapsedTime),
      key: who.key,
      origin: typeof request.headers.origin === 'string' ? request.headers.origin.slice(0, 200) : null,
    });
  });
}

interface Counter {
  day: string;
  key: KeyRef;
  method: string;
  route: string;
  status: number;
  code: string | null;
  count: number;
}

async function counters(db: Queryable, tenantId: string): Promise<Counter[]> {
  const rows = (await db.query<{ key: string; count: number }>(`select key, count from rate_limits where key like $1 and reset_at > now()`, [`usage|${tenantId}|%`])).rows;
  const out: Counter[] = [];
  for (const r of rows) {
    const [, , day, key, endpoint, status, code] = r.key.split('|');
    const [kind, id] = (key ?? '').split(':');
    const [method, ...route] = (endpoint ?? '').split(' ');
    if (!day || !id || (kind !== 'secret' && kind !== 'publishable') || !method) continue;
    out.push({ day, key: { kind, id }, method, route: route.join(' '), status: Number(status), code: code || null, count: Number(r.count) });
  }
  return out;
}

export function registerDeveloperRoutes(app: FastifyInstance, deps: PipelineDeps, log: DevLog) {
  const { db } = deps;

  /** The names of the business's keys, by kind and id. */
  const keyNames = async (tenantId: string) => {
    const names = new Map<string, { name: string; revoked: boolean }>();
    for (const k of (await db.query<{ id: string; name: string; revoked_at: unknown }>('select id, name, revoked_at from api_keys where tenant_id = $1', [tenantId])).rows) names.set(`secret:${k.id}`, { name: k.name, revoked: Boolean(k.revoked_at) });
    for (const k of (await listPublishableKeys(db, tenantId)).keys) names.set(`publishable:${k.id}`, { name: k.name, revoked: Boolean(k.revokedAt) });
    return names;
  };
  const named = (names: Map<string, { name: string; revoked: boolean }>, key: KeyRef) => ({
    kind: key.kind, id: key.id,
    name: names.get(`${key.kind}:${key.id}`)?.name ?? (key.id === 'unknown' ? 'A key this store does not have' : 'A key since removed'),
    revoked: names.get(`${key.kind}:${key.id}`)?.revoked ?? false,
  });

  app.get<{ Querystring: { days?: string } }>(
    '/developer/usage',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { days: { type: 'string', pattern: '^\\d{1,2}$' } } } } },
    async (request: FastifyRequest<{ Querystring: { days?: string } }>) => {
      requirePersonWith(request, 'apikeys.manage');
      const days = Math.min(USAGE_DAYS, Math.max(1, Number(request.query.days ?? 14)));
      const today = belizeDay();
      const dates = Array.from({ length: days }, (_, i) => belizeDay(Date.now() - (days - 1 - i) * DAY_MS));
      const all = (await counters(db, request.tenantId)).filter((c) => c.day >= dates[0]! && c.day <= today);
      const names = await keyNames(request.tenantId);
      const isError = (c: Counter) => c.status >= 400;
      const sum = (list: Counter[]) => list.reduce((n, c) => n + c.count, 0);
      const byKey = new Map<string, Counter[]>();
      for (const c of all) byKey.set(`${c.key.kind}:${c.key.id}`, [...(byKey.get(`${c.key.kind}:${c.key.id}`) ?? []), c]);
      const byFailure = new Map<string, Counter[]>();
      for (const c of all.filter(isError)) {
        const k = [c.key.kind, c.key.id, c.method, c.route, c.status, c.code ?? ''].join('|');
        byFailure.set(k, [...(byFailure.get(k) ?? []), c]);
      }
      return {
        days: dates.map((date) => {
          const of = all.filter((c) => c.day === date);
          return { date, requests: sum(of), errors: sum(of.filter(isError)) };
        }),
        totals: { requests: sum(all), errors: sum(all.filter(isError)) },
        keys: [...byKey.values()].map((list) => ({
          ...named(names, list[0]!.key), requests: sum(list), errors: sum(list.filter(isError)),
          lastDay: list.map((c) => c.day).sort().at(-1)!,
        })).sort((a, b) => b.requests - a.requests),
        // What fails, most often first: which endpoint, how it was answered, with which key.
        failures: [...byFailure.values()].map((list) => ({
          key: named(names, list[0]!.key), method: list[0]!.method, route: list[0]!.route, status: list[0]!.status, code: list[0]!.code,
          count: sum(list), lastDay: list.map((c) => c.day).sort().at(-1)!,
        })).sort((a, b) => b.count - a.count).slice(0, 50),
      };
    },
  );

  app.get<{ Querystring: { errors?: string; key?: string; limit?: string; cursor?: string } }>(
    '/developer/requests',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { errors: { type: 'string', enum: ['1'] }, key: { type: 'string', maxLength: 40 }, limit: { type: 'string', pattern: '^\\d{1,3}$' }, cursor: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (request) => {
      requirePersonWith(request, 'apikeys.manage');
      const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100)));
      let before: number | undefined;
      if (request.query.cursor) {
        const m = /^r:(\d{1,18})$/.exec(Buffer.from(request.query.cursor, 'base64url').toString('utf8'));
        if (!m) throw new ApiError(400, 'invalid_request', 'cursor is not one this API gave out. Send the nextCursor of the page before, unchanged.');
        before = Number(m[1]);
      }
      // What this process is still holding goes in first, so a request made a moment ago is in the answer.
      await log.flush();
      const names = await keyNames(request.tenantId);
      const rows = await loggedRequests(db, request.tenantId, { limit: limit + 1, ...(before !== undefined && { before }), failedOnly: Boolean(request.query.errors), ...(request.query.key && { keyId: request.query.key }) });
      const page = rows.slice(0, limit);
      return {
        data: page.map(({ id: _id, ...r }) => ({ ...r, key: named(names, r.key) })),
        nextCursor: rows.length > limit ? Buffer.from(`r:${page.at(-1)!.id}`).toString('base64url') : null,
        // How long a request stays in the log; counts by day (35 days) are in /v1/developer/usage.
        keptDays: LOG_DAYS,
      };
    },
  );
}
