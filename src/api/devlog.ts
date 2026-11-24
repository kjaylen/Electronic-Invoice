/**
 * What a business's integrations have been doing, so its developer can find
 * out why a call fails without asking us: requests made with its API keys
 * (secret keys on /v1/..., publishable keys on the store API).
 *
 *   GET /v1/developer/usage      requests and failures by day, by key, and failures by endpoint and error code (35 days)
 *   GET /v1/developer/requests   the most recent requests, with their answers
 *
 * Counts are kept in the rate-limit table (it is a table of counters in
 * windows, shared by every server process, swept by housekeeping): one row
 * per day, key, endpoint and outcome. The list of recent requests is kept in
 * this server's memory only (the last 200 per business since it started):
 * a request log that survives restarts needs a table of its own, which this
 * change does not add (see DECISIONS.md).
 *
 * Only the path is kept, never the query (it can carry an order's link token)
 * or anything from a body.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listPublishableKeys } from '../commerce/connect.ts';
import type { Queryable } from '../db/database.ts';
import { countHit } from '../db/ratelimit.ts';
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
const RECENT_PER_BUSINESS = 200;
const BUSINESSES_REMEMBERED = 500;

/** The day in Belize (UTC-6, no daylight saving). */
export const belizeDay = (at = Date.now()) => new Date(at - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);

const counterKey = (tenantId: string, day: string, key: KeyRef, method: string, route: string, status: number, code: string | null) =>
  ['usage', tenantId, day, `${key.kind}:${key.id}`, `${method} ${route}`, String(status), code ?? ''].join('|');

export interface DevLog {
  /** Record a finished request. Never throws, never waits on the database. */
  record(db: Queryable, tenantId: string, entry: LoggedRequest): void;
  recent(tenantId: string): LoggedRequest[];
  readonly since: string;
}

export function createDevLog(): DevLog {
  const recent = new Map<string, LoggedRequest[]>();
  return {
    since: new Date().toISOString(),
    record(db, tenantId, entry) {
      const list = recent.get(tenantId) ?? [];
      // Most recently used business last, so the least recently used is the first to go.
      recent.delete(tenantId);
      recent.set(tenantId, list);
      list.push(entry);
      if (list.length > RECENT_PER_BUSINESS) list.shift();
      if (recent.size > BUSINESSES_REMEMBERED) recent.delete(recent.keys().next().value!);
      void countHit(db, counterKey(tenantId, belizeDay(), entry.key, entry.method, entry.route, entry.status, entry.code), USAGE_DAYS * DAY_MS).catch(() => {});
    },
    recent: (tenantId) => [...(recent.get(tenantId) ?? [])].reverse(),
  };
}

/** Record every request an integration made, once it has been answered. */
export function registerDevLogHook(app: FastifyInstance, db: Queryable, log: DevLog) {
  app.addHook('onResponse', async (request, reply) => {
    const who = request.integration;
    if (!who) return;
    const failed = reply.statusCode >= 400;
    log.record(db, who.tenantId, {
      at: new Date().toISOString(),
      method: request.method,
      path: request.url.split('?')[0]!,
      route: request.routeOptions.url ?? request.url.split('?')[0]!,
      status: reply.statusCode,
      code: failed ? request.apiError?.code ?? null : null,
      message: failed ? request.apiError?.message ?? null : null,
      ms: Math.round(reply.elapsedTime),
      key: who.key,
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : null,
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

  app.get<{ Querystring: { errors?: string; key?: string } }>(
    '/developer/requests',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { errors: { type: 'string', enum: ['1'] }, key: { type: 'string', maxLength: 40 } } } } },
    async (request) => {
      requirePersonWith(request, 'apikeys.manage');
      const names = await keyNames(request.tenantId);
      const rows = log.recent(request.tenantId)
        .filter((r) => (!request.query.errors || r.status >= 400) && (!request.query.key || r.key.id === request.query.key))
        .slice(0, 100);
      return {
        data: rows.map((r) => ({ ...r, key: named(names, r.key) })),
        // Kept by this server since it started; counts by day are in /v1/developer/usage.
        since: log.since,
      };
    },
  );
}
