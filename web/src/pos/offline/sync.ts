/**
 * Sending what the till did to the server, and keeping its copy of the
 * catalog fresh.
 *
 *  - Oldest first, 50 events a call, to POST /v1/pos/sync with the till's own token (so it catches up
 *    even when nobody is signed in). Each event has the id the till gave it; the server does each id
 *    once and answers a repeat with its first result, so sending again is always safe: after a lost
 *    answer, a dropped connection, the app killed mid-call.
 *  - An event is marked sent only when the server says so (applied or duplicate). Until then it stays
 *    on the disk and is sent again: after a restart, a crash, an update.
 *  - A failure the server says may pass (it could not sign, the database was busy) holds the rest back,
 *    in order, and is tried again later: 2 s, 4 s, 8 s... up to 2 minutes, with some randomness so many
 *    tills do not all come back at once. One that cannot pass (the event is wrong) is set aside for a
 *    manager (the sync screen says why, and can try it again) and the rest go on.
 *  - Only one sender at a time, also across windows (Web Locks).
 */

import { ApiError } from '../../api';
import type { OutboxRow, TillDb } from './db';
import type { LocalApi } from './local';
import type { Snapshot, SyncEvent } from './types';

const BATCH = 50;
// At most 2 minutes between tries: a till whose server comes back catches up soon after.
const MAX_BACKOFF_MS = 2 * 60_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const PING_ONLINE_MS = 60_000;
const PING_OFFLINE_MS = 15_000;

export type SyncPhase = 'online' | 'offline' | 'syncing';

export interface SyncState {
  phase: SyncPhase;
  /** Waiting to be sent. */
  pending: number;
  /** Set aside: the server refused them (see the sync screen). */
  failed: number;
  lastSyncAt: string | null;
  /** The last time the till reached the server. */
  lastContactAt: string | null;
  lastError: string | null;
  /** The till was removed or paired again: it cannot send anything any more. */
  unpaired: boolean;
}

interface ServerResult {
  id: string;
  status: 'applied' | 'duplicate' | 'failed' | 'not_processed';
  retry?: boolean;
  error?: { code: string; message: string };
  document?: { id: string; etdui: string; status: string };
  warnings?: string[];
  shift?: { number: number };
}

export interface SyncDeps {
  db: TillDb;
  local: LocalApi;
  /** The till's server and its own token. */
  server(): { baseUrl: string; deviceToken: string } | null;
  installId: string;
  /** A new snapshot arrived (the catalog, the people, the series). */
  onSnapshot(s: Snapshot): Promise<void>;
  onChange(s: SyncState): void;
}

export class SyncEngine {
  private state: SyncState = { phase: navigator.onLine ? 'online' : 'offline', pending: 0, failed: 0, lastSyncAt: null, lastContactAt: null, lastError: null, unpaired: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;
  private backoffMs = 0;
  private lastSnapshotAt = 0;
  private stopped = false;
  private readonly onOnline = () => this.kick();
  private readonly onOffline = () => this.set({ phase: 'offline' });

  constructor(private readonly deps: SyncDeps) {}

  get current(): SyncState {
    return this.state;
  }

  get online(): boolean {
    return this.state.phase !== 'offline';
  }

  async start() {
    this.stopped = false;
    // Paired again after being removed: a new token, so try again.
    this.state = { ...this.state, unpaired: false, lastError: null };
    this.state.lastSyncAt = (await this.deps.db.meta<string>('lastSyncAt')) ?? null;
    this.state.lastContactAt = (await this.deps.db.meta<string>('lastContactAt')) ?? null;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    await this.count();
    this.kick();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Send now (something was sold, the connection came back, a manager asked). */
  kick() {
    if (this.stopped) return;
    this.backoffMs = 0;
    this.schedule(0);
  }

  /** Send now and wait for it (before a call that needs the server to know the till's sales). */
  async flush(): Promise<void> {
    await this.run();
  }

  /** A manager tries set-aside events again. */
  async retry(ids?: string[]) {
    const failed = await this.deps.db.outbox('failed');
    const rows = failed.filter((r) => !ids || ids.includes(r.id)).map((r) => ({ ...r, status: 'pending' as const, lastError: null }));
    if (rows.length) await this.deps.db.write({ outboxUpdates: rows });
    await this.count();
    this.kick();
  }

  /** The device's clock against the server's (receipts show the server's time). */
  static clockOffset = 0;

  private set(patch: Partial<SyncState>) {
    // The device saying it has no network wins: an answer that was already on its way when the
    // connection dropped does not make the till look online.
    if (patch.phase && patch.phase !== 'offline' && navigator.onLine === false) patch = { ...patch, phase: 'offline' };
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private async count() {
    const { pending, failed } = await this.deps.db.outboxCounts();
    this.set({ pending, failed });
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private next() {
    // Something to send: soon, or after the backoff. Nothing: check in now and then.
    const waiting = this.state.pending > 0;
    if (waiting && this.backoffMs === 0) return this.schedule(0);
    if (waiting) return this.schedule(this.backoffMs);
    this.schedule(this.online ? PING_ONLINE_MS : PING_OFFLINE_MS);
  }

  private grow() {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : 2000);
    // ±20%, so tills that lost the server together do not all come back in the same second.
    this.backoffMs = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4));
  }

  private async call(path: string, init: { method?: string; body?: unknown; timeoutMs: number }): Promise<Response> {
    const server = this.deps.server();
    if (!server) throw new ApiError(0, 'not_paired', 'This till is not paired');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), init.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        credentials: 'omit',
        headers: { 'X-Requested-With': 'etd-web', Authorization: `Bearer ${server.deviceToken}`, ...(init.body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: abort.signal,
      });
      // Reached the server: the clock, and that it is online.
      const date = res.headers.get('Date');
      if (date && !Number.isNaN(Date.parse(date))) {
        const middle = started + (Date.now() - started) / 2;
        // The Date header has whole seconds: only trust a difference larger than that.
        const offset = Date.parse(date) - middle;
        SyncEngine.clockOffset = Math.abs(offset) > 90_000 ? offset : 0;
      }
      const at = new Date().toISOString();
      void this.deps.db.write({ meta: { lastContactAt: at, clockOffset: SyncEngine.clockOffset } });
      this.set({ phase: this.state.phase === 'offline' ? 'online' : this.state.phase, lastContactAt: at });
      if (res.status === 401) this.set({ unpaired: true, lastError: 'This till was removed or paired again' });
      return res;
    } catch (e) {
      this.set({ phase: 'offline' });
      throw new ApiError(0, 'network', (e as Error).name === 'AbortError' ? 'The server took too long to answer' : 'Cannot reach the server');
    } finally {
      clearTimeout(timer);
    }
  }

  /** The catalog, the people, the series, the open shift: fetched again now and then. */
  async refreshSnapshot(force = false): Promise<Snapshot | null> {
    if (!force && Date.now() - this.lastSnapshotAt < SNAPSHOT_EVERY_MS) return null;
    const res = await this.call(`/v1/pos/snapshot?install=${this.deps.installId}`, { timeoutMs: 30_000 });
    if (!res.ok) throw new ApiError(res.status, 'snapshot', `The server answered ${res.status}`);
    const snap = (await res.json()) as Snapshot;
    this.lastSnapshotAt = Date.now();
    await this.deps.onSnapshot(snap);
    return snap;
  }

  async run(): Promise<void> {
    if (this.stopped || this.state.unpaired) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      const work = () => this.send();
      await (navigator.locks ? navigator.locks.request('floreo-till-sync', work) : work());
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      } else {
        this.next();
      }
    }
  }

  private async send(): Promise<void> {
    const db = this.deps.db;
    // What waits, shown at once (a sale just made offline counts before any upload is tried).
    await this.count();
    let sent = false;
    for (;;) {
      const batch = await db.outbox('pending', BATCH);
      if (!batch.length) break;
      sent = true;
      this.set({ phase: 'syncing' });
      let results: ServerResult[];
      try {
        const events = await Promise.all(batch.map((r) => db.open<SyncEvent>(r.payload)));
        const res = await this.call('/v1/pos/sync', { method: 'POST', body: { events }, timeoutMs: 120_000 });
        if (res.status === 400 && batch.length > 1) {
          // The batch was refused as a whole: send one at a time to find the one at fault.
          await this.sendOne(batch[0]!);
          continue;
        }
        if (res.status === 400) {
          await this.setAside(batch[0]!, { code: 'invalid', message: await errorText(res) });
          continue;
        }
        if (!res.ok) throw new ApiError(res.status, 'sync', await errorText(res));
        results = ((await res.json()) as { results: ServerResult[] }).results;
      } catch (e) {
        await this.failedTry(batch, e instanceof Error ? e.message : String(e));
        return;
      }
      const stop = await this.apply(batch, results);
      await this.count();
      if (stop) return;
    }
    // Nothing waiting. The catalog now and then; otherwise a quick check that the server is there.
    let reached = sent;
    try {
      reached = Boolean(await this.refreshSnapshot()) || sent || (await this.ping());
    } catch {
      reached = false;
    }
    if (!reached) return;
    this.backoffMs = 0;
    const at = new Date().toISOString();
    await db.write({ meta: { lastSyncAt: at } });
    this.set({ phase: 'online', lastSyncAt: at, lastError: null });
    await this.count();
    await db.prune().catch(() => {});
  }

  private async sendOne(row: OutboxRow) {
    const event = await this.deps.db.open<SyncEvent>(row.payload);
    const res = await this.call('/v1/pos/sync', { method: 'POST', body: { events: [event] }, timeoutMs: 60_000 });
    if (res.status === 400) return this.setAside(row, { code: 'invalid', message: await errorText(res) });
    if (!res.ok) throw new ApiError(res.status, 'sync', await errorText(res));
    await this.apply([row], ((await res.json()) as { results: ServerResult[] }).results);
  }

  private async setAside(row: OutboxRow, error: { code: string; message: string }) {
    await this.deps.db.write({ outboxUpdates: [{ ...row, status: 'failed', attempts: row.attempts + 1, lastTriedAt: new Date().toISOString(), lastError: error }] });
    await this.count();
  }

  private async failedTry(batch: OutboxRow[], message: string) {
    const first = batch[0]!;
    await this.deps.db.write({ outboxUpdates: [{ ...first, attempts: first.attempts + 1, lastTriedAt: new Date().toISOString(), lastError: { code: 'retry', message } }] });
    this.grow();
    this.set({ phase: this.state.phase === 'syncing' ? 'online' : this.state.phase, lastError: message });
    await this.count();
  }

  /** The server's answers: sent, set aside, or to try again (which holds the rest back). Returns true to stop. */
  private async apply(batch: OutboxRow[], results: ServerResult[]): Promise<boolean> {
    const byId = new Map(results.map((r) => [r.id, r]));
    const updates: OutboxRow[] = [];
    const now = new Date().toISOString();
    let stop = false;
    for (const row of batch) {
      const r = byId.get(row.id);
      if (!r) {
        stop = true;
        break;
      }
      if (r.status === 'applied' || r.status === 'duplicate') {
        updates.push({ ...row, status: 'synced', syncedAt: now, lastTriedAt: now, attempts: row.attempts + 1, lastError: null, result: { status: r.status, ...(r.document && { document: r.document }), ...(r.warnings && { warnings: r.warnings }), ...(r.shift && { shift: r.shift }) } });
        if (row.kind === 'sale' && r.document) await this.deps.local.saleSynced(row.id, r.document.status).catch(() => {});
        if (row.kind === 'shift_open' && r.shift) {
          const event = await this.deps.db.open<SyncEvent>(row.payload);
          if (event.kind === 'shift_open') await this.deps.local.shiftNumbered(event.shiftId, r.shift.number).catch(() => {});
        }
      } else if (r.status === 'failed' && !r.retry) {
        updates.push({ ...row, status: 'failed', lastTriedAt: now, attempts: row.attempts + 1, lastError: r.error ?? { code: 'failed', message: 'Refused by the server' } });
      } else {
        // May pass later: it and everything after it wait, in order.
        updates.push({ ...row, lastTriedAt: now, attempts: row.attempts + 1, lastError: r.error ?? null });
        stop = true;
        break;
      }
    }
    if (updates.length) await this.deps.db.write({ outboxUpdates: updates });
    if (stop) {
      this.grow();
      const why = results.find((r) => r.status === 'failed')?.error?.message ?? null;
      this.set({ phase: 'online', lastError: why });
    } else {
      this.backoffMs = 0;
    }
    return stop;
  }

  /** A quick check that the server can be reached (and the clock), when there is nothing to send. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.call('/v1/pos/till', { timeoutMs: 8000 });
      return res.ok;
    } catch {
      return false;
    }
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? `The server answered ${res.status}`;
  } catch {
    return `The server answered ${res.status}`;
  }
}
