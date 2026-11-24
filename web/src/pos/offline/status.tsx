/**
 * What the till says about its connection: an honest indicator (online,
 * offline, sending, and how many sales wait), and the sync screen for
 * managers: what waits, what the server refused and why, try again.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { OutboxRow } from './db';
import type { SyncState } from './sync';
import type { OfflineTill } from './till';

const ago = (iso: string | null, t: ReturnType<typeof useT>) => {
  if (!iso) return t('never');
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86_400) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(iso).toLocaleString();
};

export function useSyncState(till: OfflineTill | null): SyncState | null {
  const [state, setState] = useState<SyncState | null>(till ? till.sync.current : null);
  useEffect(() => (till ? till.subscribe(setState) : undefined), [till]);
  return state;
}

/** The dot and words in the till's bar. */
export function SyncIndicator({ state, onOpen }: { state: SyncState; onOpen?: () => void }) {
  const t = useT();
  const kind = state.unpaired ? 'bad' : state.phase === 'offline' ? 'off' : state.phase === 'syncing' ? 'busy' : state.failed ? 'warn' : 'ok';
  const words = state.unpaired
    ? t('Removed from the business')
    : state.phase === 'offline'
      ? state.pending ? t('Offline · {n} to send', { n: state.pending }) : t('Offline')
      : state.phase === 'syncing'
        ? t('Sending {n}…', { n: state.pending })
        : state.pending ? t('Online · {n} to send', { n: state.pending }) : t('Online · all sent');
  const title = state.phase === 'offline'
    ? t('Sales are kept on this till and sent when the connection is back. Last reached the server: {when}.', { when: ago(state.lastContactAt, t) })
    : t('Last sent: {when}', { when: ago(state.lastSyncAt, t) });
  const content = (
    <>
      <span className={`sync-dot ${kind}`} aria-hidden="true" />
      <span>{words}</span>
      {state.failed > 0 && !state.unpaired && <span className="sync-failed">{t('{n} need attention', { n: state.failed })}</span>}
    </>
  );
  return onOpen
    ? <button type="button" className="sync-indicator" title={title} onClick={onOpen} aria-live="polite">{content}</button>
    : <span className="sync-indicator" title={title} role="status" aria-live="polite">{content}</span>;
}

/** Managers: everything waiting to reach the server, what it refused and why. */
export function SyncScreen({ till, state }: { till: OfflineTill; state: SyncState }) {
  const t = useT();
  const [rows, setRows] = useState<OutboxRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void till.db.outbox().then((all) => setRows(all.reverse())), [till]);
  useEffect(() => {
    load();
  }, [load, state.pending, state.failed, state.lastSyncAt]);
  const failed = rows?.filter((r) => r.status === 'failed') ?? [];
  const pending = rows?.filter((r) => r.status === 'pending') ?? [];
  const sent = rows?.filter((r) => r.status === 'synced').slice(0, 50) ?? [];
  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="stack sync-screen">
      <div className="row">
        <div><span className="kicker">{t('Connection')}</span><h1>{t('Sync')}</h1></div>
        <span className="spacer" />
        <SyncIndicator state={state} />
      </div>
      <div className="card stack">
        <dl className="sync-facts">
          <div><dt>{t('Waiting to be sent')}</dt><dd className="num">{state.pending}</dd></div>
          <div><dt>{t('Need attention')}</dt><dd className="num">{state.failed}</dd></div>
          <div><dt>{t('Last sent')}</dt><dd>{ago(state.lastSyncAt, t)}</dd></div>
          <div><dt>{t('Last reached the server')}</dt><dd>{ago(state.lastContactAt, t)}</dd></div>
        </dl>
        {state.lastError && <p className="small muted">{t('Last problem')}: {state.lastError}</p>}
        <p className="small muted">{t('Every sale is kept on this till first, then sent. Sending one again is safe: the server keeps each sale once.')}</p>
        <div className="row">
          <button type="button" disabled={busy || state.unpaired} onClick={() => void act(async () => { till.sync.kick(); await till.sync.flush(); })}>{t('Send now')}</button>
          {failed.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => till.sync.retry())}>{t('Try all again')}</button>}
        </div>
      </div>

      {failed.length > 0 && (
        <section className="stack">
          <h2>{t('Need attention')}</h2>
          <p className="small muted">{t('The server refused these. They stay on this till until they are sent: fix what the message says (or ask support) and try again.')}</p>
          <ul className="sync-list">
            {failed.map((r) => (
              <li key={r.id} className="card">
                <div className="row"><strong>{r.label}</strong><span className="spacer" /><span className="muted small">{when(r.createdAt)}</span></div>
                <p className="small late">{r.lastError?.message}</p>
                <div className="row"><span className="muted small">{t('Tried {n} times', { n: r.attempts })}</span><span className="spacer" /><button type="button" className="secondary small-button" disabled={busy} onClick={() => void act(() => till.sync.retry([r.id]))}>{t('Try again')}</button></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack">
        <h2>{t('Waiting')}</h2>
        {pending.length === 0 ? <p className="muted">{t('Nothing waiting: the server has everything.')}</p> : (
          <ul className="sync-list">
            {pending.map((r) => (
              <li key={r.id}>
                <span>{r.label}</span><span className="spacer" />
                {r.lastError && <span className="small muted" title={r.lastError.message}>{t('Retrying')}</span>}
                <span className="muted small">{when(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sent.length > 0 && (
        <section className="stack">
          <h2>{t('Sent')}</h2>
          <ul className="sync-list">
            {sent.map((r) => (
              <li key={r.id}>
                <span>{r.label}</span>
                {r.result?.warnings?.map((w) => <span key={w} className="small warn-text">{w}</span>)}
                <span className="spacer" />
                <span className="muted small">{r.syncedAt ? when(r.syncedAt) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
