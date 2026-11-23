/**
 * A customer at a glance: what they bought (all time, this year), what they owe and what is
 * overdue, their recent documents and favourite items, with the actions that go with them
 * (a new invoice for them, their statement, all their documents).
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, type Customer, type DocStatus } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { DISTRICTS, ErrorText, money, StatusBadge, TYPE_NAMES, usePageTitle } from '../ui';
import { StatementModal } from './Receivables';

interface Summary {
  customer: Customer;
  key: string;
  sales: { lifetime: string; thisYear: string; documents: number; lastSale: string | null; firstSale: string | null };
  owed: { total: string; overdue: string; invoices: Array<{ id: string; number: string; dueDate: string; balance: string; daysOverdue: number }> };
  recent: Array<{ id: string; type: string; number: string; issueDate: string; total: string; status: DocStatus }>;
  topItems: Array<{ name: string; quantity: string; total: string }>;
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function CustomerDetail() {
  const t = useT();
  const { id } = useParams();
  const { can } = useSession();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [statement, setStatement] = useState(false);
  usePageTitle(s?.customer.name ?? t('Customer'));
  useEffect(() => {
    void api<Summary>(`/v1/customers/${id}/summary`).then(setS).catch(setError);
  }, [id]);

  if (error) return <div className="stack"><Link to="/customers" viewTransition>← {t('Customers')}</Link><div className="banner bad"><ErrorText error={error} /></div></div>;
  if (!s) return <div className="stack"><div className="skeleton" style={{ height: '4rem' }} /><div className="skeleton" style={{ height: '10rem' }} /></div>;
  const c = s.customer;
  const district = c.address ? DISTRICTS.find(([code]) => code === c.address!.districtCode)?.[1] : null;

  return (
    <div className="stack">
      <Link to="/customers" className="back-link" viewTransition>← {t('Customers')}</Link>
      <div className="row customer-head">
        <div>
          <span className="kicker">{t('Customer')}</span>
          <h1>{c.name}</h1>
          <p className="muted small">
            {[c.tin && `TIN ${c.tin}`, c.address && `${c.address.street}, ${c.address.city}${district ? `, ${district}` : ''}`, c.contact.telephone, c.contact.email].filter(Boolean).join(' · ') || t('No details yet.')}
          </p>
        </div>
        <span className="spacer" />
        <div className="row">
          {can('documents.issue') && <Link className="button" to={`/documents/new?type=01&customer=${c.id}`} viewTransition>{t('New invoice')}</Link>}
          {can('payments.record') && <button type="button" className="secondary" onClick={() => setStatement(true)}>{t('Statement')}</button>}
          <Link className="button secondary" to={`/documents?customerId=${c.id}`} viewTransition>{t('All documents')}</Link>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi card"><span className="kpi-head">{t('Bought this year')}</span><span className="kpi-value num">{money(s.sales.thisYear)}</span></div>
        <div className="kpi card"><span className="kpi-head">{t('Bought in all')}</span><span className="kpi-value num">{money(s.sales.lifetime)}</span><span className="small muted">{s.sales.documents === 1 ? t('1 document') : t('{n} documents', { n: s.sales.documents })}{s.sales.firstSale ? ` · ${t('since {date}', { date: longDate(s.sales.firstSale) })}` : ''}</span></div>
        <div className={`kpi card ${s.owed.overdue !== '0.00' ? 'alert' : ''}`}><span className="kpi-head">{t('Owes')}</span><span className="kpi-value num">{money(s.owed.total)}</span>{s.owed.overdue !== '0.00' && <span className="small overdue-text">{t('{amount} overdue', { amount: money(s.owed.overdue) })}</span>}</div>
        <div className="kpi card"><span className="kpi-head">{t('Last purchase')}</span><span className="kpi-value">{s.sales.lastSale ? longDate(s.sales.lastSale) : '—'}</span></div>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>{t('Recent documents')}</h2>
          {s.recent.length === 0 ? <div className="empty">{t('Nothing issued to this customer yet.')}</div> : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Document')}</th><th scope="col">{t('Date')}</th><th scope="col">{t('Status')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
                <tbody>
                  {s.recent.map((d) => (
                    <tr key={d.id}>
                      <td data-label={t('Document')}><Link to={`/documents/${d.id}`} viewTransition>{t(TYPE_NAMES[d.type] ?? d.type)} {d.number}</Link></td>
                      <td data-label={t('Date')}>{longDate(d.issueDate)}</td>
                      <td data-label={t('Status')}><StatusBadge status={d.status} /></td>
                      <td data-label={t('Total')} className="right num">{d.type === '04' ? '−' : ''}{money(d.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="stack">
          <section className="card">
            <h2>{t('Open invoices')}</h2>
            {s.owed.invoices.length === 0 ? <div className="empty">{t('Nothing owed. All paid up.')}</div> : (
              <ul className="customer-open">
                {s.owed.invoices.map((i) => (
                  <li key={i.id}>
                    <Link to={`/documents/${i.id}`} viewTransition>{i.number}</Link>
                    <span className={i.daysOverdue > 0 ? 'overdue-text small' : 'muted small'}>{i.daysOverdue > 0 ? t('{n} days overdue', { n: i.daysOverdue }) : t('due {date}', { date: longDate(i.dueDate) })}</span>
                    <span className="spacer" />
                    <strong className="num">{money(i.balance)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>{t('What they buy most')}</h2>
            {s.topItems.length === 0 ? <div className="empty">{t('No purchases yet.')}</div> : (
              <ul className="customer-open">
                {s.topItems.map((i) => (
                  <li key={i.name}><span>{i.name}</span><span className="muted small">× {i.quantity}</span><span className="spacer" /><span className="num">{money(i.total)}</span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {statement && <StatementModal customerKey={s.key} onClose={() => setStatement(false)} />}
    </div>
  );
}

export default CustomerDetail;
