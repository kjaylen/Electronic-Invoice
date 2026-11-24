/**
 * The site being edited, and keeping it safe: every change is saved as the
 * draft a moment later, one save at a time; a save that fails is tried again
 * (and at once when the connection returns); leaving the editor or the tab
 * sends what is waiting; a copy of unsaved work stays on this device and is
 * offered back; and a save made on top of someone else's changes is refused
 * by the server, so the editor can ask which to keep.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { BUSINESS } from '../business';
import { store } from '../storage';
import { EMPTY_HISTORY, historyReducer } from './doc';
import type { Builder, SiteDoc } from './types';

export interface LoadedSite {
  draft: SiteDoc;
  changed: boolean;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
  slug: string;
  builder: Builder;
  /** Whether customers can reach the store at all. */
  store?: { open: boolean; planAllows: boolean };
}

/** idle: nothing to save. pending: a change is waiting. saving, saved. error: will retry. conflict: someone else changed the site. */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

interface Backup { site: SiteDoc; at: number }

const SAVE_AFTER_MS = 700;
const BACKUP_KEY = `etd.site.unsaved.${BUSINESS ?? ''}`;
/** Browsers only promise to finish a request made while the page closes when it is small. */
const KEEPALIVE_LIMIT = 60_000;

const retryable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

export function useSiteDraft() {
  const [loaded, setLoaded] = useState<LoadedSite | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [h, dispatch] = useReducer(historyReducer, EMPTY_HISTORY);
  const [changed, setChanged] = useState(false);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [backup, setBackup] = useState<Backup | null>(null);

  const doc = useRef<SiteDoc | null>(null);
  doc.current = h.doc;
  const dirty = useRef(false);
  const blocked = useRef(false);
  const base = useRef<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const backupTimer = useRef<number | undefined>(undefined);
  const retries = useRef(0);
  const seen = useRef(0);

  const adopt = useCallback((r: { draft: SiteDoc; changed: boolean; draftUpdatedAt?: string | null }, undoable = false) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(backupTimer.current);
    dirty.current = false;
    blocked.current = false;
    retries.current = 0;
    base.current = r.draftUpdatedAt ?? null;
    store.remove(BACKUP_KEY);
    dispatch({ type: 'load', doc: r.draft, undoable });
    setChanged(r.changed);
    setSave('idle');
    setSaveError(null);
  }, []);

  const load = useCallback(async () => {
    const r = await api<LoadedSite>('/v1/store-site');
    setLoaded(r);
    return r;
  }, []);

  useEffect(() => {
    void load().then((r) => {
      // Work this device kept that never reached the server (a crash, a closed tab, no connection).
      const kept = store.get<Backup>(BACKUP_KEY);
      const newer = kept && typeof kept.at === 'number' && kept.site && kept.at > (r.draftUpdatedAt ? Date.parse(r.draftUpdatedAt) : 0);
      adopt(r);
      if (newer && JSON.stringify(kept.site) !== JSON.stringify(r.draft)) {
        setBackup(kept);
        store.set(BACKUP_KEY, kept);
      }
    }).catch(setLoadError);
  }, [load, adopt]);

  /** Send what is waiting, after any save already on its way. True when everything is saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    if (blocked.current) return false;
    if (!dirty.current || !doc.current) return true;
    const site = doc.current;
    dirty.current = false;
    setSave('saving');
    const run = api<{ changed: boolean; draftUpdatedAt: string | null }>('/v1/store-site/draft', { method: 'PUT', body: { site, ...(base.current && { base: base.current }) } })
      .then((r) => {
        base.current = r.draftUpdatedAt;
        retries.current = 0;
        setChanged(r.changed);
        setSaveError(null);
        if (!dirty.current) {
          window.clearTimeout(backupTimer.current);
          store.remove(BACKUP_KEY);
          setSave('saved');
        }
      })
      .catch((e: unknown) => {
        dirty.current = true;
        setSaveError(e);
        if (e instanceof ApiError && e.code === 'draft_changed') {
          blocked.current = true;
          setSave('conflict');
          return;
        }
        setSave('error');
        // Tried again by itself when it could work next time; otherwise on the next change.
        if (retryable(e)) timer.current = window.setTimeout(() => void flush(), Math.min(30_000, 3000 * 2 ** retries.current++));
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = run;
    await run;
    return !dirty.current;
  }, []);

  // Each change: kept on this device at once, saved a moment later.
  useEffect(() => {
    if (!h.doc || h.touched === seen.current) return;
    seen.current = h.touched;
    dirty.current = true;
    const site = h.doc;
    window.clearTimeout(backupTimer.current);
    backupTimer.current = window.setTimeout(() => store.set(BACKUP_KEY, { site, at: Date.now() } satisfies Backup), 300);
    if (blocked.current) return;
    setSave((s) => (s === 'saving' ? s : 'pending'));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
  }, [h.doc, h.touched, flush]);

  // Leaving: the editor (another page of the app), the tab going to the background, or the tab closing.
  useEffect(() => {
    const keep = () => {
      if (dirty.current && doc.current) store.set(BACKUP_KEY, { site: doc.current, at: Date.now() } satisfies Backup);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        keep();
        void flush();
      }
    };
    const onPageHide = () => {
      if (!dirty.current || !doc.current || blocked.current) return;
      keep();
      const body = { site: doc.current, ...(base.current && { base: base.current }) };
      // A request the browser finishes after the page is gone, when it is small enough to be allowed.
      if (JSON.stringify(body).length < KEEPALIVE_LIMIT) void api('/v1/store-site/draft', { method: 'PUT', body, keepalive: true }).catch(() => {});
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current && !inflight.current) return;
      keep();
      e.preventDefault();
    };
    const onOnline = () => void flush();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('online', onOnline);
      window.clearTimeout(backupTimer.current);
      // Moving to another page of the app: the request carries on after the editor is gone.
      keep();
      void flush();
    };
  }, [flush]);

  const update = useCallback((next: SiteDoc | ((d: SiteDoc) => SiteDoc), key = '') => dispatch({ type: 'edit', next, key, at: Date.now() }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  /** Someone else changed the site: take theirs (this device's changes are dropped)… */
  const loadTheirs = useCallback(async () => {
    adopt(await load());
  }, [adopt, load]);
  /** …or keep this device's version, replacing theirs. */
  const keepMine = useCallback(async () => {
    base.current = null;
    blocked.current = false;
    await flush();
  }, [flush]);

  const restoreBackup = useCallback(() => {
    if (backup) dispatch({ type: 'edit', next: backup.site, at: Date.now() });
    setBackup(null);
  }, [backup]);
  const dropBackup = useCallback(() => {
    if (!dirty.current) store.remove(BACKUP_KEY);
    setBackup(null);
  }, []);

  return {
    loaded, loadError, doc: h.doc, canUndo: h.past.length > 0, canRedo: h.future.length > 0,
    changed, setChanged, save, saveError, backup,
    update, undo, redo, flush, adopt, loadTheirs, keepMine, restoreBackup, dropBackup,
  };
}
