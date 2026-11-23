/**
 * Operations: heartbeats from the background loops, an overall status
 * (database, worker, the BTS queue, certificates), Prometheus metrics, and
 * alerts to a webhook (Slack, Teams, Discord or anything that takes JSON)
 * when something needs a person: sent when a problem starts and when it ends.
 */

import type { Queryable } from '../db/database.ts';

// ---------- in-process request counters (per server process) ----------

export const counters = {
  requests: 0,
  serverErrors: 0,
  startedAt: Date.now(),
};

// ---------- heartbeats ----------

export async function heartbeat(db: Queryable, name: string, details?: Record<string, unknown>): Promise<void> {
  await db.query(
    `insert into worker_heartbeats (name, at, details) values ($1, now(), $2)
     on conflict (name) do update set at = excluded.at, details = excluded.details`,
    [name, details ? JSON.stringify(details) : null],
  );
}

// ---------- status ----------

export interface OpsThresholds {
  /** The worker is stale when its last beat is older than this. Default 5 minutes. */
  workerStaleMs?: number;
  /** A normal document still pending after this long is "stuck". Default 15 minutes. */
  stuckPendingMs?: number;
  /** More contingency documents than this waiting is an alert. Default 500. */
  contingencyQueueLimit?: number;
  /** Certificates expiring within this many days are listed. Default 7. */
  certificateDays?: number;
}

export interface OpsStatus {
  status: 'ok' | 'degraded';
  database: boolean;
  worker: { lastBeatAt: string | null; ageSeconds: number | null; stale: boolean };
  queue: { pending: number; stuckPending: number; contingencyPending: number; openOutages: number; oldestPendingMinutes: number | null };
  certificates: { expiringSoon: number; expired: number };
  problems: Array<{ key: string; message: string }>;
}

export async function opsStatus(db: Queryable, t: OpsThresholds = {}): Promise<OpsStatus> {
  const workerStaleMs = t.workerStaleMs ?? 5 * 60_000;
  const stuckMs = t.stuckPendingMs ?? 15 * 60_000;
  const beat = (await db.query<{ at: Date }>("select at from worker_heartbeats where name = 'worker'")).rows[0];
  const q = (await db.query<{ pending: number; stuck: number; contingency: number; outages: number; oldest: Date | null }>(
    `select
       (select count(*)::int from documents where status = 'pending') as pending,
       (select count(*)::int from documents where status = 'pending' and created_at < now() - make_interval(secs => $1::double precision / 1000)) as stuck,
       (select count(*)::int from documents where status = 'contingency_pending') as contingency,
       (select count(*)::int from contingency_periods where ended_at is null) as outages,
       (select min(created_at) from documents where status in ('pending', 'contingency_pending')) as oldest`,
    [stuckMs],
  )).rows[0]!;
  const c = (await db.query<{ soon: number; expired: number }>(
    `select count(*) filter (where valid_to >= now() and valid_to < now() + make_interval(days => $1))::int as soon,
            count(*) filter (where valid_to < now())::int as expired
     from certificates where status = 'active'`,
    [t.certificateDays ?? 7],
  )).rows[0]!;
  const age = beat ? Math.round((Date.now() - new Date(beat.at).getTime()) / 1000) : null;
  const stale = age === null || age * 1000 > workerStaleMs;
  const problems: OpsStatus['problems'] = [];
  if (stale) problems.push({ key: 'worker_stale', message: age === null ? 'The background worker has never reported in' : `The background worker last reported ${Math.round(age / 60)} minutes ago` });
  if (q.stuck > 0) problems.push({ key: 'documents_stuck', message: `${q.stuck} document(s) pending with BTS for more than ${Math.round(stuckMs / 60_000)} minutes` });
  if (q.contingency > (t.contingencyQueueLimit ?? 500)) problems.push({ key: 'contingency_queue', message: `${q.contingency} contingency documents waiting to be sent to BTS` });
  if (c.expired > 0) problems.push({ key: 'certificates_expired', message: `${c.expired} business(es) have an expired BTS certificate` });
  return {
    status: problems.length ? 'degraded' : 'ok',
    database: true,
    worker: { lastBeatAt: beat ? new Date(beat.at).toISOString() : null, ageSeconds: age, stale },
    queue: {
      pending: q.pending, stuckPending: q.stuck, contingencyPending: q.contingency, openOutages: q.outages,
      oldestPendingMinutes: q.oldest ? Math.round((Date.now() - new Date(q.oldest).getTime()) / 60_000) : null,
    },
    certificates: { expiringSoon: c.soon, expired: c.expired },
    problems,
  };
}

/** Prometheus text exposition of the status and this process's counters. */
export function metricsText(s: OpsStatus): string {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: 'gauge' | 'counter', value: number) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };
  metric('floreo_up', 'The server and database answer', 'gauge', s.database ? 1 : 0);
  metric('floreo_degraded', 'Something needs attention (see /metrics problems)', 'gauge', s.status === 'degraded' ? 1 : 0);
  metric('floreo_worker_heartbeat_age_seconds', 'Seconds since the background worker last reported', 'gauge', s.worker.ageSeconds ?? -1);
  metric('floreo_documents_pending', 'Documents waiting for a BTS answer', 'gauge', s.queue.pending);
  metric('floreo_documents_stuck', 'Documents pending longer than the threshold', 'gauge', s.queue.stuckPending);
  metric('floreo_documents_contingency', 'Contingency documents waiting to be sent', 'gauge', s.queue.contingencyPending);
  metric('floreo_outages_open', 'Businesses currently in contingency mode', 'gauge', s.queue.openOutages);
  metric('floreo_certificates_expiring_soon', 'Active certificates expiring within 7 days', 'gauge', s.certificates.expiringSoon);
  metric('floreo_certificates_expired', 'Active certificates already expired', 'gauge', s.certificates.expired);
  metric('floreo_http_requests_total', 'HTTP requests served by this process', 'counter', counters.requests);
  metric('floreo_http_server_errors_total', 'HTTP 5xx responses from this process', 'counter', counters.serverErrors);
  metric('floreo_process_uptime_seconds', 'Seconds since this process started', 'gauge', Math.round((Date.now() - counters.startedAt) / 1000));
  return `${lines.join('\n')}\n`;
}

// ---------- alerts ----------

export interface AlertOptions {
  webhookUrl: string;
  /** Shown in the message, e.g. "production". */
  environment?: string;
  fetch?: typeof fetch;
}

/**
 * Post a message when a problem starts and when it is resolved. Problems are
 * remembered in notifications_sent (key "alert:<problem>"), so several
 * processes do not repeat them and a restart does not re-send.
 */
export async function sendAlerts(db: Queryable, status: OpsStatus, options: AlertOptions): Promise<{ fired: string[]; resolved: string[] }> {
  const post = options.fetch ?? fetch;
  const where = options.environment ? ` (${options.environment})` : '';
  const active = new Set(status.problems.map((p) => `alert:${p.key}`));
  const known = new Set((await db.query<{ key: string }>("select key from notifications_sent where key like 'alert:%'")).rows.map((r) => r.key));
  const fired: string[] = [];
  const resolved: string[] = [];
  const say = async (text: string) => {
    const res = await post(options.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
    if (!res.ok) throw new Error(`Alert webhook answered ${res.status}`);
  };
  for (const p of status.problems) {
    const key = `alert:${p.key}`;
    if (known.has(key)) continue;
    const claimed = await db.query("insert into notifications_sent (key) values ($1) on conflict do nothing returning key", [key]);
    if (!claimed.rows.length) continue;
    try {
      await say(`:rotating_light: Floreo${where}: ${p.message}`);
      fired.push(p.key);
    } catch (e) {
      await db.query('delete from notifications_sent where key = $1', [key]);
      throw e;
    }
  }
  for (const key of known) {
    if (active.has(key)) continue;
    const gone = await db.query('delete from notifications_sent where key = $1 returning key', [key]);
    if (!gone.rows.length) continue;
    await say(`:white_check_mark: Floreo${where}: resolved (${key.slice('alert:'.length).replace(/_/g, ' ')})`);
    resolved.push(key.slice('alert:'.length));
  }
  return { fired, resolved };
}
