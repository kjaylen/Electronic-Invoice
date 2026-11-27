/**
 * A newer till app, from the server the till is paired with (GET /v1/pos/downloads, which lists what
 * is in the server's TILL_DOWNLOADS_DIR):
 *
 * - Desktop: the app downloads it in the background (apps/desktop/updates.cjs); once it is ready, the
 *   status bar offers "Restart to update". Closing the app installs it too.
 * - Android installed from the server (not from Google Play): the status bar offers the new app, which
 *   opens in the browser to download and install. From Google Play, Play updates it and the server
 *   simply has no Android build to offer.
 * - In a browser the till is always the newest: nothing to do.
 *
 * Looked at when the till starts and every four hours; a check that fails (no connection) is quiet.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Platform } from './platform';

export type TillUpdate =
  | { kind: 'none' }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'available'; version: string; url: string };

export interface DesktopUpdateState { status: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error' | 'unavailable'; version: string | null; percent: number | null; error: string | null }
type Download = { version: string; file: string; url: string };
type Downloads = { windows?: Download; mac?: Download; linux?: Download; android?: Download & { versionCode: number } };

const CHECK_EVERY = 4 * 60 * 60_000;

/** Whether version a is newer than b (1.2.10 > 1.2.9; a pre-release such as 1.3.0-beta is older than 1.3.0). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre > y.pre;
}

const fromDesktop = (s: DesktopUpdateState): TillUpdate =>
  s.status === 'ready' && s.version ? { kind: 'ready', version: s.version }
    : s.status === 'downloading' && s.version ? { kind: 'downloading', version: s.version, percent: s.percent }
      : { kind: 'none' };

export function useTillUpdate(p: Platform, server: string): { update: TillUpdate; install: () => void } {
  const [update, setUpdate] = useState<TillUpdate>({ kind: 'none' });
  const desktop = p.kind === 'desktop' ? p.updates : undefined;

  useEffect(() => {
    if (p.kind === 'web' || p.kind === 'ios' || !server) return;
    let live = true;
    const off = desktop?.onStatus((s) => live && setUpdate(fromDesktop(s)));
    void desktop?.state().then((s) => live && setUpdate(fromDesktop(s))).catch(() => {});
    const look = async () => {
      try {
        const r = await fetch(new URL('v1/pos/downloads', server.endsWith('/') ? server : `${server}/`), { signal: AbortSignal.timeout(15_000) });
        if (!r.ok || !live) return;
        const d = (await r.json()) as Downloads;
        if (desktop) {
          // The app checks the files itself (and verifies what it downloads); only bother it when there is something newer.
          const mine = d.windows ?? d.mac ?? d.linux;
          if (mine && isNewer(mine.version, p.appVersion)) setUpdate(fromDesktop(await desktop.check(server)));
        } else if (p.kind === 'android' && d.android && isNewer(d.android.version, p.appVersion)) {
          setUpdate({ kind: 'available', version: d.android.version, url: new URL(d.android.url, server).toString() });
        }
      } catch { /* no connection: next time */ }
    };
    void look();
    const timer = setInterval(() => void look(), CHECK_EVERY);
    return () => {
      live = false;
      off?.();
      clearInterval(timer);
    };
  }, [p, server, desktop]);

  const install = useCallback(() => {
    if (update.kind === 'ready') void desktop?.install();
    // Android: the browser downloads the new app; the system then asks to install it over this one.
    else if (update.kind === 'available') window.location.href = update.url;
  }, [update, desktop]);

  return { update, install };
}
