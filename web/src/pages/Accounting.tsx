/** On the Reports page: the GST return worksheet and profit and loss, for the chosen period. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link } from '../api';
import { useT } from '../i18n';
import { ErrorText, money, toCents } from '../ui';

interface GstReturn {
  environment: 'test' | 'production';
  sales: { standard: { net: string; gst: string }; zero: { net: string }; exempt: { net: string }; documents: number };
  purchases: { claimable: { net: string; gst: string }; notClaimable: { net: string; gst: string }; zero: { net: string }; exempt: { net: string }; noGst: { net: string }; expenses: number };
  outputGst: string;
  inputGst: string;
  net: string;
  warnings: string[];
}

interface Profit {
  months: Array<{ month: string; income: string; expenses: string; profit: string }>;
  categories: Array<{ category: string; amount: string }>;
  totals: { income: string; expenses: string; profit: string };
}

export function GstReturnView({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [r, setR] = useState<GstReturn | null>(null);
  const [error, setError] = useState<unknown>(null);
  const qs = `from=${from}&to=${to}`;
  useEffect(() => {
    if (!from || !to || from > to) return;
    setR(null);
    api<GstReturn>(`/v1/reports/gst-return?${qs}`).then(setR).catch(setError);
  }, [qs, from, to]);
  if (error) return <ErrorText error={error} />;
  if (!r) return <div className="skeleton" style={{ height: '18rem' }} />;
  const owe = toCents(r.net) >= 0n;
  const line = (label: string, net: string | null, gst: string | null, strong = false) => (
    <tr className={strong ? 'total-row' : ''}>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="right">{net === null ? '' : money(net)}</td>
      <td className="right">{gst === null ? '' : strong ? <strong>{money(gst)}</strong> : money(gst)}</td>
    </tr>
  );
  return (
    <div className="stack">
      <section className={`card gst-result ${owe ? 'owe' : 'credit'}`}>
        <div>
          <span className="kicker">{owe ? t('GST to pay for the period') : t('GST credit for the period')}</span>
          <div className="gst-amount">{money(r.net.replace('-', ''))}</div>
          <p className="small">{t('GST charged on sales {out} less GST you can claim on purchases {in}.', { out: money(r.outputGst), in: money(r.inputGst) })}</p>
        </div>
        <span className="spacer" />
        <div className="row">
          <a className="button secondary" href={link(`/v1/reports/gst-return.pdf?${qs}`)} target="_blank" rel="noreferrer">PDF</a>
          <a className="button secondary" href={link(`/v1/reports/gst-return?${qs}&format=csv`)} download>CSV</a>
        </div>
      </section>
      {r.warnings.length > 0 && (
        <div className="banner warn"><div><strong>{t('Check before filing')}</strong><ul className="plain small">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>
      )}
      <div className="grid two">
        <section className="card">
          <h2>{t('Sales ({n} documents)', { n: r.sales.documents })}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col" /><th scope="col" className="right">{t('Net')}</th><th scope="col" className="right">GST</th></tr></thead>
              <tbody>
                {line(t('Standard-rated (12.5%)'), r.sales.standard.net, r.sales.standard.gst)}
                {line(t('Zero-rated'), r.sales.zero.net, '0.00')}
                {line(t('Exempt'), r.sales.exempt.net, null)}
                {line(t('GST charged (output tax)'), null, r.outputGst, true)}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="row"><h2>{t('Purchases ({n} expenses)', { n: r.purchases.expenses })}</h2><span className="spacer" /><Link to="/expenses" viewTransition className="small">{t('Expenses')} →</Link></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col" /><th scope="col" className="right">{t('Net')}</th><th scope="col" className="right">GST</th></tr></thead>
              <tbody>
                {line(t('Standard-rated, with a tax invoice'), r.purchases.claimable.net, r.purchases.claimable.gst)}
                {line(t('Standard-rated, GST not claimable'), r.purchases.notClaimable.net, r.purchases.notClaimable.gst)}
                {line(t('Zero-rated'), r.purchases.zero.net, '0.00')}
                {line(t('Exempt'), r.purchases.exempt.net, null)}
                {line(t('No GST charged'), r.purchases.noGst.net, null)}
                {line(t('GST you can claim (input tax)'), null, r.inputGst, true)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <p className="small muted">{t('A worksheet to help you fill in your GST return: sales come from your authorized e-invoices (credit notes subtract), purchases from the expenses you recorded. The return you file with the Belize Tax Service is what counts; check it with your accountant.')}</p>
    </div>
  );
}

export function ProfitView({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [p, setP] = useState<Profit | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!from || !to || from > to) return;
    setP(null);
    api<Profit>(`/v1/reports/profit?from=${from}&to=${to}`).then(setP).catch(setError);
  }, [from, to]);
  if (error) return <ErrorText error={error} />;
  if (!p) return <div className="skeleton" style={{ height: '18rem' }} />;
  const max = Math.max(1, ...p.months.flatMap((m) => [Number(m.income), Number(m.expenses)]));
  const loss = toCents(p.totals.profit) < 0n;
  return (
    <div className="stack">
      <div className="grid three">
        <div className="card stat"><div className="label">{t('Income (before GST)')}</div><div className="value num">{money(p.totals.income)}</div></div>
        <div className="card stat"><div className="label">{t('Expenses')}</div><div className="value num">{money(p.totals.expenses)}</div></div>
        <div className={`card stat ${loss ? 'loss' : 'gain'}`}><div className="label">{loss ? t('Loss') : t('Profit')}</div><div className="value num">{money(p.totals.profit.replace('-', ''))}</div></div>
      </div>
      {p.months.length > 1 && (
        <section className="card">
          <h2>{t('By month')}</h2>
          <div className="pl-bars" role="img" aria-label={t('Income and expenses by month')}>
            {p.months.map((m) => (
              <div key={m.month} className="pl-month">
                <div className="pl-pair">
                  <span className="pl-bar income" style={{ height: `${(Number(m.income) / max) * 100}%` }} title={`${t('Income')} ${money(m.income)}`} />
                  <span className="pl-bar cost" style={{ height: `${(Number(m.expenses) / max) * 100}%` }} title={`${t('Expenses')} ${money(m.expenses)}`} />
                </div>
                <span className="small muted">{m.month.slice(5)}/{m.month.slice(2, 4)}</span>
              </div>
            ))}
          </div>
          <p className="small muted"><span className="legend income" /> {t('Income')} <span className="legend cost" /> {t('Expenses')}</p>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Month')}</th><th scope="col" className="right">{t('Income')}</th><th scope="col" className="right">{t('Expenses')}</th><th scope="col" className="right">{t('Profit')}</th></tr></thead>
              <tbody>{p.months.map((m) => <tr key={m.month}><td data-label={t('Month')}>{m.month}</td><td data-label={t('Income')} className="right">{money(m.income)}</td><td data-label={t('Expenses')} className="right">{money(m.expenses)}</td><td data-label={t('Profit')} className={`right ${toCents(m.profit) < 0n ? 'late' : ''}`}>{money(m.profit)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      <section className="card">
        <h2>{t('Expenses by category')}</h2>
        {p.categories.length === 0 ? <div className="empty">{t('No expenses recorded in this period.')} <Link to="/expenses/new" viewTransition>{t('Add expense')}</Link></div> : (
          <ul className="cat-bars">
            {p.categories.map((c) => (
              <li key={c.category}>
                <span>{t(c.category)}</span>
                <span className="cat-track"><span style={{ width: `${(Number(c.amount) / Math.max(1, Number(p.categories[0]!.amount))) * 100}%` }} /></span>
                <span className="mono">{money(c.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">{t('Income is sales before GST, from your e-invoices. Expenses are what you recorded, before the GST you claim back (GST you cannot claim counts as a cost).')}</p>
      </section>
    </div>
  );
}
