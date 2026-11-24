/**
 * The till's own database, on the device: what it sells from and everything
 * it did that the server has not confirmed yet. IndexedDB, with every record
 * that holds business data encrypted (AES-GCM, a key kept in the platform's
 * secure storage, see vault.ts). Writes that matter wait for the disk
 * (durability "strict"): when a sale is said to be done, it is on the disk.
 *
 * Stores:
 *   meta    plain values with no business data: the install id, the series, the next serial, the clock offset
 *   kv      encrypted values: the snapshot (items, customers, people), remembered PINs
 *   outbox  what goes to the server, in order (seq): one event per sale, shift opened or closed, cash in or out
 *   sales   the receipts made on this till (their printed copy, their status)
 *   shifts  the till's shifts (opened here, or carried on from the server)
 *   held    sales put on hold while offline (moved to the server when it is back)
 */

import { decryptJson, encryptJson, type Sealed } from './vault';

const NAME = 'floreo-till';
const VERSION = 1;

export type OutboxKind = 'sale' | 'shift_open' | 'cash' | 'shift_close';
export type OutboxStatus = 'pending' | 'failed' | 'synced';

export interface OutboxRow {
  seq?: number;
  id: string;
  kind: OutboxKind;
  status: OutboxStatus;
  createdAt: string;
  attempts: number;
  lastTriedAt: string | null;
  /** Why it failed (the server's words), for the sync screen. */
  lastError: { code: string; message: string } | null;
  /** The server's answer once it has it. */
  result: { status: string; document?: { id: string; etdui: string; status: string }; warnings?: string[]; shift?: { number: number } } | null;
  syncedAt: string | null;
  /** A short description for the sync screen (no personal data): "Receipt 101-000000004, BZ$22.50". */
  label: string;
  payload: Sealed;
}

export interface SaleRow {
  id: string;
  createdAt: string;
  shiftId: string | null;
  /** The counter's idempotency key: the same sale submitted twice is one sale. */
  idem: string | null;
  payload: Sealed;
}

export interface SealedRow {
  id: string;
  createdAt: string;
  payload: Sealed;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('The till database refused the change'));
  });
}

export function openDatabase(name = NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta');
      db.createObjectStore('kv');
      db.createObjectStore('keys');
      const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      outbox.createIndex('id', 'id', { unique: true });
      outbox.createIndex('status', 'status');
      const sales = db.createObjectStore('sales', { keyPath: 'id' });
      sales.createIndex('createdAt', 'createdAt');
      sales.createIndex('idem', 'idem');
      db.createObjectStore('shifts', { keyPath: 'id' });
      db.createObjectStore('held', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('The till database is open in another window'));
  });
}

type Store = 'meta' | 'kv' | 'keys' | 'outbox' | 'sales' | 'shifts' | 'held';
const STRICT = { durability: 'strict' } as IDBTransactionOptions;

/** What one atomic write does (all of it, or none of it). */
export interface Change {
  meta?: Record<string, unknown>;
  kv?: Record<string, Sealed>;
  outbox?: OutboxRow[];
  /** Outbox rows to update in place (by seq). */
  outboxUpdates?: OutboxRow[];
  sales?: SaleRow[];
  shifts?: SealedRow[];
  held?: SealedRow[];
  deleteHeld?: string[];
}

export class TillDb {
  constructor(readonly db: IDBDatabase, private readonly key: CryptoKey) {}

  // ---------- plain values ----------

  async meta<T>(key: string): Promise<T | undefined> {
    return request(this.db.transaction('meta').objectStore('meta').get(key)) as Promise<T | undefined>;
  }

  // ---------- encrypted values ----------

  seal(value: unknown): Promise<Sealed> {
    return encryptJson(this.key, value);
  }

  open<T>(sealed: Sealed): Promise<T> {
    return decryptJson<T>(this.key, sealed);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const sealed = await request(this.db.transaction('kv').objectStore('kv').get(key)) as Sealed | undefined;
    return sealed ? this.open<T>(sealed) : undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.write({ kv: { [key]: await this.seal(value) } });
  }

  /**
   * Several changes at once, on the disk before it resolves. Encrypt first (seal):
   * nothing asynchronous may happen inside an IndexedDB transaction.
   */
  async write(c: Change): Promise<{ outboxSeqs: number[] }> {
    const stores = new Set<Store>();
    if (c.meta) stores.add('meta');
    if (c.kv) stores.add('kv');
    if (c.outbox?.length || c.outboxUpdates?.length) stores.add('outbox');
    if (c.sales?.length) stores.add('sales');
    if (c.shifts?.length) stores.add('shifts');
    if (c.held?.length || c.deleteHeld?.length) stores.add('held');
    if (!stores.size) return { outboxSeqs: [] };
    const t = this.db.transaction([...stores], 'readwrite', STRICT);
    const finished = done(t);
    const seqs: Array<Promise<IDBValidKey>> = [];
    for (const [k, v] of Object.entries(c.meta ?? {})) t.objectStore('meta').put(v, k);
    for (const [k, v] of Object.entries(c.kv ?? {})) t.objectStore('kv').put(v, k);
    for (const row of c.outbox ?? []) seqs.push(request(t.objectStore('outbox').add(row)));
    for (const row of c.outboxUpdates ?? []) t.objectStore('outbox').put(row);
    for (const row of c.sales ?? []) t.objectStore('sales').put(row);
    for (const row of c.shifts ?? []) t.objectStore('shifts').put(row);
    for (const row of c.held ?? []) t.objectStore('held').put(row);
    for (const id of c.deleteHeld ?? []) t.objectStore('held').delete(id);
    await finished;
    return { outboxSeqs: (await Promise.all(seqs)).map(Number) };
  }

  // ---------- the outbox ----------

  /** Events in the order they happened; by status if given. */
  async outbox(status?: OutboxStatus, limit = 10_000): Promise<OutboxRow[]> {
    const store = this.db.transaction('outbox').objectStore('outbox');
    const all = (await request(status ? store.index('status').getAll(status) : store.getAll())) as OutboxRow[];
    return all.sort((a, b) => a.seq! - b.seq!).slice(0, limit);
  }

  async outboxCounts(): Promise<{ pending: number; failed: number }> {
    const index = this.db.transaction('outbox').objectStore('outbox').index('status');
    const [pending, failed] = await Promise.all([request(index.count('pending')), request(index.count('failed'))]);
    return { pending, failed };
  }

  async outboxRow(id: string): Promise<OutboxRow | undefined> {
    return request(this.db.transaction('outbox').objectStore('outbox').index('id').get(id)) as Promise<OutboxRow | undefined>;
  }

  /** Forget events the server confirmed more than `days` ago (the receipts stay readable on the server). */
  async prune(days = 30): Promise<void> {
    const before = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = (await this.outbox('synced')).filter((r) => r.syncedAt && r.syncedAt < before);
    if (!old.length) return;
    const t = this.db.transaction(['outbox', 'sales'], 'readwrite', STRICT);
    const finished = done(t);
    for (const r of old) {
      t.objectStore('outbox').delete(r.seq!);
      if (r.kind === 'sale') t.objectStore('sales').delete(r.id);
    }
    await finished;
  }

  // ---------- sales, shifts, held sales ----------

  async saleRow(id: string): Promise<SaleRow | undefined> {
    return request(this.db.transaction('sales').objectStore('sales').get(id)) as Promise<SaleRow | undefined>;
  }

  async saleByIdem(idem: string): Promise<SaleRow | undefined> {
    return request(this.db.transaction('sales').objectStore('sales').index('idem').get(idem)) as Promise<SaleRow | undefined>;
  }

  /** Newest first. */
  async saleRows(limit = 500): Promise<SaleRow[]> {
    const all = (await request(this.db.transaction('sales').objectStore('sales').getAll())) as SaleRow[];
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  async shiftRow(id: string): Promise<SealedRow | undefined> {
    return request(this.db.transaction('shifts').objectStore('shifts').get(id)) as Promise<SealedRow | undefined>;
  }

  async shiftRows(): Promise<SealedRow[]> {
    const all = (await request(this.db.transaction('shifts').objectStore('shifts').getAll())) as SealedRow[];
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async heldRows(): Promise<SealedRow[]> {
    const all = (await request(this.db.transaction('held').objectStore('held').getAll())) as SealedRow[];
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async heldRow(id: string): Promise<SealedRow | undefined> {
    return request(this.db.transaction('held').objectStore('held').get(id)) as Promise<SealedRow | undefined>;
  }

  /** The key store, for a browser's own key (vault.ts). */
  static async keyFrom(db: IDBDatabase): Promise<CryptoKey | undefined> {
    return request(db.transaction('keys').objectStore('keys').get('main')) as Promise<CryptoKey | undefined>;
  }

  static async saveKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
    const t = db.transaction('keys', 'readwrite', STRICT);
    const finished = done(t);
    t.objectStore('keys').put(key, 'main');
    await finished;
  }

  /** Everything on this device, gone (unpairing a till with nothing left to send). */
  async wipe(): Promise<void> {
    const stores: Store[] = ['meta', 'kv', 'outbox', 'sales', 'shifts', 'held'];
    const t = this.db.transaction(stores, 'readwrite', STRICT);
    const finished = done(t);
    for (const s of stores) t.objectStore(s).clear();
    await finished;
  }
}
