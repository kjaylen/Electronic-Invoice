/**
 * Settings → Integrations: QuickBooks Desktop, QuickBooks Point of Sale and
 * NetSuite, for businesses that keep invoicing in their own system and send
 * it to BTS here.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { belizeToday, ErrorText, Field, Modal, money, Segmented, Select } from '../ui';
import { usePollWhile } from './Dashboard';

type Kind = 'qbd' | 'qbpos' | 'netsuite';
interface NetSuiteDetails {
  accountId: string | null;
  clientId: string | null;
  certificateId: string | null;
  numberField: string;
  statusField: string | null;
  configured: boolean;
  certificateExpiresAt: string | null;
  nextCheckAt: string | null;
}
interface ConnectorLink {
  id: string;
  kind: Kind;
  kindName: string;
  name: string;
  username: string | null;
  netsuite: NetSuiteDetails | null;
  paused: boolean;
  syncFrom: string;
  company: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  settings: { taxCodes: Record<string, 'S' | 'Z' | 'E'>; exemptions: Record<string, string>; pull: { invoices: boolean; salesReceipts: boolean; creditMemos: boolean }; issueOnTaxMismatch: boolean };
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
/** NetSuite calls a sales receipt a cash sale. */
const sourceName = (type: ImportRow['source']['type'], kind: Kind | undefined) => (kind === 'netsuite' && type === 'sales_receipt' ? 'Cash sale' : SOURCE_NAMES[type]);
const systemOf = (kind: Kind | undefined) => (kind === 'netsuite' ? 'NetSuite' : 'QuickBooks');

/** Two systems, one line between them. */
function SystemsLogo() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="10" fill="#f3ecf8" />
      <rect x="7" y="11" width="11" height="18" rx="2.5" fill="none" stroke="#5f2788" strokeWidth="2" />
      <rect x="22" y="11" width="11" height="18" rx="2.5" fill="#5f2788" />
      <path d="M18 17h4M18 23h4" stroke="#5f2788" strokeWidth="2" strokeLinecap="round" />
      <path d="M25 16h5M25 20h5M25 24h3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
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
  const [setup, setSetup] = useState<string | null>(null);
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
        <SystemsLogo />
        <div>
          <h2 style={{ margin: 0 }}>{t('QuickBooks Desktop, Point of Sale and NetSuite')}</h2>
          <p className="small muted" style={{ margin: 0 }}>{t('Keep invoicing in your own system. Each invoice and receipt is sent to BTS from here, and the BTS number goes back into QuickBooks Desktop or NetSuite.')}</p>
        </div>
      </div>
      <div className="row">
        <button onClick={() => setAdding('qbd')}>{t('Connect QuickBooks Desktop')}</button>
        <button className="secondary" onClick={() => setAdding('qbpos')}>{t('Connect QuickBooks Point of Sale')}</button>
        <button className="secondary" onClick={() => setAdding('netsuite')}>{t('Connect NetSuite')}</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('QuickBooks connects through the Web Connector, on the computer that runs it. NetSuite is read from here through its REST web services.')}</p>
      <ErrorText error={error} />

      {links?.map((l) => <LinkCard key={l.id} link={l} onChanged={() => { load(); loadImports(); }} onCredentials={(c) => setCredentials({ id: l.id, kind: l.kind, ...c })} onSetup={() => setSetup(l.id)} act={act} />)}

      {links && links.length > 0 && (
        <div className="stack">
          <div className="row">
            <h3 style={{ margin: 0 }}>{t('Documents picked up')}</h3>
            <span className="spacer" />
            <Segmented label={t('Show')} value={view} onChange={setView} options={[['attention', t('Needs attention')], ['issued', t('Sent to BTS')], ['all', t('All')]]} />
          </div>
          {imports === null ? <div className="skeleton" style={{ height: '5rem' }} /> : imports.length === 0 ? (
            <p className="muted small">{view === 'attention' ? t('Nothing needs you: everything picked up was sent to BTS.') : t('Nothing picked up yet. QuickBooks and NetSuite are checked every 5 minutes.')}</p>
          ) : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Original')}</th><th scope="col">{t('Customer')}</th><th scope="col" className="num">{t('Before tax')}</th><th scope="col">{t('Here')}</th></tr></thead>
                <tbody>
                  {imports.map((r) => {
                    const from = links?.find((l) => l.id === r.linkId);
                    const system = systemOf(from?.kind);
                    return (
                    <tr key={r.id}>
                      <td data-label={t('Original')}><strong>{t(sourceName(r.source.type, from?.kind))} {r.source.ref ?? ''}</strong><div className="small muted">{[from?.name, r.source.date].filter(Boolean).join(' · ')}</div></td>
                      <td data-label={t('Customer')}>{r.source.customer ?? '—'}</td>
                      <td data-label={t('Before tax')} className="num">{r.source.total ? money(r.source.total) : '—'}</td>
                      <td data-label={t('Here')}>
                        {r.status === 'issued' && r.document ? (
                          <>
                            <Link to={`/documents/${r.document.id}`}>{r.document.number}</Link> <span className="badge authorized">{t('Sent to BTS')}</span>
                            {r.writeback === 'done' && <div className="small muted">{t('BTS number written in {system}', { system })}</div>}
                            {r.writeback === 'pending' && <div className="small muted">{t('Written in {system} at the next check', { system })}</div>}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {adding && <AddConnection kind={adding} onClose={() => setAdding(null)} onAdded={(c) => { setAdding(null); if (c.kind === 'netsuite') setSetup(c.id); else setCredentials(c as { id: string; kind: Kind; username: string; password: string }); load(); }} />}
      {credentials && <Credentials {...credentials} onClose={() => setCredentials(null)} />}
      {setup && links?.find((l) => l.id === setup) && <NetSuiteSetup link={links.find((l) => l.id === setup)!} onClose={() => setSetup(null)} onSaved={() => { setSetup(null); load(); toast(t('Connected to NetSuite: it is read every 5 minutes')); }} />}
    </section>
  );
}

function LinkCard({ link: l, onChanged, onCredentials, onSetup, act }: { link: ConnectorLink; onChanged: () => void; onCredentials: (c: { username: string; password: string }) => void; onSetup: () => void; act: (fn: () => Promise<unknown>, message: string) => Promise<void> }) {
  const t = useT();
  const codes = [...new Set([...l.taxCodesSeen, ...Object.keys(l.settings.taxCodes)])].sort();
  const builtIn = (c: string) => (/^tax$/i.test(c) ? 'S' : /^non$/i.test(c) ? 'Z' : '');
  // What was picked here and not saved yet, over what is saved (or built in).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const map: Record<string, string> = Object.fromEntries(codes.map((c) => [c, edits[c] ?? l.settings.taxCodes[c] ?? builtIn(c)]));
  const [taxesOpen, setTaxesOpen] = useState(() => codes.some((c) => !map[c]));
  const [reasons, setReasons] = useState<Record<string, string>>(l.settings.exemptions);
  const seen = ago(t, l.lastSeenAt);
  const ns = l.netsuite;
  const system = systemOf(l.kind);
  const certDays = ns?.certificateExpiresAt ? Math.floor((new Date(ns.certificateExpiresAt).getTime() - Date.now()) / 86_400_000) : null;
  const notYet = ns ? (ns.configured ? t('Connected: the first read is on its way.') : t('Not connected yet: finish the NetSuite setup.')) : t('Not connected yet: add the .qwc file to the Web Connector.');
  const save = () => act(() => api(`/v1/connectors/${l.id}`, {
    method: 'PUT',
    body: { taxCodes: Object.fromEntries(Object.entries(map).filter(([, v]) => v)), exemptions: Object.fromEntries(Object.entries(reasons).filter(([c]) => map[c] === 'E')) },
  }), t('Tax codes saved'));
  return (
    <div className="connector-link stack">
      <div className="row">
        <div>
          <strong>{l.name}</strong> {[l.name !== l.kindName && l.kindName, l.company].some(Boolean) && <span className="muted small">· {[l.name !== l.kindName && l.kindName, l.company].filter(Boolean).join(' · ')}</span>}
          <div className="small muted">
            {l.paused ? t('Paused') : seen ? t('Last check-in {when}', { when: seen }) : notYet}
            {' · '}{t('documents dated from {date}', { date: l.syncFrom })}
          </div>
        </div>
        <span className="spacer" />
        {(l.counts.issued ?? 0) > 0 && <span className="badge authorized">{t('{n} sent', { n: l.counts.issued ?? 0 })}</span>}
        {((l.counts.attention ?? 0) + (l.counts.rejected ?? 0)) > 0 && <span className="badge pending">{t('{n} need attention', { n: (l.counts.attention ?? 0) + (l.counts.rejected ?? 0) })}</span>}
      </div>
      {l.lastError && <div className="banner warn"><div><strong>{t('Last check-in had a problem')}</strong>{l.lastError}</div></div>}
      {certDays !== null && certDays < 60 && <div className="banner warn"><div><strong>{t('The NetSuite certificate expires in {n} days')}</strong>{t('Disconnect and connect NetSuite again for a new certificate, and upload it in NetSuite.')}</div></div>}
      <div className="row" style={{ gap: '0.4rem' }}>
        {ns ? (
          <>
            {ns.configured ? (
              <button className="secondary small-button" onClick={() => void act(() => api(`/v1/connectors/${l.id}/sync`, { method: 'POST' }), t('Reading NetSuite now'))}>{t('Check now')}</button>
            ) : <button className="small-button" onClick={onSetup}>{t('Finish the setup')}</button>}
            <button className="secondary small-button" onClick={onSetup}>{t('NetSuite details')}</button>
          </>
        ) : (
          <>
            <a className="button secondary small-button" href={link(`/v1/connectors/${l.id}/qwc`)} download>{t('Download the .qwc file')}</a>
            <button className="secondary small-button" onClick={() => void api<{ username: string; password: string }>(`/v1/connectors/${l.id}/password`, { method: 'POST' }).then(onCredentials)}>{t('New password')}</button>
          </>
        )}
        <button className="secondary small-button" onClick={() => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { paused: !l.paused } }), l.paused ? t('Resumed') : t('Paused'))}>{l.paused ? t('Resume') : t('Pause')}</button>
        <span className="spacer" />
        <button className="link danger-link small" onClick={() => { if (window.confirm(t('Disconnect {name}? What was already sent to BTS stays.', { name: l.name }))) void act(() => api(`/v1/connectors/${l.id}`, { method: 'DELETE' }), t('Disconnected')); }}>{t('Disconnect')}</button>
      </div>
      {codes.length > 0 && (
        <details className="connector-taxes" open={taxesOpen} onToggle={(e) => setTaxesOpen(e.currentTarget.open)}>
          <summary>{t('Tax codes')} {codes.some((c) => !map[c]) && <span className="badge pending">{t('Some not mapped')}</span>}</summary>
          <p className="small muted">{t('Which GST each {system} tax code means. Documents with a code not mapped wait here until it is.', { system })}</p>
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
              {t('Send even when {system} charged a different tax than 12.5% GST', { system })}
            </label>
          </div>
        </details>
      )}
      {l.kind !== 'qbpos' && (
        <div className="row small" style={{ gap: '1rem' }}>
          <label className="row" style={{ gap: '0.4rem' }}><input type="checkbox" checked={l.settings.pull.invoices} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { pull: { invoices: e.target.checked } } }), t('Saved'))} /> {t('Invoices')}</label>
          <label className="row" style={{ gap: '0.4rem' }}><input type="checkbox" checked={l.settings.pull.salesReceipts} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { pull: { salesReceipts: e.target.checked } } }), t('Saved'))} /> {l.kind === 'netsuite' ? t('Cash sales') : t('Sales receipts')}</label>
          {l.kind === 'netsuite' && <label className="row" style={{ gap: '0.4rem' }}><input type="checkbox" checked={l.settings.pull.creditMemos} onChange={(e) => void act(() => api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { pull: { creditMemos: e.target.checked } } }), t('Saved'))} /> {t('Credit memos')}</label>}
          <button type="button" className="link small" onClick={onChanged}>{t('Refresh')}</button>
        </div>
      )}
    </div>
  );
}

const KIND_TITLES: Record<Kind, string> = { qbd: 'Connect QuickBooks Desktop', qbpos: 'Connect QuickBooks Point of Sale', netsuite: 'Connect NetSuite' };
const KIND_NAMES: Record<Kind, string> = { qbd: 'QuickBooks Desktop', qbpos: 'QuickBooks Point of Sale', netsuite: 'NetSuite' };

function AddConnection({ kind, onClose, onAdded }: { kind: Kind; onClose: () => void; onAdded: (c: { id: string; kind: Kind; username?: string; password?: string }) => void }) {
  const t = useT();
  const [name, setName] = useState(t(KIND_NAMES[kind]));
  const [syncFrom, setSyncFrom] = useState(belizeToday());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: string; kind: Kind; username?: string; password?: string }>('/v1/connectors', { method: 'POST', body: { kind, name, syncFrom } });
      onAdded(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t(KIND_TITLES[kind])} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('Name')} hint={t('To tell connections apart, e.g. the office or the shop.')}><input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Send documents dated from')} hint={t('Older ones in {system} are left alone.', { system: systemOf(kind) })}><input type="date" required value={syncFrom} onChange={(e) => setSyncFrom(e.target.value)} /></Field>
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

/** NetSuite: the steps in NetSuite, the certificate to upload, and the details it gives back. */
function NetSuiteSetup({ link: l, onClose, onSaved }: { link: ConnectorLink; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const ns = l.netsuite!;
  const [accountId, setAccountId] = useState(ns.accountId ?? '');
  const [clientId, setClientId] = useState(ns.clientId ?? '');
  const [certificateId, setCertificateId] = useState(ns.certificateId ?? '');
  const [numberField, setNumberField] = useState(ns.numberField);
  const [statusField, setStatusField] = useState(ns.statusField ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/connectors/${l.id}`, { method: 'PUT', body: { netsuite: { accountId, clientId, certificateId, numberField, statusField } } });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Connect NetSuite')} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>{t('Done once, by a NetSuite administrator. NetSuite signs this service in with a certificate made for this connection: no password is shared.')}</p>
        <ol className="connector-steps">
          <li>{t('Setup > Company > Enable Features > SuiteCloud: tick REST Web Services and OAuth 2.0.')}</li>
          <li>{t('Setup > Integration > Manage Integrations > New: name it Floreo, tick only "Client Credentials (Machine to Machine) Grant", save, and copy the Client ID.')}</li>
          <li>{t('A role for it with: Invoice, Cash Sale and Credit Memo (Edit, to write the BTS number back); Customers (View); REST Web Services and Log in using OAuth 2.0 Access Tokens (Full); SuiteAnalytics Workbook. Give the role to the employee the connection acts as.')}</li>
          <li>{t('Customization > Lists, Records & Fields > Transaction Body Fields > New: label "BTS number", ID _bts_number, type Free-Form Text, applied to Sale. Optionally a second one, _bts_status, for the status and ETDUI.')}</li>
          <li>{t('Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup > Create New: the employee, the role and the Floreo application, and this certificate. Copy the Certificate ID.')} <a className="button small-button" href={link(`/v1/connectors/${l.id}/certificate`)} download>{t('Download the certificate')}</a></li>
        </ol>
        <div className="form-grid">
          <Field label={t('Account ID')} hint={t('Setup > Company > Company Information, e.g. 1234567 (a sandbox: 1234567_SB1).')}><input required value={accountId} onChange={(e) => setAccountId(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
          <Field label={t('Client ID')}><input required value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} className="mono" /></Field>
          <Field label={t('Certificate ID')}><input required value={certificateId} onChange={(e) => setCertificateId(e.target.value)} autoComplete="off" spellCheck={false} className="mono" /></Field>
          <Field label={t('BTS number field')} hint={t('The transaction body field the BTS number is written to.')}><input required value={numberField} onChange={(e) => setNumberField(e.target.value)} autoComplete="off" spellCheck={false} className="mono" /></Field>
          <Field label={t('BTS status field (optional)')} hint={t('Status and ETDUI, e.g. custbody_bts_status.')}><input value={statusField} onChange={(e) => setStatusField(e.target.value)} autoComplete="off" spellCheck={false} className="mono" /></Field>
        </div>
        {ns.certificateExpiresAt && <p className="small muted" style={{ margin: 0 }}>{t('The certificate is valid until {date}.', { date: new Date(ns.certificateExpiresAt).toLocaleDateString() })}</p>}
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{busy ? t('Testing…') : t('Save and test')}</button></div>
      </form>
    </Modal>
  );
}
