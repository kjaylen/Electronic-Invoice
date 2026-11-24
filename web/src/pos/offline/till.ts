/**
 * The offline till: its database, its copy of the catalog, its own API under
 * the screens, the sender, and signing in without the server. One per app.
 *
 * Signing in without the server: a person who signed in on this till while it
 * was online can sign in with the same PIN for 7 days without it (a PBKDF2
 * verifier of the PIN is kept, encrypted, never the PIN). Five wrong PINs lock
 * that person out of the till for 15 minutes. A PIN changed on the server, a
 * person removed or without a PIN: forgotten at the next snapshot.
 */

import { ApiError, type Permission, type Role } from '../../api';
import type { Platform } from '../platform';
import { openDatabase, TillDb } from './db';
import { LocalApi, type SignedInPerson } from './local';
import { SyncEngine, type SyncState } from './sync';
import type { RememberedPin, Snapshot } from './types';
import { forgetKey, loadKey, pinMatches, pinVerifier } from './vault';

export const OFFLINE_DAYS = 7;
const PIN_TRIES = 5;
const PIN_LOCK_MS = 15 * 60_000;

export interface SignedInInfo {
  token: string;
  user: { id: string; name: string; role: Role };
  permissions: Permission[];
  /** Signed in without the server: calls that need it wait until the PIN is checked by the server. */
  offline?: boolean;
}

type Listener = (s: SyncState) => void;

export class OfflineTill {
  readonly local: LocalApi;
  readonly sync: SyncEngine;
  snapshot: Snapshot | null = null;
  private server: { baseUrl: string; deviceToken: string } | null = null;
  private person: SignedInPerson | null = null;
  private sessionToken: string | null = null;
  private listeners = new Set<Listener>();

  private constructor(readonly db: TillDb, readonly installId: string, private readonly platform: Platform) {
    this.local = new LocalApi({
      db,
      snapshot: () => this.snapshot,
      person: () => this.person,
      hasSession: () => Boolean(this.sessionToken),
      online: () => this.sync.online,
      net: (path, init) => this.net(path, init),
      changed: () => this.sync.kick(),
      flush: () => this.sync.flush(),
      now: () => this.now(),
    });
    this.sync = new SyncEngine({
      db,
      local: this.local,
      server: () => this.server,
      installId,
      onSnapshot: (s) => this.applySnapshot(s),
      onChange: (s) => this.listeners.forEach((l) => l(s)),
    });
  }

  static async open(platform: Platform): Promise<OfflineTill> {
    const idb = await openDatabase();
    const key = await loadKey(platform, idb);
    const db = new TillDb(idb, key);
    let installId = await db.meta<string>('installId');
    if (!installId) {
      installId = crypto.randomUUID();
      await db.write({ meta: { installId, createdAt: new Date().toISOString() } });
    }
    const till = new OfflineTill(db, installId, platform);
    SyncEngine.clockOffset = (await db.meta<number>('clockOffset')) ?? 0;
    try {
      till.snapshot = (await db.get<Snapshot>('snapshot')) ?? null;
    } catch {
      // Data this device can no longer unlock (its key was lost): start again from the server.
      till.snapshot = null;
    }
    return till;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.sync.current);
    return () => this.listeners.delete(l);
  }

  /** The till's server and token (after pairing, or at start). Starts sending. */
  async attach(baseUrl: string, deviceToken: string) {
    this.server = { baseUrl, deviceToken };
    await this.sync.start();
  }

  detach() {
    this.sync.stop();
    this.server = null;
  }

  /** The time, as the server's clock has it (a till with a wrong clock still prints the right time). */
  now(): Date {
    return new Date(Date.now() + SyncEngine.clockOffset);
  }

  /** Fetch the snapshot now (the first start needs it). */
  async refresh(): Promise<Snapshot> {
    const s = await this.sync.refreshSnapshot(true);
    return s ?? this.snapshot!;
  }

  private async applySnapshot(s: Snapshot) {
    // Clock: the server's time when it answered, against the device's.
    const offset = Date.parse(s.serverTime) - Date.now();
    if (!Number.isNaN(offset)) SyncEngine.clockOffset = Math.abs(offset) > 90_000 ? offset : 0;
    const key = `nextSerial.${s.offline.environment}.${s.offline.series}`;
    const mine = (await this.db.meta<number>(key)) ?? 1;
    await this.db.write({
      kv: { snapshot: await this.db.seal(s) },
      meta: { [key]: Math.max(mine, s.offline.nextSerial), businessId: s.business.id, clockOffset: SyncEngine.clockOffset, snapshotAt: new Date().toISOString() },
    });
    this.snapshot = s;
    await this.local.adopt(s).catch(() => {});
    await this.forgetStalePins(s);
  }

  // ---------- who is signed in ----------

  signedIn(info: SignedInInfo | null) {
    this.person = info ? { id: info.user.id, name: info.user.name, role: info.user.role, permissions: info.permissions } : null;
    this.sessionToken = info && !info.offline ? info.token : null;
    this.local.reset();
  }

  /** The server checked the PIN of someone signed in offline: calls that need the server work again. */
  upgraded(token: string) {
    this.sessionToken = token;
  }

  get hasSession() {
    return Boolean(this.sessionToken);
  }

  private async net(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }): Promise<Response> {
    if (!this.server) throw new ApiError(0, 'not_paired', 'This till is not paired');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), init.timeoutMs ?? 30_000);
    try {
      return await fetch(`${this.server.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        credentials: 'omit',
        headers: {
          'X-Requested-With': 'etd-web',
          ...(this.sessionToken && { Authorization: `Bearer ${this.sessionToken}` }),
          ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: abort.signal,
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.sync.kick();
      throw new ApiError(0, 'network', (e as Error).name === 'AbortError' ? 'The server took too long to answer' : 'Cannot reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- PINs ----------

  private async pins(): Promise<Record<string, RememberedPin>> {
    return (await this.db.get<Record<string, RememberedPin>>('pins').catch(() => undefined)) ?? {};
  }

  /** After the server accepted a PIN: remember it here (as a verifier) for signing in offline. */
  async rememberPin(pin: string, info: SignedInInfo) {
    const v = await pinVerifier(pin);
    const pins = await this.pins();
    pins[info.user.id] = { user: info.user, permissions: info.permissions, ...v, savedAt: new Date().toISOString() };
    await this.db.put('pins', pins);
    const tries = (await this.db.meta<Record<string, { n: number; until: number }>>('pinTries')) ?? {};
    delete tries[info.user.id];
    await this.db.write({ meta: { pinTries: tries } });
  }

  /** Who can sign in offline now (remembered, not expired). */
  async offlineUsers(): Promise<Set<string>> {
    const pins = await this.pins();
    const limit = Date.now() - OFFLINE_DAYS * 86_400_000;
    return new Set(Object.values(pins).filter((p) => Date.parse(p.savedAt) > limit).map((p) => p.user.id));
  }

  async signInOffline(userId: string, pin: string): Promise<SignedInInfo> {
    const tries = (await this.db.meta<Record<string, { n: number; until: number }>>('pinTries')) ?? {};
    const t = tries[userId];
    if (t && t.until > Date.now()) throw new ApiError(429, 'pin_locked', `Too many wrong PINs. Try again in ${Math.ceil((t.until - Date.now()) / 60_000)} minutes.`);
    const remembered = (await this.pins())[userId];
    if (!remembered) throw new ApiError(401, 'not_remembered', 'You have not signed in on this till while it was online. Sign in once with a connection; after that you can sign in here without one.');
    if (Date.parse(remembered.savedAt) < Date.now() - OFFLINE_DAYS * 86_400_000) {
      throw new ApiError(401, 'offline_expired', `Signing in without a connection works for ${OFFLINE_DAYS} days after you last signed in online. Connect the till and sign in again.`);
    }
    if (!(await pinMatches(pin, remembered))) {
      const n = (t && t.until <= Date.now() && t.n >= PIN_TRIES ? 0 : t?.n ?? 0) + 1;
      tries[userId] = { n, until: n >= PIN_TRIES ? Date.now() + PIN_LOCK_MS : 0 };
      await this.db.write({ meta: { pinTries: tries } });
      const left = PIN_TRIES - n;
      throw new ApiError(401, 'wrong_pin', left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.');
    }
    delete tries[userId];
    await this.db.write({ meta: { pinTries: tries } });
    return { token: '', user: remembered.user, permissions: remembered.permissions, offline: true };
  }

  private async forgetStalePins(s: Snapshot) {
    const pins = await this.pins();
    let changed = false;
    for (const [id, p] of Object.entries(pins)) {
      const u = s.users.find((x) => x.id === id);
      if (!u || !u.hasPin || (u.pinSetAt && Date.parse(u.pinSetAt) > Date.parse(p.savedAt))) {
        delete pins[id];
        changed = true;
      } else if (u.role !== p.user.role || u.name !== p.user.name) {
        pins[id] = { ...p, user: { id, name: u.name, role: u.role }, permissions: u.permissions };
        changed = true;
      }
    }
    if (changed) await this.db.put('pins', pins);
  }

  // ---------- removing the till ----------

  /** What has not reached the server (nothing may be lost by removing the till). */
  async unsent(): Promise<{ pending: number; failed: number }> {
    return this.db.outboxCounts();
  }

  /** Everything on this device, gone: only when nothing is left to send. */
  async wipe() {
    const left = await this.unsent();
    if (left.pending || left.failed) throw new Error('This till has sales that have not reached the server');
    this.detach();
    await this.db.wipe();
    await forgetKey(this.platform);
    this.snapshot = null;
  }
}

let opening: Promise<OfflineTill> | null = null;
/** The app's offline till (opened once). */
export const offlineTill = (platform: Platform) => (opening ??= OfflineTill.open(platform));
