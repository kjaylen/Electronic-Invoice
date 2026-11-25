/**
 * The hospitality module on a device: what the device knows (the menu, the
 * floor, open checks, tickets), kept on the device so service goes on with
 * no connection, and brought in step with the server every two seconds.
 *
 * Nothing waits on the network. An operation (open a table, add an item,
 * send to the kitchen) is applied to the device's own copy at once, queued,
 * and posted when the server can be reached; the same code folds it on both
 * sides (src/venue/check.ts), so both reach the same check. What other
 * devices did arrives as whole checks, and the device's own unsent
 * operations are folded on top again.
 */

import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { apply, type Applied, type Check, memoryStore, type Op, type OpType } from '../../../src/venue/check.ts';
import type { ModifierGroup, Period } from '../../../src/venue/pricing.ts';
import { ticketsFor } from '../../../src/venue/station-tickets.ts';

export interface FloorItem { id: string; type: 'table' | 'stool' | 'wall' | 'fixture'; name: string; shape: 'round' | 'rect' | 'square'; seats: number; x: number; y: number; w: number; h: number; rotation: number }
export interface FloorPlan { id: string; area: string; layout: string; position: number; items: FloorItem[] }
export interface Station { id: string; name: string; categories: string[]; deviceId: string | null; screen: boolean; fallbackId: string | null; targetMin: number; position: number }
export interface MenuEntry {
  id: string; name: string; category: string | null; priceCents: number; gst: 'S' | 'Z' | 'E'; exemptionReasonCode: string | null; unitCode: string;
  allergens: string[]; dietary: string[]; soldOut: boolean; remaining: number | null; course: number | null; stationIds: string[]; modifierGroupIds: string[]; favorite: boolean; barcode: string | null;
}
export interface VenueSettings {
  restaurant: boolean; bar: boolean; hotel: boolean; usdRateCents: number; serviceCharge: 'off' | 'all' | 'party'; servicePercent: string; servicePartySize: number; dayEndsHour: number;
  discountLimitPercent: number; turnMinutes: Array<[number, number]>; tipPool: { method: 'none' | 'hours' | 'role' | 'points'; weights: Record<string, number> }; layout: string;
  menuOverride: { periodId: string; businessDate: string } | null; checkInTime: string; checkOutTime: string; rateCurrency: 'BZD' | 'USD' | 'both'; hotelDate: string | null; closedThrough: string | null;
}
export interface Staff { id: string; name: string; role: string; orders: boolean; approves: boolean }
export interface TicketBody { number: number; table: string; server: string; partySize: number; allergy: string | null; at: string; items: Array<{ id: string; name: string; quantity: number; seat: number; course: number; modifiers: string[]; note: string | null; allergens: string[] }> }
export interface Ticket { id: string; checkId: string; stationId: string; kind: 'order' | 'void' | 'change'; body: TicketBody; status: 'queued' | 'printed' | 'failed' | 'screen'; attempts: number; error: string | null; originDeviceId: string | null; sentBy: string | null; createdAt: string; printedAt: string | null; bumpedAt: string | null }
export interface VenueData {
  on: boolean; venue: VenueSettings; now: string; businessDate: string;
  taxes: { gstPercent: string; hotelTaxPercent: string; unverified: string[] };
  floor: FloorPlan[]; periods: Period[]; stations: Station[]; modifierGroups: ModifierGroup[]; items: MenuEntry[]; staff: Staff[];
  sections: Array<{ userId: string; tableIds: string[] }>; allergens: string[]; dietary: string[];
  me: { id: string; deviceId: string | null; orders: boolean; approves: boolean; kitchen: boolean; floor: boolean };
}
export type NumberedCheck = Check & { number?: number };

interface State {
  data: VenueData | null;
  /** Checks as the server last had them. */
  server: Map<string, NumberedCheck>;
  /** Operations this device has made and the server has not yet answered. */
  pending: Op[];
  tickets: Map<string, Ticket>;
  seq: number;
  online: boolean;
  /** Operations the server refused, for the person to see. */
  problems: Array<{ id: string; checkId: string; type: string; reason: string }>;
  loaded: boolean;
}

const KEY = 'venue.device.v1';
const state: State = { data: null, server: new Map(), pending: [], tickets: new Map(), seq: 0, online: true, problems: [], loaded: false };
let view: { checks: NumberedCheck[]; version: number } = { checks: [], version: 0 };
let version = 0;
const listeners = new Set<() => void>();
let who: { id: string; name: string } = { id: '', name: '' };
/** Prints a ticket on this device; set by the screen that has a printer (the till, or the browser). */
let printer: ((ticket: Ticket, station: Station | undefined) => Promise<void>) | null = null;
const handled = new Set<string>();

function rebuild() {
  // The server's copy, with this device's unsent operations folded on top.
  const store = memoryStore([...state.server.values()].map((c) => JSON.parse(JSON.stringify(c)) as Check));
  for (const op of state.pending) apply(store, op);
  view = { checks: store.all() as NumberedCheck[], version: ++version };
  for (const l of listeners) l();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ data: state.data, server: [...state.server.values()].filter((c) => c.status === 'open' || c.status === 'paid'), pending: state.pending, seq: state.seq }));
  } catch { /* storage full or blocked: the device still works while it is open */ }
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { data: VenueData | null; server: NumberedCheck[]; pending: Op[]; seq: number } | null;
    if (!raw) return;
    state.data = raw.data;
    state.server = new Map((raw.server ?? []).map((c) => [c.id, c]));
    state.pending = raw.pending ?? [];
    // Ask for everything again: the device may have been off for a while.
    state.seq = 0;
  } catch { /* a copy that cannot be read is no copy */ }
}

/** Load what the device needs to work (and keep it for when there is no connection). */
export async function loadVenue(): Promise<void> {
  if (!state.loaded) { restore(); state.loaded = true; rebuild(); }
  try {
    state.data = await api<VenueData>('/v1/venue');
    state.online = true;
    save();
  } catch { state.online = false; }
  rebuild();
}

export function setActor(user: { id: string; name: string }) { who = { id: user.id, name: user.name }; }
export function setPrinter(fn: typeof printer) { printer = fn; }

/** Do something to a check: applied here at once, sent when it can be. Returns what it did on this device. */
export function dispatch(checkId: string, type: OpType, payload: Record<string, unknown> = {}): Applied {
  const op: Op = { id: crypto.randomUUID(), checkId, type, at: new Date().toISOString(), by: who, payload };
  // Try it on the device's copy first: what cannot be done here is not queued.
  const store = memoryStore(view.checks.map((c) => JSON.parse(JSON.stringify(c)) as Check));
  const done = apply(store, op);
  if (!done.ok) return done;
  state.pending.push(op);
  save();
  rebuild();
  // With no connection the server cannot queue the tickets: this device makes and prints them itself, and says so
  // when the order goes up (so they are not printed a second time). If its printer fails, the server queues them later.
  if (done.sent.length || done.voided.length) {
    const check = store.get(checkId) as NumberedCheck;
    if (!state.online) void printOffline(op, check, done);
    // The connection may drop with this very order: it is kept until the server has it, and printed here if it cannot go.
    else unprinted.set(op.id, { op, check, done });
  }
  void flush();
  return done;
}

/** Orders sent while the device thought it was connected, not yet answered by the server. */
const unprinted = new Map<string, { op: Op; check: NumberedCheck; done: Applied }>();

async function printOffline(op: Op, check: NumberedCheck | undefined, done: Applied) {
  if (!printer || !check || !state.data) return;
  const jobs = [
    ...ticketsFor(check, done.sent, 'order', state.data.stations, check.number ?? 0).map((j) => ({ ...j, kind: 'order' as const })),
    ...ticketsFor(check, done.voided, 'void', state.data.stations, check.number ?? 0).map((j) => ({ ...j, kind: 'void' as const })),
  ];
  try {
    for (const j of jobs) {
      await printer({ id: crypto.randomUUID(), checkId: check.id, stationId: j.station.id, kind: j.kind, body: j.body, status: 'queued', attempts: 0, error: null, originDeviceId: state.data.me.deviceId, sentBy: who.id, createdAt: op.at, printedAt: null, bumpedAt: null }, j.station);
    }
    const queued = state.pending.find((o) => o.id === op.id);
    if (queued) { queued.payload = { ...queued.payload, printed: true }; save(); }
  } catch (e) {
    state.problems.push({ id: crypto.randomUUID(), checkId: check.id, type: 'print', reason: `${check.tableName ?? check.name ?? 'Order'}: the kitchen ticket did not print (${e instanceof Error ? e.message : String(e)}). It will print when the connection is back; tell the kitchen now.` });
    rebuild();
  }
}

let flushing = false;
export async function flush(): Promise<void> {
  if (flushing || !state.pending.length) return;
  flushing = true;
  try {
    const batch = state.pending.slice(0, 100);
    const res = await api<{ results: Array<{ id: string; ok: boolean; reason?: string; code?: string; duplicate?: boolean; sent: string[] }>; seq: number }>('/v1/venue/ops', { method: 'POST', body: { ops: batch.map((o) => ({ id: o.id, checkId: o.checkId, type: o.type, at: o.at, payload: o.payload })) } });
    state.online = true;
    const answered = new Set(res.results.map((r) => r.id));
    for (const r of res.results) {
      if (!r.ok && !r.duplicate) {
        const op = batch.find((o) => o.id === r.id);
        state.problems.push({ id: r.id, checkId: op?.checkId ?? '', type: op?.type ?? '', reason: r.reason ?? 'The server refused it' });
      }
    }
    state.pending = state.pending.filter((o) => !answered.has(o.id));
    for (const id of answered) unprinted.delete(id);
    save();
    await poll();
  } catch (e) {
    // No connection (or the till's offline layer saying so): keep everything and try again shortly.
    const status = (e as { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429 && (e as { code?: string }).code !== 'needs_server') {
      // The server refused the whole batch (the module was turned off, the role changed): do not send it for ever.
      state.problems.push({ id: crypto.randomUUID(), checkId: '', type: 'sync', reason: (e as Error).message });
      state.pending = [];
      save();
    } else {
      state.online = false;
      const waiting = [...unprinted.values()];
      unprinted.clear();
      for (const w of waiting) void printOffline(w.op, w.check, w.done);
    }
    rebuild();
  } finally {
    flushing = false;
  }
  if (state.pending.length && state.online) void flush();
}

let polling = false;
export async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const res = await api<{ seq: number; checks: NumberedCheck[]; tickets: Ticket[]; soldOut: Array<{ id: string; soldOut: boolean; remaining: number | null }> }>(`/v1/venue/changes?since=${state.seq}`);
    state.online = true;
    if (state.seq === 0) state.server = new Map();
    for (const c of res.checks) {
      if (c.status === 'closed' || c.status === 'merged') state.server.delete(c.id);
      else state.server.set(c.id, c);
    }
    for (const t of res.tickets) state.tickets.set(t.id, t);
    // Old, finished tickets are not kept on the device.
    for (const [id, t] of state.tickets) if (Date.now() - new Date(t.createdAt).getTime() > 12 * 3600_000) state.tickets.delete(id);
    if (state.data) {
      const out = new Map(res.soldOut.map((s) => [s.id, s]));
      state.data = { ...state.data, items: state.data.items.map((i) => (out.has(i.id) ? { ...i, soldOut: out.get(i.id)!.soldOut, remaining: out.get(i.id)!.remaining } : i.soldOut || i.remaining !== null ? { ...i, soldOut: false, remaining: null } : i)) };
    }
    state.seq = res.seq;
    save();
    rebuild();
    void printQueued();
  } catch {
    if (state.online) { state.online = false; rebuild(); }
  } finally {
    polling = false;
  }
}

/** Is this ticket this device's to print? Its station's till; or, when the station has none, the device that sent the order. */
function mine(t: Ticket): boolean {
  const me = state.data?.me;
  if (!me || t.status !== 'queued') return false;
  const station = state.data?.stations.find((s) => s.id === t.stationId);
  if (station?.deviceId) return station.deviceId === me.deviceId;
  return t.originDeviceId ? t.originDeviceId === me.deviceId : t.sentBy === me.id && !me.deviceId;
}

async function printQueued() {
  if (!printer) return;
  for (const t of state.tickets.values()) {
    if (!mine(t) || handled.has(t.id)) continue;
    handled.add(t.id);
    try {
      await printer(t, state.data?.stations.find((s) => s.id === t.stationId));
      await ticketDid(t.id, 'printed');
    } catch (e) {
      await ticketDid(t.id, 'failed', e instanceof Error ? e.message : String(e));
    }
  }
}

export async function ticketDid(id: string, what: 'printed' | 'failed' | 'retry' | 'reroute' | 'bump' | 'recall', error?: string): Promise<void> {
  try {
    const t = await api<Ticket>(`/v1/venue/tickets/${id}/${what}`, { method: 'POST', body: error ? { error: error.slice(0, 280) } : {} });
    if (what === 'retry' || what === 'reroute') handled.delete(id);
    state.tickets.set(t.id, t);
    rebuild();
    void printQueued();
  } catch { /* the next poll says where it stands */ }
}

export function dismissProblem(id: string) { state.problems = state.problems.filter((p) => p.id !== id); rebuild(); }

let timer: ReturnType<typeof setInterval> | null = null;
let users = 0;
/** Keep in step while a screen that needs it is open. */
export function watch(): () => void {
  users += 1;
  if (!timer) {
    void loadVenue().then(() => { void flush(); void poll(); });
    timer = setInterval(() => { if (document.visibilityState !== 'hidden') { void flush(); void poll(); } }, 2000);
  }
  return () => {
    users -= 1;
    if (users <= 0 && timer) { clearInterval(timer); timer = null; users = 0; }
  };
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
const snapshot = () => version;

export function useVenue() {
  useSyncExternalStore(subscribe, snapshot);
  return {
    data: state.data, checks: view.checks, tickets: [...state.tickets.values()], online: state.online, pending: state.pending.length, problems: state.problems,
    check: (id: string | null) => (id ? view.checks.find((c) => c.id === id) : undefined),
  };
}

/** For tests and for switching business on one device. */
export function resetVenue() {
  state.data = null; state.server = new Map(); state.pending = []; state.tickets = new Map(); state.seq = 0; state.problems = []; state.loaded = false;
  handled.clear();
  try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
  rebuild();
}
