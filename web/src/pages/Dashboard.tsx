import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type DocumentInfo, type Page } from '../api';
import { Crystals } from '../art';
import { type T, useT } from '../i18n';
import { useSession } from '../session';
import { belizeToday, fromCents, money, StatusBadge, toCents, TYPE_NAMES, usePageTitle } from '../ui';

export function customerLabel(t: T, d: DocumentInfo): string {
  return d.customer?.name ?? (d.customer?.tin ? `TIN ${d.customer.tin}` : t('Walk-in'));
}

export function DocumentTable({ docs, empty }: { docs: DocumentInfo[]; empty?: string }) {
  const t = useT();
  const navigate = useNavigate();
  if (docs.length === 0) return <div className="empty">{empty ?? t('Nothing here yet. Your documents will appear as you issue them.')}</div>;
  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr><th scope="col">{t('Date')}</th><th scope="col">{t('Document')}</th><th scope="col">{t('Customer')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Status')}</th></tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`, { viewTransition: true })}>
              <td data-label={t('Date')}>{d.issueDate}</td>
              <td data-label={t('Document')}><Link to={`/documents/${d.id}`} viewTransition onClick={(e) => e.stopPropagation()}>{t(TYPE_NAMES[d.type] ?? d.typeName)}</Link> <span className="mono muted">{d.series}-{d.number}</span></td>
              <td data-label={t('Customer')}>{customerLabel(t, d)}</td>
              <td data-label={t('Total')} className="right">{money(d.totals.payable)}</td>
              <td data-label={t('Status')}><StatusBadge status={d.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Re-runs `load` every few seconds while `active` is true (documents still waiting for BTS). */
export function usePollWhile(active: boolean, load: () => void, everyMs = 5000) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), everyMs);
    return () => clearInterval(timer);
  }, [active, load, everyMs]);
}

export function Dashboard() {
  const t = useT();
  usePageTitle(t('Overview'));
  const { me, role } = useSession();
  const [recent, setRecent] = useState<DocumentInfo[] | null>(null);
  const [attention, setAttention] = useState<DocumentInfo[]>([]);
  const today = belizeToday();
  const [todayDocs, setTodayDocs] = useState<DocumentInfo[]>([]);

  const load = useCallback(() => {
    void api<Page<DocumentInfo>>('/v1/documents?limit=10').then((r) => setRecent(r.data)).catch(() => setRecent([]));
    void api<Page<DocumentInfo>>(`/v1/documents?limit=200&from=${today}&to=${today}`).then((r) => setTodayDocs(r.data)).catch(() => {});
    void Promise.all([
      api<Page<DocumentInfo>>('/v1/documents?status=rejected&limit=5'),
      api<Page<DocumentInfo>>('/v1/documents?status=pending&limit=5'),
    ]).then(([a, b]) => setAttention([...b.data, ...a.data])).catch(() => {});
  }, [today]);
  useEffect(load, [load]);
  usePollWhile((recent ?? []).some((d) => d.status === 'pending' || d.status === 'contingency_pending'), load, 10_000);
  if (!me) return null;

  const counted = todayDocs.filter((d) => ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(d.status));
  const todayTotal = counted.reduce((sum, d) => sum + (d.type === '04' ? -1n : 1n) * toCents(d.totals.payable), 0n);
  const hour = new Date(Date.now() - 6 * 3_600_000).getUTCHours();
  const greeting = hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');

  return (
    <div className="stack">
      <section className="hero">
        <Crystals count={3} />
        <span className="kicker">{t('Overview')} · TIN {me.tin}</span>
        <h1>{me.tradeName ?? me.legalName}</h1>
        <p className="muted">{greeting}. {counted.length ? (counted.length === 1 ? t('1 document issued today.') : t('{n} documents issued today.', { n: counted.length })) : t('Ready when you are.')}</p>
        <div className="row" style={{ marginTop: '1rem' }}>
          <Link className="button big lime" to="/counter" viewTransition>{t('Quick sale')}<span className="chip" aria-hidden="true">→</span></Link>
          <Link className="button secondary on-dark" to="/documents/new?type=01" viewTransition>{t('New invoice')}</Link>
        </div>
      </section>

      {me.environment === 'test' && (
        <div className="banner info"><div><strong>{t('Test environment')}</strong>{t('Documents go to the BTS test system and have no fiscal value.')}</div></div>
      )}
      {!me.certificate && (
        <div className="banner bad"><div><strong>{t('Install your BTS certificate to start issuing.')}</strong>{role === 'owner' ? <Link to="/settings">{t('Go to settings')}</Link> : t('Ask an owner of this business to install it.')}</div></div>
      )}
      {me.certificate && me.certificate.daysLeft < 30 && (
        <div className="banner warn"><div><strong>{t('Your BTS certificate expires in {n} days.', { n: me.certificate.daysLeft })}</strong>{t('Renew it in the BTS portal, then install it in settings.')} <Link to="/settings">{t('Settings')}</Link></div></div>
      )}

      <div className="grid">
        <div className="card stat"><div className="label">{t('Issued today')}</div><div className="value num">{counted.length}</div></div>
        <div className="card stat"><div className="label">{t('Sales today')}</div><div className="value num">{money(fromCents(todayTotal))}</div></div>
        <div className="card stat"><div className="label">{t('Need attention')}</div><div className="value num">{attention.length}</div></div>
      </div>

      {attention.length > 0 && (
        <section className="card">
          <h2>{t('Need attention')}</h2>
          <DocumentTable docs={attention} />
        </section>
      )}
      <section className="card">
        <div className="row"><h2>{t('Recent documents')}</h2><span className="spacer" /><Link to="/documents" viewTransition>{t('See all')} →</Link></div>
        {recent === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <DocumentTable docs={recent} />}
      </section>
    </div>
  );
}
