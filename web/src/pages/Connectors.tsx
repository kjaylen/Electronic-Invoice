/**
 * Settings → Integrations: QuickBooks Desktop and QuickBooks Point of Sale,
 * for businesses that keep invoicing in QuickBooks and send it to BTS here.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { belizeToday, ErrorText, Field, Modal, money, Segmented, Select } from '../ui';
import { usePollWhile } from './Dashboard';

type Kind = 'qbd' | 'qbpos';
interface ConnectorLink {
  id: string;
  kind: Kind;
  kindName: string;
  name: string;
  username: string;
  paused: boolean;
  syncFrom: string;
  company: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  settings: { taxCodes: Record<string, 'S' | 'Z' | 'E'>; exemptions: Record<string, string>; pull: { invoices: boolean; salesReceipts: boolean }; issueOnTaxMismatch: boolean };
  taxCodesSeen: string[];
  counts: Record<string, number>;
}
interface ImportRow {
  id: string;
  linkId: string;
  source: { type: 'invoice' | 'sales_receipt' | 'credit_memo' | 'pos_receipt'; ref: string | null; date: string | null; customer: string | null; total: string | null };
  status: 'new' | 'issued' | 'rejected' | 'attention' | 'skipped';
  problem: string | null;
  writeback: 'none' | 'pending' | 'done' | 'failed';
  writebackError: string | null;
  document: { id: string; number: string | null; status: string | null } | null;
  createdAt: string;
}

const SOURCE_NAMES: Record<ImportRow['source']['type'], string> = { invoice: 'Invoice', sales_receipt: 'Sales receipt', credit_memo: 'Credit memo', pos_receipt: 'POS receipt' };

function DesktopLogo() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <rect x="2" y="6" width="36" height="24" rx="4" fill="#2ca01c" />
      <path d="M14 34h12M20 30v4" stroke="#2ca01c" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M13 13h3v10h-1a4.5 4.5 0 0 1-4.5-4.5v-1A4.5 4.5 0 0 1 13 13Zm14 10h-3V13h1a4.5 4.5 0 0 1 4.5 4.5v1A4.5 4.5 0 0 1 27 23Z" fill="#fff" />
    </svg>
  );
}

const ago = (t: ReturnType<typeof useT>, iso: string | null) => {
  if (!iso) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{n} min ago', { n: minutes });
  if (minutes < 48 * 60) return t('{n} h ago', { n: Math.round(minutes / 60) });
  return new Date(iso).toLocaleDateString();
};

export function ConnectorsSection() {
  const t = useT();
  const toast = useToast();
  const [links, setLinks] = useState<ConnectorLink[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<Kind | null>(null);
  const [credentials, setCredentials] = useState<{ id: string; kind: Kind; username: string; password: string } | null>(null);
  const [view, setView] = useState<'attention' | 'issued' | 'all'>('attention');
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const load = useCallback(() => {
    void api<{ data: ConnectorLink[] }>('/v1/connectors').then((r) => setLinks(r.data)).catch(setError);
  }, []);
  const loadImports = useCallback(() => {
    void api<{ data: ImportRow[] }>(`/v1/connectors/imports?status=${view === 'attention' ? 'attention' : view}`).then(async (r) => {
      // "Needs attention" includes what BTS rejected.
      if (view === 'attention') {
        const rejected = await api<{ data: ImportRow[] }>('/v1/connectors/imports?status=rejected');
        setImports([...r.data, ...rejected.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      } else setImports(r.data);
    }).catch(setError);
  }, [view]);
  useEffect(() => load(), [load]);
  useEffect(() => loadImports(), [loadImports]);
  // While documents are on their way to BTS, keep the page current.
  const sending = links?.some((l) => (l.counts.new ?? 0) + (l.counts.issuing ?? 0) > 0) ?? false;
  usePollWhile(sending, () => { load(); loadImports(); }, 3000);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast(message);
      load();
      loadImports();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };

  return (
    <section className="card stack integration">
      <div className="row">
        <DesktopLogo />
        <div>
          <h2 style={{ margin: 0 }}>{t('QuickBooks Desktop and Point of Sale')}</h2>
          <p className="small muted" style={{ margin: 0 }}>{t('Keep invoicing in QuickBooks. Each invoice and receipt is sent to BTS from here, and the BTS number goes back into QuickBooks (Desktop).')}</p>
        </div>
      </div>
      <div className="row">
        <button onClick={() => setAdding('qbd')}>{t('Connect QuickBooks Desktop')}</button>
        <button className="secondary" onClick={() => setAdding('qbpos')}>{t('Connect QuickBooks Point of Sale')}</button>
        <span className="small muted">{t('Through the QuickBooks Web Connector, on the computer that runs QuickBooks.')}</span>
      </div>
      <ErrorText error={error} />

      {links?.map((l) => <LinkCard key={l.id} link={l} onChanged={() => { load(); loadImports(); }} onCredentials={(c) => setCredentials({ id: l.id, kind: l.kind, ...c })} act={act} />)}

      {links && links.length > 0 && (
        <div className="stack">
          <div className="row">
            <h3 style={{ margin: 0 }}>{t('Documents from QuickBooks')}</h3>
            <span className="spacer" />
            <Segmented label={t('Show')} value={view} onChange={setView} options={[['attention', t('Needs attention')], ['issued', t('Sent to BTS')], ['all', t('All')]]} />
          </div>
          {imports === null ? <div className="skeleton" style={{ height: '5rem' }} /> : imports.length === 0 ? (
            <p className="muted small">{view === 'attention' ? t('Nothing needs you: everything picked up was sent to BTS.') : t('Nothing picked up yet. The Web Connector checks every 5 minutes.')}</p>
          ) : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('In QuickBooks')}</th><th scope="col">{t('Customer')}</th><th scope="col" className="num">{t('Before tax')}</th><th scope="col">{t('Here')}</th></tr></thead>
                <tbody>
                  {imports.map((r) => (
                    <tr key={r.id}>
                      <td data-label={t('In QuickBooks')}><strong>{t(SOURCE_NAMES[r.source.type])} {r.source.ref ?? ''}</strong><div className="small muted">{r.source.date}</div></td>
                      <td data-label={t('Customer')}>{r.source.customer ?? '—'}</td>
                      <td data-label={t('Before tax')} className="num">{r.source.total ? money(r.source.total) : '—'}</td>
                      <td data-label={t('Here')}>
                        {r.status === 'issued' && r.document ? (
                          <>
                            <Link to={`/documents/${r.document.id}`}>{r.document.number}</Link> <span className="badge authorized">{t('Sent to BTS')}</span>
                            {r.writeback === 'done' && <div className="small muted">{t('BTS number written in QuickBooks')}</div>}
                            {r.writeback === 'pending' && <div className="small muted">{t('Written in QuickBooks at the next check')}</div>}
                            {r.writeback === 'failed' && <div className="small" style={{ color: 'var(--coral-ink)' }}>{r.writebackError}</div>}
                          </>
                        ) : r.status === 'new' ? <span className="badge pending">{t('Sending')}</span> : r.status === 'skipped' ? <span className="badge cancelled">{t('Skipped')}</span> : (
                          <span className={`badge ${r.status === 'rejected' ? 'rejected' : 'pending'}`}>{r.status === 'rejected' ? t('Rejected by BTS') : t('Needs attention')}</span>
                        )}
                        {r.problem && <div className="small connector-problem">{r.problem}</div>}
                        {(r.status === 'attention' || r.status === 'rejected') && (
                          <div className="row" style={{ gap: '0.35rem', marginTop: '0.35rem' }}>
                            <button className="secondary small-button" onClick={() => void act(() => api(`/v1/connectors/imports/${r.id}/retry`, { method: 'POST', body: {} }), t('Sending it again'))}>{t('Send again')}</button>
                            {r.problem?.includes('GST (12.5%)') && <button className="secondary small-button" onClick={() => void act(() => api(`/v1/connectors/imports/${r.id}/retry`, { method: 'POST', body: { force: true } }), t('Issuing it with GST at 12.5%'))}>{t('Issue anyway')}</button>}
                            <button className="link small" onClick={() => void act(() => api(`/v1/connectors/imports/${r.id}/skip`, { method: 'POST' }), t('Skipped'))}>{t('Skip')}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {adding && <AddConnection kind={adding} onClose={() => setAdding(null)} onAdded={(c) => { setAdding(null); setCredentials(c); load(); }} />}
      {credentials && <Credentials {...credentials} onClose={() => setCredentials(null)} />}
    </section>
  );
}

function LinkCard({ link: l, onChanged, onCredentials, act }: { link: ConnectorLink; onChanged: () => void; onCredentials: (c: { username: string; password: string }) => void; act: (fn: () => Promise<unknown>, message: string) => Promise<void> }) {
  const t = useT();
  const codes = [...new Set([...l.taxCodesSeen, ...Object.keys(l.settings.taxCodes)])].sort();
  const builtIn = (c: string) => (/^tax$/i.test(c) ? 'S' : /^non$/i.test(c) ? 'Z' : '');
  // What was picked here and not saved yet, over what is saved (or built in).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const map: Record<string, string> = Object.fromEntries(codes.map((c) => [c, edits[c] ?? l.settings.taxCodes[c] ?? builtIn(c)]));
  const [taxesOpen, setTaxesOpen] = useState(() => codes.some((c) => !map[c]));
  const [reasons, setReasons] = useState<Record<string, string>>(l.settings.exemptions);
  const seen = ago(t, l.lastSeenAt);
  const save = () => act(() => api(`/v1/connectors/${l.id}`, {
    method: 'PUT',
    body: { taxCodes: Object.fromEntries(Object.entries(map).filter(([, v]) => v)), exemptions: Object.fromEntries(Object.entries(reasons).filter(([c]) => map[c] === 'E')) },
  }), t('Tax codes saved'));
  return (
    <div className="connector-link stack">
      <div className="row">
        <div>
          <strong>{l.name}</strong> <span className="muted small">· {l.kindName}{l.company && ` · ${l.company}`}</span>
          <div className="small muted">
            {l.paused ? t('Paused') : seen ? t('Last check-in {when}', { when: seen }) : t('Not connected yet: add the .qwc file to the Web Connector.')}
            {' · '}{t('documents dated from {date}', { date: l.syncFrom })}
          </div>
        </div>
        <span className="spacer" />
        {(l.counts.issued ?? 0) > 0 && <span className="badge authorized">{t('{n} sent', { n: l.counts.issued ?? 0 })}</span>}
        {((l.counts.attention ?? 0) + (l.counts.rejected ?? 0)) > 0 && <span className="badge pending">{t('{n} need attention', { n: (l.counts.attention ?? 0) + (l.counts.rejected ?? 0) })}</span>}
      </div>
      {l.lastError && <div className="banner warn"><div><strong>{t('Last check-in had a problem')}</strong>{l.lastError}</div></div>}
      <div className="row" style={{ gap: '0.4rem' }}>
        <a className="button secondary small-button" href={link(`/v1/connectors/${l.id}/qwc`)} download>{t('Download the .qwc file')}</a>
        <button className="secondary small-button" onClick={() => void api<{ username: string; password: string }>(`/v1/connectors/${l.id}/password`, { method: 'POST' }).then(onCredentials)}>{t('New password')}</button>
        <button className="secondary small-button" onClick={() => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { paused: !l.paused } }), l.paused ? t('Resumed') : t('Paused'))}>{l.paused ? t('Resume') : t('Pause')}</button>
        <span className="spacer" />
        <button className="link danger-link small" onClick={() => { if (window.confirm(t('Disconnect {name}? What was already sent to BTS stays.', { name: l.name }))) void act(() => api(`/v1/connectors/${l.id}`, { method: 'DELETE' }), t('Disconnected')); }}>{t('Disconnect')}</button>
      </div>
      {codes.length > 0 && (
        <details className="connector-taxes" open={taxesOpen} onToggle={(e) => setTaxesOpen(e.currentTarget.open)}>
          <summary>{t('Tax codes')} {codes.some((c) => !map[c]) && <span className="badge pending">{t('Some not mapped')}</span>}</summary>
          <p className="small muted">{t('Which GST each QuickBooks tax code means. Documents with a code not mapped wait here until it is.')}</p>
          <div className="connector-codes">
            {codes.map((c) => (
              <div key={c} className="row">
                <span className="mono connector-code">{c}</span>
                <Select value={map[c] ?? ''} onChange={(e) => setEdits({ ...edits, [c]: e.target.value })} aria-label={t('GST for {code}', { code: c })}>
                  <option value="">{t('Not mapped')}</option>
                  <option value="S">{t('GST 12.5%')}</option>
                  <option value="Z">{t('Zero-rated (0%)')}</option>
                  <option value="E">{t('Exempt')}</option>
                </Select>
                {map[c] === 'E' && <input className="connector-reason" placeholder={t('Exemption reason code')} value={reasons[c] ?? ''} onChange={(e) => setReasons({ ...reasons, [c]: e.target.value })} />}
              </div>
            ))}
          </div>
          <div className="row">
            <button className="secondary small-button" onClick={() => void save()}>{t('Save tax codes')}</button>
            <label className="row small" style={{ gap: '0.4rem' }}>
              <input type="checkbox" checked={l.settings.issueOnTaxMismatch} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { issueOnTaxMismatch: e.target.checked } }), t('Saved'))} />
              {t('Send even when QuickBooks charged a different tax than 12.5% GST')}
            </label>
          </div>
        </details>
      )}
      {l.kind === 'qbd' && (
        <div className="row small" style={{ gap: '1rem' }}>
          <label className="row" style={{ gap: '0.4rem' }}><input type="checkbox" checked={l.settings.pull.invoices} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { pull: { invoices: e.target.checked } } }), t('Saved'))} /> {t('Invoices')}</label>
          <label className="row" style={{ gap: '0.4rem' }}><input type="checkbox" checked={l.settings.pull.salesReceipts} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { pull: { salesReceipts: e.target.checked } } }), t('Saved'))} /> {t('Sales receipts')}</label>
          <button type="button" className="link small" onClick={onChanged}>{t('Refresh')}</button>
        </div>
      )}
    </div>
  );
}

function AddConnection({ kind, onClose, onAdded }: { kind: Kind; onClose: () => void; onAdded: (c: { id: string; kind: Kind; username: string; password: string }) => void }) {
  const t = useT();
  const [name, setName] = useState(kind === 'qbd' ? t('QuickBooks Desktop') : t('QuickBooks Point of Sale'));
  const [syncFrom, setSyncFrom] = useState(belizeToday());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: string; kind: Kind; username: string; password: string }>('/v1/connectors', { method: 'POST', body: { kind, name, syncFrom } });
      onAdded(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === 'qbd' ? t('Connect QuickBooks Desktop') : t('Connect QuickBooks Point of Sale')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('Name')} hint={t('To tell connections apart, e.g. the office or the shop.')}><input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Send documents dated from')} hint={t('Older ones in QuickBooks are left alone.')}><input type="date" required value={syncFrom} onChange={(e) => setSyncFrom(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Continue')}</button></div>
      </form>
    </Modal>
  );
}

function Credentials({ id, kind, username, password, onClose }: { id: string; kind: Kind; username: string; password: string; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('Add it to the Web Connector')} onClose={onClose}>
      <div className="stack">
        <ol className="connector-steps">
          <li>{kind === 'qbd' ? t('Open QuickBooks Desktop with your company file, signed in as the administrator.') : t('Open QuickBooks Point of Sale on the store\'s server computer.')}</li>
          <li>{t('Download the .qwc file below and open it: the Web Connector asks to add the application.')} <a className="button small-button" href={link(`/v1/connectors/${id}/qwc`)} download>{t('Download the .qwc file')}</a></li>
          <li>{t('QuickBooks asks whether to allow it: choose "Yes, always; allow access even if QuickBooks is not running".')}</li>
          <li>{t('In the Web Connector, enter the password below, tick Auto-Run and click Update Selected.')}</li>
        </ol>
        <dl className="facts">
          <dt>{t('User name')}</dt><dd className="mono">{username}</dd>
          <dt>{t('Password')}</dt><dd className="mono connector-secret">{password}</dd>
        </dl>
        <p className="small muted">{t('Copy the password now: it is not shown again (you can make a new one). Every 5 minutes the Web Connector sends new documents here and writes back the BTS numbers.')}</p>
        <div className="row"><span className="spacer" /><button onClick={onClose}>{t('Done')}</button></div>
      </div>
    </Modal>
  );
}
