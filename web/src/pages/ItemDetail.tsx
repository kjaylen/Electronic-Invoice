/**
 * An item at a glance: how it sells, its margin, its stock and how long it lasts, who supplies it
 * and at what cost, and the bundles it is part of; with the actions that go with it.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, type Item } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { ErrorText, money, unitName, usePageTitle } from '../ui';

interface Summary {
  item: Item;
  sales: {
    last30: { quantity: string; net: string };
    last90: { quantity: string; net: string };
    last365: { quantity: string; net: string };
    lastSold: string | null;
    months: Array<{ month: string; quantity: string; net: string }>;
  };
  margin: { sales: string; cost: string; percent: number } | null;
  stock: { tracked: boolean; quantity: number | null; lowStock: number | null; averageCost: string | null; daysOfCover: number | null };
  suppliers: Array<{ id: string | null; name: string; lastCost: string | null; lastReceived: string; received: string }>;
  bundles: Array<{ id: string; name: string; quantity: string }>;
}

const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });

export function ItemDetail() {
  const t = useT();
  const { id } = useParams();
  const { can } = useSession();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  usePageTitle(s?.item.name ?? t('Item'));
  useEffect(() => void api<Summary>(`/v1/items/${id}/summary`).then(setS).catch(setError), [id]);

  const back = <Link to="/products?tab=items" className="back-link" viewTransition>← {t('All items')}</Link>;
  if (error) return <div className="stack">{back}<div className="banner bad"><ErrorText error={error} /></div></div>;
  if (!s) return <div className="stack"><div className="skeleton" style={{ height: '4rem' }} /><div className="skeleton" style={{ height: '10rem' }} /></div>;
  const it = s.item;
  const unit = unitName(t, it.unitCode).toLowerCase();
  // The last 12 months, those without sales as zero.
  const now = new Date(Date.now() - 6 * 3600_000);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 15));
    const key = d.toISOString().slice(0, 7);
    return s.sales.months.find((m) => m.month === key) ?? { month: key, quantity: '0', net: '0.00' };
  });
  const max = Math.max(1, ...months.map((m) => Number(m.net)));
  const low = s.stock.tracked && s.stock.quantity !== null && s.stock.lowStock !== null && s.stock.quantity <= s.stock.lowStock;

  return (
    <div className="stack">
      {back}
      <div className="row customer-head">
        <div>
          <span className="kicker">{it.category ?? t('Item')}</span>
          <h1>{it.name}{it.bundle && <span className="badge test bundle-badge">{t('Bundle')}</span>}</h1>
          <p className="muted small">{[it.sellerCode, it.barcode, `${money(it.unitPrice)} ${t('before GST')}`, it.wholesalePrice && `${t('Wholesale')} ${money(it.wholesalePrice)}`].filter(Boolean).join(' · ')}</p>
          {it.priceBreaks && it.priceBreaks.length > 0 && <p className="small">{it.priceBreaks.map((b) => t('{q} or more: {price} each', { q: b.minQuantity, price: money(b.unitPrice) })).join(' · ')}</p>}
        </div>
        <span className="spacer" />
        <div className="row">
          {can('catalog.manage') && s.stock.tracked && <Link className="button" to="/inventory/orders/new?suggest=1" viewTransition>{t('Order more')}</Link>}
          <Link className="button secondary" to="/labels" viewTransition>{t('Print labels')}</Link>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi card"><span className="kpi-head">{t('Sold in 30 days')}</span><span className="kpi-value num">{s.sales.last30.quantity} <span className="small muted">{unit}</span></span><span className="small muted">{money(s.sales.last30.net)} {t('before GST')}</span></div>
        <div className="kpi card"><span className="kpi-head">{t('Sold in a year')}</span><span className="kpi-value num">{s.sales.last365.quantity} <span className="small muted">{unit}</span></span><span className="small muted">{money(s.sales.last365.net)}{s.sales.lastSold ? ` · ${t('last {date}', { date: s.sales.lastSold })}` : ''}</span></div>
        <div className="kpi card"><span className="kpi-head">{t('Margin')}</span><span className={`kpi-value num ${s.margin && s.margin.percent < 0 ? 'late' : ''}`}>{s.margin ? `${s.margin.percent.toFixed(1)}%` : '—'}</span><span className="small muted">{s.margin ? t('{cost} cost on {sales} of sales, in a year', { cost: money(s.margin.cost), sales: money(s.margin.sales) }) : t('No cost known yet')}</span></div>
        <div className={`kpi card ${low ? 'alert' : ''}`}>
          <span className="kpi-head">{t('In stock')}</span>
          <span className="kpi-value num">{s.stock.tracked ? s.stock.quantity : '—'}</span>
          <span className="small muted">{!s.stock.tracked ? t('Not tracked') : s.stock.daysOfCover !== null ? t('About {n} days at the current pace', { n: s.stock.daysOfCover }) : t('Not selling lately')}</span>
        </div>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>{t('Sales by month')}</h2>
          {s.sales.months.length === 0 ? <div className="empty">{t('No sales in the last year.')}</div> : (
            <div className="month-bars" role="img" aria-label={t('Sales by month')}>
              {months.map((m) => (
                <div key={m.month} className="month-bar" title={`${m.month}: ${m.quantity} · ${money(m.net)}`}>
                  <span style={{ height: `${Math.max(2, (Math.max(0, Number(m.net)) / max) * 100)}%` }} />
                  <span className="small muted">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="stack">
          <section className="card">
            <h2>{t('Suppliers')}</h2>
            {s.suppliers.length === 0 ? <div className="empty">{t('No stock received for this item yet.')}</div> : (
              <ul className="customer-open">
                {s.suppliers.map((p) => (
                  <li key={`${p.id}-${p.name}`}>
                    {p.id ? <Link to={`/suppliers/${p.id}`} viewTransition>{p.name}</Link> : <span>{p.name}</span>}
                    <span className="muted small">{t('last {date}', { date: p.lastReceived })}</span>
                    <span className="spacer" />
                    <span className="num">{p.lastCost ? money(p.lastCost) : '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            {s.stock.averageCost && <p className="small muted">{t('Average cost now: {cost}', { cost: money(s.stock.averageCost) })}</p>}
          </section>
          {s.bundles.length > 0 && (
            <section className="card">
              <h2>{t('Part of')}</h2>
              <ul className="customer-open">
                {s.bundles.map((b) => <li key={b.id}><Link to={`/items/${b.id}`} viewTransition>{b.name}</Link><span className="spacer" /><span className="muted small">× {b.quantity}</span></li>)}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default ItemDetail;
