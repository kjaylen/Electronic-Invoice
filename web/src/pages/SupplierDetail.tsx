/**
 * A supplier at a glance: what you have spent with them, the bills still to pay, open purchase
 * orders and recent deliveries, and the items you buy from them with their last cost; with the
 * actions that go with them (a new order, a new expense, their bills).
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { ErrorText, money, usePageTitle } from '../ui';
import { SupplierModal } from './Expenses';
import { PoBadge } from './PurchaseOrders';

interface Summary {
  supplier: { id: string; name: string; tin: string | null; email: string | null; telephone: string | null; address: string | null; notes: string | null; archived: boolean };
  spend: { lifetime: string; thisYear: string; bills: number; lastPurchase: string | null };
  owed: { total: string; overdue: string; bills: Array<{ id: string; reference: string | null; date: string; dueDate: string | null; total: string; description: string | null; daysOverdue: number }> };
  orders: Array<{ id: string; number: string; status: 'draft' | 'sent' | 'partial'; expectedOn: string | null; late: boolean; total: string }>;
  deliveries: Array<{ id: string; receivedOn: string; reference: string | null; totalCost: string; purchaseOrderId: string | null; expenseId: string | null }>;
  items: Array<{ itemId: string; name: string; lastCost: string | null; lastReceived: string; stock: string | null; low: boolean; received: string }>;
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function SupplierDetail() {
  const t = useT();
  const { id } = useParams();
  const { can } = useSession();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  usePageTitle(s?.supplier.name ?? t('Supplier'));
  const load = () => api<Summary>(`/v1/suppliers/${id}/summary`).then(setS).catch(setError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const back = <Link to="/expenses?tab=suppliers" className="back-link" viewTransition>← {t('Suppliers')}</Link>;
  if (error) return <div className="stack">{back}<div className="banner bad"><ErrorText error={error} /></div></div>;
  if (!s) return <div className="stack"><div className="skeleton" style={{ height: '4rem' }} /><div className="skeleton" style={{ height: '10rem' }} /></div>;
  const p = s.supplier;

  return (
    <div className="stack">
      {back}
      <div className="row customer-head">
        <div>
          <span className="kicker">{t('Supplier')}</span>
          <h1>{p.name}{p.archived && <span className="badge cancelled">{t('Archived')}</span>}</h1>
          <p className="muted small">{[p.tin && `TIN ${p.tin}`, p.address, p.telephone, p.email].filter(Boolean).join(' · ') || t('No details yet.')}</p>
          {p.notes && <p className="small">{p.notes}</p>}
        </div>
        <span className="spacer" />
        <div className="row">
          {can('catalog.manage') && <Link className="button" to={`/inventory/orders/new?supplier=${p.id}`} viewTransition>{t('New order')}</Link>}
          {can('expenses.manage') && <Link className="button secondary" to={`/expenses/new?supplier=${p.id}`} viewTransition>{t('Add expense')}</Link>}
          {can('expenses.manage') && <button type="button" className="secondary" onClick={() => setEditing(true)}>{t('Edit')}</button>}
        </div>
      </div>

      <div className="kpis">
        <div className="kpi card"><span className="kpi-head">{t('Spent this year')}</span><span className="kpi-value num">{money(s.spend.thisYear)}</span></div>
        <div className="kpi card"><span className="kpi-head">{t('Spent in all')}</span><span className="kpi-value num">{money(s.spend.lifetime)}</span><span className="small muted">{s.spend.bills === 1 ? t('1 expense') : t('{n} expenses', { n: s.spend.bills })}</span></div>
        <div className={`kpi card ${s.owed.overdue !== '0.00' ? 'alert' : ''}`}><span className="kpi-head">{t('You owe')}</span><span className="kpi-value num">{money(s.owed.total)}</span>{s.owed.overdue !== '0.00' && <span className="small overdue-text">{t('{amount} overdue', { amount: money(s.owed.overdue) })}</span>}</div>
        <div className="kpi card"><span className="kpi-head">{t('Last purchase')}</span><span className="kpi-value">{s.spend.lastPurchase ? longDate(s.spend.lastPurchase) : '—'}</span></div>
      </div>

      <div className="grid two">
        <div className="stack">
          <section className="card">
            <h2>{t('Bills to pay')}</h2>
            {s.owed.bills.length === 0 ? <div className="empty">{t('Nothing to pay. All paid up.')}</div> : (
              <ul className="customer-open">
                {s.owed.bills.map((b) => (
                  <li key={b.id}>
                    <Link to={`/expenses/${b.id}`} viewTransition>{b.reference ?? b.description ?? longDate(b.date)}</Link>
                    <span className={b.daysOverdue > 0 ? 'overdue-text small' : 'muted small'}>{b.daysOverdue > 0 ? t('{n} days overdue', { n: b.daysOverdue }) : b.dueDate ? t('due {date}', { date: longDate(b.dueDate) }) : longDate(b.date)}</span>
                    <span className="spacer" />
                    <strong className="num">{money(b.total)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>{t('Open orders')}</h2>
            {s.orders.length === 0 ? <div className="empty">{t('No open orders.')}</div> : (
              <ul className="customer-open">
                {s.orders.map((o) => (
                  <li key={o.id}>
                    <Link className="mono" to={`/inventory/orders/${o.id}`} viewTransition>{o.number}</Link>
                    <PoBadge po={o} />
                    <span className="spacer" />
                    <span className="num">{money(o.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>{t('Recent deliveries')}</h2>
            {s.deliveries.length === 0 ? <div className="empty">{t('No deliveries yet.')}</div> : (
              <ul className="customer-open">
                {s.deliveries.map((d) => (
                  <li key={d.id}>
                    <span>{longDate(d.receivedOn)}</span>
                    {d.reference && (d.purchaseOrderId ? <Link className="small mono" to={`/inventory/orders/${d.purchaseOrderId}`} viewTransition>{d.reference}</Link> : <span className="small muted">{d.reference}</span>)}
                    <span className="spacer" />
                    <span className="num">{money(d.totalCost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <section className="card">
          <h2>{t('What you buy from them')}</h2>
          {s.items.length === 0 ? <div className="empty">{t('No stock received from this supplier yet.')}</div> : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Last cost')}</th><th scope="col">{t('Last received')}</th><th scope="col" className="right">{t('In stock')}</th></tr></thead>
                <tbody>
                  {s.items.map((i) => (
                    <tr key={i.itemId}>
                      <td data-label={t('Item')}>{i.name}</td>
                      <td data-label={t('Last cost')} className="right num">{i.lastCost ? money(i.lastCost) : '—'}</td>
                      <td data-label={t('Last received')} style={{ whiteSpace: 'nowrap' }}>{longDate(i.lastReceived)}</td>
                      <td data-label={t('In stock')} className={`right ${i.low ? 'late strong' : ''}`}>{i.stock ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {editing && <SupplierModal supplier={p} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void load(); }} />}
    </div>
  );
}

export default SupplierDetail;
