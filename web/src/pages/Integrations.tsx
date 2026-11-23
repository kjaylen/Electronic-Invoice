/** Settings → Integrations: QuickBooks Online (Pro plan). */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Select, TYPE_NAMES } from '../ui';
import { UpgradeNotice } from './Billing';

interface QuickBooksState {
  available: boolean;
  environment: 'sandbox' | 'production' | null;
  connected: boolean;
  status: 'connected' | 'needs_reconnect' | null;
  company: string | null;
  syncFrom: string | null;
  taxCodes: { S?: string; Z?: string; E?: string };
  counts: { pending?: number; synced?: number; failed?: number; skipped?: number };
  recent: Array<{ documentId: string; number: string; type: string; status: string; remote: string | null; error: string | null; attempts: number; syncedAt: string | null; voided: boolean }>;
}

function QuickBooksLogo() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#2ca01c" />
      <path d="M11 14h4v12h-1.5A5.5 5.5 0 0 1 8 20.5v-1A5.5 5.5 0 0 1 11 14Zm18 12h-4V14h1.5a5.5 5.5 0 0 1 5.5 5.5v1a5.5 5.5 0 0 1-3 5.5Z" fill="#fff" />
      <path d="M17 11h2v18h-2zM21 11h2v18h-2z" fill="#fff" />
    </svg>
  );
}

export function IntegrationsTab() {
  const t = useT();
  const toast = useToast();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [qb, setQb] = useState<QuickBooksState | null>(null);
  const [codes, setCodes] = useState<Array<{ id: string; name: string }> | null>(null);
  const [map, setMap] = useState<{ S: string; Z: string; E: string }>({ S: '', Z: '', E: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ quickbooks: QuickBooksState }>('/v1/integrations').then((r) => {
    setQb(r.quickbooks);
    setMap({ S: r.quickbooks.taxCodes.S ?? '', Z: r.quickbooks.taxCodes.Z ?? '', E: r.quickbooks.taxCodes.E ?? '' });
  }).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  // Back from Intuit.
  useEffect(() => {
    const result = params.get('quickbooks');
    if (!result) return;
    toast(result === 'connected' ? t('QuickBooks is connected') : result === 'cancelled' ? t('Connecting QuickBooks was cancelled') : t('QuickBooks could not be connected. Try again.'), result === 'connected' ? 'ok' : 'info');
    setParams({ tab: 'integrations' }, { replace: true });
  }, [params, setParams, t, toast]);
  useEffect(() => {
    if (qb?.connected && qb.status === 'connected' && codes === null) void api<{ data: Array<{ id: string; name: string }> }>('/v1/integrations/quickbooks/tax-codes').then((r) => setCodes(r.data)).catch(() => setCodes([]));
  }, [qb, codes]);

  if (me?.billing && !me.billing.features.includes('integrations')) return <UpgradeNotice feature="integrations" />;
  if (!qb) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '10rem' }} />;

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (message) toast(message);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const connect = () => act(async () => {
    const r = await api<{ url: string }>('/v1/integrations/quickbooks/connect', { method: 'POST' });
    window.location.assign(r.url);
  });

  return (
    <div className="stack">
      <section className="card stack integration">
        <div className="row">
          <QuickBooksLogo />
          <div>
            <h2 style={{ margin: 0 }}>QuickBooks Online</h2>
            <p className="small muted" style={{ margin: 0 }}>{t('Every authorized document goes into your books by itself: invoices, sales receipts and credit memos.')}</p>
          </div>
          <span className="spacer" />
          {qb.connected && <span className={`badge ${qb.status === 'connected' ? 'authorized' : 'pending'}`}>{qb.status === 'connected' ? t('Connected') : t('Reconnect needed')}</span>}
        </div>
        {!qb.available ? (
          <p className="small muted">{t('QuickBooks is not set up on this server yet. Ask our team.')}</p>
        ) : !qb.connected ? (
          <div className="row"><button disabled={busy} onClick={() => void connect()}>{t('Connect QuickBooks')}<span className="chip" aria-hidden="true">→</span></button><span className="small muted">{t('You sign in with Intuit and choose the company.')}</span></div>
        ) : (
          <>
            {qb.status === 'needs_reconnect' && (
              <div className="banner warn"><div><strong>{t('QuickBooks needs you to connect again')}</strong>{t('Documents are waiting and will be sent once you reconnect.')} <button className="link" onClick={() => void connect()}>{t('Reconnect')}</button></div></div>
            )}
            <dl className="facts">
              <dt>{t('Company')}</dt><dd>{qb.company ?? '—'}{qb.environment === 'sandbox' && <span className="badge test" style={{ marginLeft: '0.5rem' }}>sandbox</span>}</dd>
              <dt>{t('Sending')}</dt><dd>{t('documents issued from {date}', { date: qb.syncFrom ?? '' })}</dd>
              <dt>{t('So far')}</dt><dd>{t('{n} sent', { n: qb.counts.synced ?? 0 })}{qb.counts.pending ? ` · ${t('{n} waiting', { n: qb.counts.pending })}` : ''}{qb.counts.failed ? ` · ${t('{n} failed', { n: qb.counts.failed })}` : ''}</dd>
            </dl>
            <div className="stack">
              <h3 style={{ margin: 0 }}>{t('GST')}</h3>
              <p className="small muted">{t('Choose your QuickBooks tax code for each GST rate, and QuickBooks books the tax. Until then, lines are sent with GST included so totals always match your e-invoices.')}</p>
              <div className="form-grid">
                {(['S', 'Z', 'E'] as const).map((c) => (
                  <Field key={c} label={c === 'S' ? t('Standard rate (12.5%)') : c === 'Z' ? t('Zero-rated') : t('Exempt')}>
                    <Select value={map[c]} onChange={(e) => setMap({ ...map, [c]: e.target.value })} disabled={!codes}>
                      <option value="">{t('Not mapped')}</option>
                      {(codes ?? []).map((tc) => <option key={tc.id} value={tc.id}>{tc.name}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
              <div className="row">
                <button className="secondary" disabled={busy} onClick={() => void act(() => api('/v1/integrations/quickbooks', { method: 'PUT', body: { taxCodes: { S: map.S || null, Z: map.Z || null, E: map.E || null } } }), t('Tax codes saved'))}>{t('Save tax codes')}</button>
                <span className="spacer" />
                {qb.counts.failed ? <button className="secondary" disabled={busy} onClick={() => void act(() => api('/v1/integrations/quickbooks/retry', { method: 'POST' }), t('Sending the failed documents again'))}>{t('Retry failed')}</button> : null}
                <button className="link danger-link" disabled={busy} onClick={() => void act(() => api('/v1/integrations/quickbooks', { method: 'DELETE' }), t('QuickBooks disconnected'))}>{t('Disconnect')}</button>
              </div>
            </div>
            {qb.recent.length > 0 && (
              <div className="table-wrap">
                <table className="responsive">
                  <thead><tr><th scope="col">{t('Document')}</th><th scope="col">{t('In QuickBooks')}</th><th scope="col">{t('Status')}</th></tr></thead>
                  <tbody>
                    {qb.recent.map((r) => (
                      <tr key={r.documentId}>
                        <td data-label={t('Document')}>{t(TYPE_NAMES[r.type] ?? 'Document')} <span className="num">{r.number}</span></td>
                        <td data-label={t('In QuickBooks')} className="small mono">{r.remote ?? '—'}{r.voided && ` · ${t('voided')}`}</td>
                        <td data-label={t('Status')}>
                          {r.status === 'synced' ? <span className="badge authorized">{t('Sent')}</span> : r.status === 'failed' ? <span className="badge rejected">{t('Failed')}</span> : r.status === 'skipped' ? <span className="badge cancelled">{t('Skipped')}</span> : <span className="badge pending">{t('Waiting')}</span>}
                          {r.error && <div className="small muted">{r.error}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <ErrorText error={error} />
      </section>
      <section className="card stack">
        <h2>{t('More connections')}</h2>
        <p className="small muted">{t('Xero, Sage and others can connect today through the API and webhooks (Settings → Developers). Tell us which you need next.')}</p>
      </section>
    </div>
  );
}
