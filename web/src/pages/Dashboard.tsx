import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type DocumentInfo, type Page, type Summary } from '../api';
import { Crystals } from '../art';
import { type T, useI18n, useT } from '../i18n';
import { Icons } from '../icons';
import { useSession } from '../session';
import { belizeDate, belizeToday, fromCents, money, PaymentBadge, StatusBadge, toCents, TYPE_NAMES, usePageTitle } from '../ui';
import { SalesChart } from './Reports';

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
              <td data-label={t('Status')}><span className="badges"><StatusBadge status={d.status} />{d.payment && <PaymentBadge status={d.payment.status} />}</span></td>
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
  const { lang } = useI18n();
  usePageTitle(t('Overview'));
  const { me, can, session } = useSession();
  const [recent, setRecent] = useState<DocumentInfo[] | null>(null);
  const [rejected, setRejected] = useState<DocumentInfo[]>([]);
  const [pending, setPending] = useState<DocumentInfo[]>([]);
  const [orders, setOrders] = useState<{ unpaid: number; unfulfilled: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const today = belizeToday();
  const [todayDocs, setTodayDocs] = useState<DocumentInfo[]>([]);
  const reports = can('reports.view');

  const load = useCallback(() => {
    void api<Page<DocumentInfo>>('/v1/documents?limit=8').then((r) => setRecent(r.data)).catch(() => setRecent([]));
    void api<Page<DocumentInfo>>(`/v1/documents?limit=200&from=${today}&to=${today}`).then((r) => setTodayDocs(r.data)).catch(() => {});
    void api<Page<DocumentInfo>>('/v1/documents?status=rejected&limit=20').then((r) => setRejected(r.data)).catch(() => {});
    void api<Page<DocumentInfo>>('/v1/documents?status=pending&limit=20').then((r) => setPending(r.data)).catch(() => {});
    void api<{ counts: { unpaid: number; unfulfilled: number } }>('/v1/orders?view=to_do&q=%23000000000').then((r) => setOrders(r.counts)).catch(() => {});
    if (reports) void api<Summary>(`/v1/reports/summary?from=${belizeDate(-13)}&to=${today}`).then(setSummary).catch(() => {});
  }, [today, reports]);
  useEffect(() => {
    load();
  }, [load]);
  usePollWhile((recent ?? []).some((d) => d.status === 'pending' || d.status === 'contingency_pending') || pending.length > 0, load, 10_000);
  if (!me || !session) return null;

  const counted = todayDocs.filter((d) => ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(d.status));
  const todayTotal = counted.reduce((sum, d) => sum + (d.type === '04' ? -1n : 1n) * toCents(d.totals.payable), 0n);
  const weekTotal = summary?.byDay.filter((d) => d.date >= belizeDate(-6)).reduce((sum, d) => sum + toCents(d.total), 0n) ?? null;
  const hour = new Date(Date.now() - 6 * 3_600_000).getUTCHours();
  const greeting = hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  const firstName = session.user.name.split(/\s+/)[0] ?? '';
  const longDate = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Belize' }).format(new Date());
  const ordersToDo = orders ? Math.max(orders.unpaid, orders.unfulfilled) : 0;
  const attention = rejected.length + pending.length;
  const cert = me.certificate;

  const todo: Array<{ to: string; tone: 'bad' | 'warn'; text: string }> = [
    ...(!cert ? [{ to: '/settings?tab=business', tone: 'bad' as const, text: can('business.manage') ? t('Install your BTS certificate to start issuing') : t('Ask an owner or admin to install the BTS certificate') }] : []),
    ...(cert && cert.daysLeft < 30 ? [{ to: '/settings?tab=business', tone: 'warn' as const, text: t('Your BTS certificate expires in {n} days', { n: cert.daysLeft }) }] : []),
    ...(orders?.unpaid ? [{ to: '/orders?view=unpaid', tone: 'warn' as const, text: orders.unpaid === 1 ? t('1 online order waiting for payment') : t('{n} online orders waiting for payment', { n: orders.unpaid }) }] : []),
    ...(orders?.unfulfilled ? [{ to: '/orders?view=unfulfilled', tone: 'warn' as const, text: orders.unfulfilled === 1 ? t('1 order to deliver or hand over') : t('{n} orders to deliver or hand over', { n: orders.unfulfilled }) }] : []),
    ...(rejected.length ? [{ to: '/documents?status=rejected', tone: 'bad' as const, text: rejected.length === 1 ? t('1 document rejected by BTS') : t('{n} documents rejected by BTS', { n: rejected.length }) }] : []),
    ...(pending.length ? [{ to: '/documents?status=pending', tone: 'warn' as const, text: pending.length === 1 ? t('1 document still waiting for BTS') : t('{n} documents still waiting for BTS', { n: pending.length }) }] : []),
  ];

  return (
    <div className="stack dash">
      <section className="hero welcome">
        <Crystals count={2} />
        <div>
          <span className="kicker">{longDate}</span>
          <h1>{greeting}, {firstName}</h1>
          <p className="muted">
            {me.tradeName ?? me.legalName} · TIN {me.tin}
            {me.environment === 'test' && <> · {t('Test environment: documents have no fiscal value')}</>}
          </p>
        </div>
        {can('documents.issue') && (
          <div className="actions">
            <Link className="button big lime" to="/counter" viewTransition>{t('Quick sale')}<span className="chip" aria-hidden="true">→</span></Link>
            <Link className="button secondary on-dark" to="/documents/new?type=01" viewTransition>{t('New invoice')}</Link>
          </div>
        )}
      </section>

      <div className="kpis">
        <div className="card kpi good">
          <span className="kpi-head"><Icons.counter />{t('Sales today')}</span>
          <span className="kpi-value">{money(fromCents(todayTotal))}</span>
          <span className="kpi-note">{weekTotal !== null ? t('Last 7 days: {amount}', { amount: money(fromCents(weekTotal)) }) : t('GST included')}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-head"><Icons.documents />{t('Issued today')}</span>
          <span className="kpi-value">{counted.length}</span>
          <span className="kpi-note">{t('Invoices, receipts and notes')}</span>
        </div>
        <Link to="/orders" className={`card kpi ${ordersToDo ? 'alert' : ''}`} viewTransition>
          <span className="kpi-head"><Icons.orders />{t('Orders to handle')}</span>
          <span className="kpi-value">{orders ? ordersToDo : '—'}</span>
          <span className="kpi-note">{orders && (orders.unpaid || orders.unfulfilled) ? t('{a} unpaid · {b} to deliver', { a: orders.unpaid, b: orders.unfulfilled }) : t('From your online store')}</span>
        </Link>
        <Link to={rejected.length ? '/documents?status=rejected' : '/documents'} className={`card kpi ${attention ? 'alert' : ''}`} viewTransition>
          <span className="kpi-head"><Icons.alert />{t('Need attention')}</span>
          <span className="kpi-value">{attention}</span>
          <span className="kpi-note">{attention ? t('{a} rejected · {b} waiting', { a: rejected.length, b: pending.length }) : t('Every document is settled')}</span>
        </Link>
      </div>

      <div className="dash-grid">
        {reports ? (
          <section className="card">
            <div className="row"><h2>{t('Sales, last 14 days')}</h2><span className="spacer" /><Link to="/reports" viewTransition>{t('Reports')} →</Link></div>
            {summary === null ? <div className="skeleton" style={{ height: '190px' }} /> : summary.byDay.length ? <SalesChart summary={summary} /> : <div className="empty">{t('No sales in the last 14 days yet.')}</div>}
          </section>
        ) : (
          <section className="card">
            <div className="row"><h2>{t('Recent documents')}</h2><span className="spacer" /><Link to="/documents" viewTransition>{t('See all')} →</Link></div>
            {recent === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : <DocumentTable docs={recent} />}
          </section>
        )}
        <section className="card">
          <h2>{t('To do')}</h2>
          {todo.length === 0 ? (
            <div className="all-clear"><Icons.check /><span>{t('All caught up.')}</span></div>
          ) : (
            <ul className="todo">
              {todo.map((item) => (
                <li key={item.to + item.text}>
                  <Link to={item.to} viewTransition>
                    <span className={`dot ${item.tone}`} aria-hidden="true" />
                    <span>{item.text}</span>
                    <span className="go"><Icons.arrow /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {reports && (
        <section className="card">
          <div className="row"><h2>{t('Recent documents')}</h2><span className="spacer" /><Link to="/documents" viewTransition>{t('See all')} →</Link></div>
          {recent === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <DocumentTable docs={recent} />}
        </section>
      )}
    </div>
  );
}
