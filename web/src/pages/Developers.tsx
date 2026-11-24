/**
 * Settings → Developers: everything for a site or a system built outside
 * Floreo, in four parts.
 *
 *   Connect your site   a guide from nothing to products and a checkout on the business's own site
 *   Keys                publishable keys (for pages) and secret keys (for servers)
 *   Webhooks            endpoints, deliveries, tests
 *   Logs                usage by day and by key, what fails, and the requests of the last week, a page at a time
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import embedExample from '../../examples/html-embed/index.html?raw';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, Pager, Segmented, usePages } from '../ui';
import { UpgradeNotice } from './Billing';
import { CopyButton, saveFile, Spec, Step } from './NetSuiteAddons';
import { WebhooksPanel } from './Webhooks';

interface PublishableKey {
  id: string;
  key: string;
  name: string;
  mode: 'test' | 'live';
  origins: string[];
  createdAt: string;
  revokedAt: string | null;
}

interface Connect {
  data: PublishableKey[];
  mode: 'test' | 'live';
  store: string;
  storeOpen: boolean;
  apiUrl: string;
  embedUrl: string;
}

interface KeyUse {
  kind: 'secret' | 'publishable';
  id: string;
  name: string;
  revoked: boolean;
  requests: number;
  errors: number;
  lastDay: string;
}

interface Usage {
  days: Array<{ date: string; requests: number; errors: number }>;
  totals: { requests: number; errors: number };
  keys: KeyUse[];
  failures: Array<{ key: { kind: string; id: string; name: string }; method: string; route: string; status: number; code: string | null; count: number; lastDay: string }>;
}

interface LoggedRequest {
  at: string;
  method: string;
  path: string;
  route: string;
  status: number;
  code: string | null;
  message: string | null;
  ms: number;
  key: { kind: 'secret' | 'publishable'; id: string; name: string };
  origin: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The lines to paste into a page: the script tag with this store and key, and the pieces. */
export function embedSnippet(c: Pick<Connect, 'embedUrl' | 'store'>, key: string): string {
  return [
    '<!-- Your store, from Floreo. This key is a publishable key: it is meant to be in a page. -->',
    `<script src="${c.embedUrl}" data-store="${c.store}" data-key="${key}" async></script>`,
    '',
    '<!-- Your products, wherever this is on the page -->',
    '<floreo-products></floreo-products>',
    '',
    '<!-- The cart button, for example in your header -->',
    '<floreo-cart></floreo-cart>',
  ].join('\n');
}

/** A whole page to start from, for someone with no site yet: the worked example the browser tests run, with this store's values in it. */
function examplePage(c: Pick<Connect, 'embedUrl' | 'store'>, key: string): string {
  return embedExample.replaceAll('https://YOUR-FLOREO/embed.js', c.embedUrl).replaceAll('your-store', c.store).replaceAll('pk_test_YOUR_KEY', key);
}

function ModeBadge({ mode }: { mode: 'test' | 'live' }) {
  const t = useT();
  return <span className={`badge ${mode === 'live' ? 'authorized' : 'pending'}`}>{mode === 'live' ? t('Live') : t('Test')}</span>;
}

/** The sites a key may be used from: a list to add to and take from. */
function Sites({ k, onChanged }: { k: PublishableKey; onChanged: () => void }) {
  const t = useT();
  const [site, setSite] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async (origins: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/publishable-keys/${k.id}`, { method: 'PATCH', body: { origins } });
      setSite('');
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (site.trim()) void save([...k.origins, site.trim()]);
  };
  return (
    <div className="stack dev-sites">
      {k.origins.length > 0 && (
        <ul className="dev-site-list">
          {k.origins.map((o) => (
            <li key={o}><span className="mono">{o}</span><button type="button" className="link small" disabled={busy} onClick={() => void save(k.origins.filter((x) => x !== o))}>{t('Remove')}</button></li>
          ))}
        </ul>
      )}
      <form className="row guide-row" onSubmit={add}>
        <input type="text" inputMode="url" aria-label={t('Site address')} placeholder="https://www.example.bz" value={site} disabled={busy} onChange={(e) => setSite(e.target.value)} />
        <button type="submit" className="secondary" disabled={busy || !site.trim()}>{t('Add site')}</button>
      </form>
      <ErrorText error={error} />
    </div>
  );
}

// ---------- connect your site ----------

function ConnectGuide({ connect, reload, usage, loadUsage }: { connect: Connect; reload: () => Promise<void>; usage: Usage | null; loadUsage: () => Promise<void> }) {
  const t = useT();
  const toast = useToast();
  const [products, setProducts] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<LoggedRequest | null>(null);
  const [checking, setChecking] = useState(false);
  const key = connect.data.find((k) => !k.revokedAt && k.mode === connect.mode) ?? null;
  useEffect(() => {
    void api<{ data: unknown[] }>('/v1/products?status=active').then((r) => setProducts(r.data.length)).catch(() => setProducts(null));
  }, []);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/publishable-keys', { method: 'POST', body: { name: t('My website') } });
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const seen = key ? usage?.keys.find((u) => u.kind === 'publishable' && u.id === key.id) ?? null : null;
  const check = async () => {
    setChecking(true);
    try {
      await loadUsage();
      const r = key ? await api<{ data: LoggedRequest[] }>(`/v1/developer/requests?errors=1&key=${key.id}`) : { data: [] };
      setLastError(r.data[0] ?? null);
    } catch {
      /* the usage panel says so */
    } finally {
      setChecking(false);
    }
  };
  const snippet = key ? embedSnippet(connect, key.key) : '';
  const ready = connect.storeOpen && (products ?? 0) > 0;
  return (
    <section className="card stack">
      <div className="dev-title">
        <div className="row"><h2>{t('Connect your own site')}</h2><ModeBadge mode={connect.mode} /></div>
        <p className="muted small">{t('Built your site somewhere else? Sell from it with your Floreo store: your products, a cart, the checkout and every way to pay you have turned on. Each paid order gets its BTS receipt, as in your hosted store. About fifteen minutes.')}</p>
      </div>
      <ol className="guide">
        <Step n={1} title={t('Have something to sell, and open your store')} done={ready}>
          <span className="small muted">
            {products === null ? t('Add products under Sell → Products, then open the store in Settings → Online store.')
              : products === 0 ? t('You have no products for sale yet. Add one under Sell → Products and set it to “On sale”.')
                : !connect.storeOpen ? t('You have {n} products for sale. Your store is closed: open it in Settings → Online store (delivery, pickup and how buyers pay are set there too).', { n: products })
                  : t('{n} products for sale, and your store is open.', { n: products })}
          </span>
        </Step>
        <Step n={2} title={t('Make a publishable key')} done={Boolean(key)}>
          {key ? (
            <>
              <div className="row guide-row"><code className="mono dev-key">{key.key}</code><CopyButton text={key.key} label={t('Copy')} /></div>
              <span className="small muted">{t('This key is safe in a web page: it only opens your store’s public catalogue and checkout, and only from the sites you list. Your secret keys (etd_…) are a different thing and must never be put in a page.')}</span>
            </>
          ) : (
            <>
              <span className="small muted">{t('A publishable key says which store a page belongs to. It is safe to show: it cannot read your orders or change anything.')}</span>
              <div className="row guide-row"><button type="button" disabled={busy} onClick={() => void make()}>{busy ? t('Making it…') : t('Make a key')}</button></div>
              <ErrorText error={error} />
            </>
          )}
        </Step>
        <Step n={3} title={t('Paste this into your page')} done={Boolean(seen && seen.requests > 0)}>
          {key ? (
            <>
              <span className="small muted">{t('Put the script line in the page’s <head> (or anywhere, once). Put the other two lines where the products and the cart button should show. That is all: products open, go in the cart and check out on your own page.')}</span>
              <pre className="guide-code" tabIndex={0}>{snippet}</pre>
              <div className="row guide-row">
                <CopyButton text={snippet} label={t('Copy the lines')} />
                <button type="button" className="secondary small-button" onClick={() => { saveFile('my-store.html', examplePage(connect, key.key), 'text/html'); toast(t('Open my-store.html in your browser to see it work')); }}>{t('Download a page to start from')}</button>
              </div>
              <Spec rows={[[t('Script'), connect.embedUrl], ['data-store', connect.store], ['data-key', key.key], [t('API address'), connect.apiUrl]]} />
              <span className="small muted">{t('More pieces: a single product, a buy button, a checkout page of your own, your colours, Spanish.')} <a href="/docs#embed" target="_blank" rel="noreferrer">{t('See them all')} ↗</a></span>
            </>
          ) : <span className="small muted">{t('The lines to paste appear here once you have a key.')}</span>}
        </Step>
        <Step n={4} title={t('Say where your site is')} done={Boolean(key && key.origins.length)}>
          <span className="small muted">
            {connect.mode === 'test'
              ? t('While you build, any page on your own computer works with a test key (a file you open, or localhost). Before you put the page on the internet, add its address here: only listed sites may use the key.')
              : t('Only the sites listed here may use this key. Add every address your site answers on (with and without www).')}
          </span>
          {key && <Sites k={key} onChanged={() => void reload()} />}
        </Step>
        <Step n={5} title={t('Open your page and check')} done={Boolean(seen && seen.requests > seen.errors)}>
          <span className="small muted">{t('Open your page in a browser, then press Check. Add something to the cart and go through the checkout to try an order.')}</span>
          <div className="row guide-row">
            <button type="button" className="secondary" disabled={checking || !key} onClick={() => void check()}>{checking ? t('Checking…') : t('Check')}</button>
            {seen && <span className="small">{t('{n} requests from your site, last on {day}', { n: seen.requests, day: day(seen.lastDay) })}{seen.errors > 0 && ` · ${t('{n} refused', { n: seen.errors })}`}</span>}
            {key && usage && !seen && <span className="small muted">{t('Nothing yet from this key.')}</span>}
          </div>
          {lastError && <div className="banner warn" role="status"><div><strong>{t('The last request that was refused')}</strong>{lastError.message}{lastError.origin && <span className="small muted"> ({lastError.origin})</span>}</div></div>}
        </Step>
      </ol>
      <div className="banner info" role="note">
        <div>
          <strong>{connect.mode === 'test' ? t('You are in test mode') : t('Your store is live')}</strong>
          {connect.mode === 'test'
            ? t('Orders are real orders in your test business, but no money moves and receipts have no fiscal value. Turn on “Test payment” in Settings → Online store to try paying by card: the checkout shows a pretend card page. When your business goes live, make a live key (pk_live_…) and put it in your site; the test key stops working then.')
            : t('Orders are real, payments are real, and each paid order gets a BTS receipt. Test keys no longer work; to try changes safely, use a separate business that is still in test mode.')}
        </div>
      </div>
      <p className="small muted"><a href="/docs#quick-start" target="_blank" rel="noreferrer">{t('Quick start for developers: the same store with fetch or React')} ↗</a></p>
    </section>
  );
}

// ---------- keys ----------

function PublishableKeys({ connect, reload }: { connect: Connect; reload: () => Promise<void> }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError(null);
    try {
      await fn();
      if (message) toast(message);
      await reload();
    } catch (e) {
      setError(e);
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api('/v1/publishable-keys', { method: 'POST', body: { name: name.trim() } });
      setName('');
    }, t('Key made'));
  };
  const revoke = async (k: PublishableKey) => {
    if (!(await confirm({ title: t('Revoke the key “{name}”?', { name: k.name }), body: t('Every page that uses it stops showing your store at once. This cannot be undone; you can make a new key.'), confirm: t('Revoke key'), danger: true }))) return;
    await act(() => api(`/v1/publishable-keys/${k.id}`, { method: 'DELETE' }), t('Key revoked'));
  };
  // A new key with the same name and sites; the old one keeps working until it is revoked.
  const replace = (k: PublishableKey) => act(() => api('/v1/publishable-keys', { method: 'POST', body: { name: k.name, origins: k.origins } }), t('New key made. Put it in your site, then revoke the old one.'));
  const open = connect.data.find((k) => k.id === editing) ?? null;
  return (
    <section className="card stack">
      <div className="dev-title">
        <div className="row"><h2>{t('Publishable keys')}</h2><ModeBadge mode={connect.mode} /></div>
        <p className="muted small">{t('For pages: your own site showing your store. Safe to show. They open only your store’s public catalogue and checkout, from the sites you list.')}</p>
      </div>
      <form className="row" onSubmit={create}>
        <input placeholder={t('Name, e.g. Main website')} aria-label={t('Key name')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        <button type="submit">{t('Make a key')}</button>
      </form>
      <ErrorText error={error} />
      {connect.data.length === 0 ? <div className="empty">{t('No publishable keys yet.')}</div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Key')}</th><th scope="col">{t('Sites')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {connect.data.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'muted' : ''}>
                  <td data-label={t('Name')}>{k.name} <ModeBadge mode={k.mode} /></td>
                  <td data-label={t('Key')} className="mono small">{k.revokedAt ? `${k.key.slice(0, 16)}…` : k.key}</td>
                  <td data-label={t('Sites')} className="small">
                    {k.revokedAt ? t('Revoked') : k.origins.length ? k.origins.join(', ') : k.mode === 'test' ? t('Your own computer only') : t('None yet: it works nowhere')}
                    {!k.revokedAt && k.mode !== connect.mode && <div style={{ color: 'var(--coral-ink)' }}>{k.mode === 'test' ? t('A test key: your store is live, so it no longer works') : t('A live key: your store is in test mode')}</div>}
                  </td>
                  <td className="right">
                    {!k.revokedAt && (
                      <span className="row small dev-actions">
                        <CopyButton text={k.key} label={t('Copy')} />
                        <button type="button" className="link" onClick={() => setEditing(k.id)}>{t('Sites')}</button>
                        <button type="button" className="link" onClick={() => void replace(k)}>{t('Replace')}</button>
                        <button type="button" className="link danger-link" onClick={() => void revoke(k)}>{t('Revoke')}</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal title={t('Sites that may use “{name}”', { name: open.name })} onClose={() => setEditing(null)}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>{open.mode === 'test' ? t('A test key also works from any page on your own computer.') : t('A live key works only from these sites, over https.')}</p>
            <Sites k={open} onChanged={() => void reload()} />
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Done')}</button></div>
          </div>
        </Modal>
      )}
    </section>
  );
}

interface SecretKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function SecretKeys({ mode }: { mode: 'test' | 'live' }) {
  const t = useT();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<SecretKeyRow[]>([]);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: SecretKeyRow[] }>('/v1/api-keys').then((r) => setKeys(r.data)).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const make = async (keyName: string) => {
    setError(null);
    try {
      const k = await api<{ key: string }>('/v1/api-keys', { method: 'POST', body: { name: keyName } });
      setRevealed(k.key);
      setName('');
      await load();
    } catch (err) {
      setError(err);
    }
  };
  const revoke = async (k: SecretKeyRow) => {
    if (!(await confirm({ title: t('Revoke the key “{name}”?', { name: k.name }), body: t('Software using it is refused at once. This cannot be undone; you can make a new key.'), confirm: t('Revoke key'), danger: true }))) return;
    await api(`/v1/api-keys/${k.id}`, { method: 'DELETE' }).then(load).catch(setError);
  };
  return (
    <section className="card stack">
      <div className="dev-title">
        <div className="row"><h2>{t('Secret keys')}</h2><ModeBadge mode={mode} /></div>
        <p className="muted small">{t('For servers and your own software: a POS, your accounting system, your site’s back end. Each key acts as this business, so keep it out of web pages and out of code others can read.')}</p>
      </div>
      {revealed && (
        <div className="banner warn">
          <div style={{ width: '100%' }}>
            <strong>{t('Copy this key now. It will not be shown again.')}</strong>
            <div className="key-reveal mono">{revealed}</div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(revealed)}>{t('Copy')}</button>
              <button className="link" onClick={() => setRevealed(null)}>{t("I've saved it")}</button>
            </div>
          </div>
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void make(name); }}>
        <input placeholder={t('Name, e.g. Front counter POS')} aria-label={t('Key name')} required value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        <button type="submit">{t('Create key')}</button>
      </form>
      <ErrorText error={error} />
      {keys.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Key')}</th><th scope="col">{t('Last used')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'muted' : ''}>
                  <td data-label={t('Name')}>{k.name}</td>
                  <td data-label={t('Key')} className="mono">etd_{k.prefix}_…</td>
                  <td data-label={t('Last used')}>{k.revokedAt ? t('Revoked') : k.lastUsedAt ? when(k.lastUsedAt) : t('Never')}</td>
                  <td className="right">
                    {!k.revokedAt && (
                      <span className="row small dev-actions">
                        <button type="button" className="link" title={t('Make a new key with this name; revoke this one once your software uses the new one')} onClick={() => void make(k.name)}>{t('Replace')}</button>
                        <button type="button" className="link danger-link" onClick={() => void revoke(k)}>{t('Revoke')}</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">{t('To change a key without a gap: Replace makes a new one with the same name; put it in your software, check under Logs that the old one has gone quiet, then revoke the old one.')}</p>
    </section>
  );
}

// ---------- logs ----------

function LogsPanel({ usage, loadUsage, usageError }: { usage: Usage | null; loadUsage: () => Promise<void>; usageError: unknown }) {
  const t = useT();
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [keptDays, setKeptDays] = useState(7);
  // Kept for a week on the server: a page at a time, newest first.
  const pages = usePages<LoggedRequest>(async (cursor) => {
    const p = new URLSearchParams({ limit: '50' });
    if (onlyErrors) p.set('errors', '1');
    if (cursor) p.set('cursor', cursor);
    const r = await api<{ data: LoggedRequest[]; nextCursor: string | null; keptDays: number }>(`/v1/developer/requests?${p}`);
    setKeptDays(r.keptDays);
    return { data: r.data, next: r.nextCursor };
  }, onlyErrors ? 'failed' : 'all');
  const requests = pages.rows;
  const error = pages.error;
  const busy = pages.loading;
  const load = pages.reload;
  const peak = Math.max(1, ...(usage?.days.map((d) => d.requests) ?? [1]));
  return (
    <>
      <section className="card stack">
        <div className="row">
          <div>
            <h2>{t('Usage')}</h2>
            <p className="muted small">{t('Requests made with your keys in the last 14 days, and how many were refused or failed.')}</p>
          </div>
          <span className="spacer" />
          <button type="button" className="secondary small-button" disabled={busy} onClick={() => { void loadUsage(); void load(); }}>{t('Refresh')}</button>
        </div>
        <ErrorText error={usageError} />
        {!usage ? !usageError && <div className="skeleton" style={{ height: '8rem' }} /> : usage.totals.requests === 0 ? <div className="empty">{t('No requests yet. They show here as soon as a key is used.')}</div> : (
          <>
            <div className="row dev-totals">
              <div><span className="kicker">{t('Requests')}</span><strong>{usage.totals.requests.toLocaleString()}</strong></div>
              <div><span className="kicker">{t('Refused or failed')}</span><strong>{usage.totals.errors.toLocaleString()}</strong></div>
            </div>
            <ol className="dev-days" aria-label={t('Requests by day')}>
              {usage.days.map((d) => (
                <li key={d.date} title={`${day(d.date)}: ${d.requests} · ${d.errors}`}>
                  <span className="dev-bar" style={{ height: `${Math.round((d.requests / peak) * 100)}%` }}><span className="dev-bar-bad" style={{ height: d.requests ? `${Math.round((d.errors / d.requests) * 100)}%` : 0 }} /></span>
                  <span className="sr-only">{t('{day}: {n} requests, {e} refused or failed', { day: day(d.date), n: d.requests, e: d.errors })}</span>
                </li>
              ))}
            </ol>
            <div className="row small muted dev-axis"><span>{day(usage.days[0]!.date)}</span><span className="spacer" /><span>{day(usage.days.at(-1)!.date)}</span></div>
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Key')}</th><th scope="col" className="right">{t('Requests')}</th><th scope="col" className="right">{t('Refused or failed')}</th><th scope="col">{t('Last used')}</th></tr></thead>
                <tbody>
                  {usage.keys.map((k) => (
                    <tr key={`${k.kind}-${k.id}`}>
                      <td data-label={t('Key')}>{k.name} <span className="small muted">{k.kind === 'publishable' ? t('publishable') : t('secret')}{k.revoked && ` · ${t('Revoked')}`}</span></td>
                      <td data-label={t('Requests')} className="right">{k.requests.toLocaleString()}</td>
                      <td data-label={t('Refused or failed')} className="right">{k.errors.toLocaleString()}</td>
                      <td data-label={t('Last used')}>{day(k.lastDay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {usage && usage.failures.length > 0 && (
        <section className="card stack">
          <div>
            <h2>{t('What fails')}</h2>
            <p className="muted small">{t('Requests that were refused or failed, most often first. The code is the error’s code in the answer; the reference says what each one means.')} <a href="/docs#errors" target="_blank" rel="noreferrer">{t('Error codes')} ↗</a></p>
          </div>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Endpoint')}</th><th scope="col">{t('Answer')}</th><th scope="col">{t('Key')}</th><th scope="col" className="right">{t('Times')}</th><th scope="col">{t('Last')}</th></tr></thead>
              <tbody>
                {usage.failures.map((f, i) => (
                  <tr key={i}>
                    <td data-label={t('Endpoint')} className="mono small">{f.method} {f.route}</td>
                    <td data-label={t('Answer')}><span className="badge rejected">{f.status}</span> <span className="mono small">{f.code}</span></td>
                    <td data-label={t('Key')} className="small">{f.key.name}</td>
                    <td data-label={t('Times')} className="right">{f.count.toLocaleString()}</td>
                    <td data-label={t('Last')} className="small">{day(f.lastDay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card stack">
        <div className="row">
          <div>
            <h2>{t('Latest requests')}</h2>
            <p className="muted small">{t('Requests made with your keys in the last {n} days, newest first. Only the address is kept, never what was sent.', { n: keptDays })}</p>
          </div>
          <span className="spacer" />
          <label className="row small"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> {t('Only refused or failed')}</label>
        </div>
        <ErrorText error={error} />
        {!requests ? !error && <div className="skeleton" style={{ height: '6rem' }} /> : requests.length === 0 ? <div className="empty">{onlyErrors ? t('Nothing was refused.') : t('No requests in that time.')}</div> : (
          <>
          <div className="table-wrap">
            <table className="responsive dev-requests">
              <thead><tr><th scope="col">{t('When')}</th><th scope="col">{t('Request')}</th><th scope="col">{t('Answer')}</th><th scope="col">{t('Key')}</th></tr></thead>
              <tbody>
                {requests.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td data-label={t('When')} className="small">{new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}<div className="muted">{new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div></td>
                    <td data-label={t('Request')} className="small"><span className="mono">{r.method} {r.path}</span>{r.origin && <div className="muted">{t('from {site}', { site: r.origin })}</div>}</td>
                    <td data-label={t('Answer')} className="small">
                      <span className={`badge ${r.status >= 400 ? 'rejected' : 'authorized'}`}>{r.status}</span> <span className="muted">{r.ms} ms</span>
                      {r.code && <div><span className="mono">{r.code}</span>{r.message && <div className="muted">{r.message}</div>}</div>}
                    </td>
                    <td data-label={t('Key')} className="small">{r.key.name}<div className="muted">{r.key.kind === 'publishable' ? t('publishable') : t('secret')}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager pages={pages} newest />
          </>
        )}
      </section>
    </>
  );
}

// ---------- the tab ----------

type Part = 'connect' | 'keys' | 'webhooks' | 'logs';

export function DevelopersTab() {
  const t = useT();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const features = me?.billing?.features ?? [];
  const hasStore = !me?.billing || features.includes('store');
  const parts = useMemo<Array<[Part, string]>>(() => [
    ...(hasStore ? [['connect', t('Connect your site')] as [Part, string]] : []),
    ['keys', t('Keys')], ['webhooks', t('Webhooks')], ['logs', t('Logs')],
  ], [hasStore, t]);
  const asked = params.get('part') as Part | null;
  const part: Part = parts.some(([k]) => k === asked) ? asked! : parts[0]![0];
  const [connect, setConnect] = useState<Connect | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [usageError, setUsageError] = useState<unknown>(null);
  const reload = useCallback(() => api<Connect>('/v1/publishable-keys').then(setConnect).catch(setError), []);
  const loadUsage = useCallback(() => api<Usage>('/v1/developer/usage').then((u) => { setUsage(u); setUsageError(null); }).catch(setUsageError), []);
  useEffect(() => {
    void reload();
    void loadUsage();
  }, [reload, loadUsage]);
  return (
    <div className="stack">
      <div className="row dev-head">
        <Segmented label={t('Developers')} value={part} switches onChange={(v) => setParams({ tab: 'keys', part: v }, { replace: true })} options={parts} />
        <span className="spacer" />
        <a className="small" href="/docs" target="_blank" rel="noreferrer">{t('API reference')} ↗</a>
      </div>
      <ErrorText error={error} />
      {part === 'connect' && (connect ? <ConnectGuide connect={connect} reload={reload} usage={usage} loadUsage={loadUsage} /> : !error && <div className="skeleton" style={{ height: '20rem' }} />)}
      {part === 'keys' && (
        <>
          {hasStore && (connect ? <PublishableKeys connect={connect} reload={reload} /> : !error && <div className="skeleton" style={{ height: '8rem' }} />)}
          <SecretKeys mode={connect?.mode ?? 'test'} />
        </>
      )}
      {part === 'webhooks' && (me?.billing && !features.includes('webhooks') ? <UpgradeNotice feature="webhooks" /> : <WebhooksPanel />)}
      {part === 'logs' && <LogsPanel usage={usage} loadUsage={loadUsage} usageError={usageError} />}
    </div>
  );
}
