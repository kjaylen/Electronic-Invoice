import { useEffect, useMemo, useState } from 'react';
import { api, link, type Summary } from '../api';
import { useI18n, useT } from '../i18n';
import { belizeToday, ErrorText, Field, fromCents, money, Segmented, toCents, usePageTitle } from '../ui';

type Preset = 'month' | 'last-month' | 'quarter' | 'year' | 'custom';

function presetRange(p: Exclude<Preset, 'custom'>): [string, string] {
  const today = belizeToday();
  const [y, m] = today.split('-').map(Number) as [number, number];
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  switch (p) {
    case 'month':
      return [iso(y, m, 1), today];
    case 'last-month':
      return [iso(y, m - 1, 1), iso(y, m, 0)];
    case 'quarter':
      return [iso(y, Math.floor((m - 1) / 3) * 3 + 1, 1), today];
    case 'year':
      return [iso(y, 1, 1), today];
  }
}

interface CustomerRow { name: string; tin: string | null; documents: number; net: string; gst: string; total: string }
interface ItemRow { description: string; unitCode: string; quantity: string; net: string; gst: string; total: string }

/** One bar per day (or per month for long periods), with the missing days filled in as zero. */
function buckets(summary: Summary, lang: string): Array<{ key: string; label: string; total: bigint; documents: number }> {
  const { from, to } = summary.period;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const byMonth = days > 62;
  const map = new Map<string, { total: bigint; documents: number }>();
  for (const d of summary.byDay) {
    const k = byMonth ? d.date.slice(0, 7) : d.date;
    const e = map.get(k) ?? { total: 0n, documents: 0 };
    map.set(k, { total: e.total + toCents(d.total), documents: e.documents + d.documents });
  }
  const out: Array<{ key: string; label: string; total: bigint; documents: number }> = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat(lang, byMonth ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
  while (cursor <= end && out.length < 400) {
    const k = byMonth ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10);
    if (!out.length || out.at(-1)!.key !== k) out.push({ key: k, label: fmt.format(cursor), ...(map.get(k) ?? { total: 0n, documents: 0 }) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function SalesChart({ summary }: { summary: Summary }) {
  const { t, lang } = useI18n();
  const data = useMemo(() => buckets(summary, lang), [summary, lang]);
  const [hover, setHover] = useState<number | null>(null);
  const max = data.reduce((m, d) => (d.total > m ? d.total : m), 0n);
  if (!data.length) return null;
  const pct = (v: bigint) => (max > 0n && v > 0n ? Math.max(Number((v * 1000n) / max) / 10, 1.5) : 0);
  const active = hover !== null ? data[hover] : null;
  const step = Math.ceil(data.length / 8);
  return (
    <figure className="chart">
      <figcaption className="sr-only">{t('Sales per day, in BZ$. The same figures are in the tables below.')}</figcaption>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <span className="chart-max num">{money(fromCents(max))}</span>
        <div className="chart-grid" aria-hidden="true"><span /><span /></div>
        <div className="chart-bars">
          {data.map((d, i) => (
            <button
              key={d.key}
              type="button"
              className={`bar-hit ${hover === i ? 'hover' : ''}`}
              aria-label={`${d.label}: ${money(fromCents(d.total))}, ${t('{n} documents', { n: d.documents })}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <span className="bar" style={{ height: `${pct(d.total)}%` }} />
            </button>
          ))}
        </div>
        {active && hover !== null && (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }} role="status">
            <strong>{active.label}</strong>
            <span className="num">{money(fromCents(active.total))}</span>
            <span className="muted">{t('{n} documents', { n: active.documents })}</span>
          </div>
        )}
      </div>
      <div className="chart-axis" aria-hidden="true">
        {data.map((d, i) => <span key={d.key}>{i % step === 0 ? d.label : ''}</span>)}
      </div>
    </figure>
  );
}

export function Reports() {
  const t = useT();
  usePageTitle(t('Reports'));
  const [preset, setPreset] = useState<Preset>('month');
  const [range, setRange] = useState<[string, string]>(() => presetRange('month'));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [from, to] = range;
  const qs = `from=${from}&to=${to}`;

  useEffect(() => {
    if (!from || !to || from > to) return;
    setError(null);
    setSummary(null);
    void Promise.all([
      api<Summary>(`/v1/reports/summary?${qs}`),
      api<{ data: CustomerRow[] }>(`/v1/reports/customers?${qs}`),
      api<{ data: ItemRow[] }>(`/v1/reports/items?${qs}`),
    ]).then(([s, c, i]) => {
      setSummary(s);
      setCustomers(c.data);
      setItems(i.data);
    }).catch(setError);
  }, [from, to, qs]);

  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  };
  const rateLabel: Record<string, string> = { S: t('Standard rate (12.5%)'), Z: t('Zero-rated'), E: t('Exempt') };

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Insights')}</span><h1>{t('Reports')}</h1></div>
        <span className="spacer" />
        <a className="button secondary" href={link(`/v1/reports/documents?${qs}`)} download>{t('All documents (CSV)')}</a>
      </div>
      <div className="card row filters">
        <Segmented
          label={t('Period')}
          value={preset}
          onChange={choose}
          options={[['month', t('This month')], ['last-month', t('Last month')], ['quarter', t('This quarter')], ['year', t('This year')], ['custom', t('Custom')]]}
        />
        {preset === 'custom' && (
          <>
            <Field label={t('From')}><input type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></Field>
            <Field label={t('To')}><input type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></Field>
          </>
        )}
        <span className="spacer" />
        <span className="small muted num">{from} → {to}</span>
      </div>
      <ErrorText error={error} />

      {!summary ? <div className="grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: '6rem' }} />)}</div> : (
        <>
          <div className="grid four">
            <div className="card stat"><div className="label">{t('Sales, GST included')}</div><div className="value num">{money(summary.totals.total)}</div></div>
            <div className="card stat"><div className="label">{t('Net sales')}</div><div className="value num">{money(summary.totals.net)}</div></div>
            <div className="card stat"><div className="label">{t('GST collected')}</div><div className="value num">{money(summary.totals.gst)}</div></div>
            <div className="card stat"><div className="label">{t('Documents')}</div><div className="value num">{summary.totals.documents}</div></div>
          </div>

          <section className="card">
            <h2>{t('Sales per day')}</h2>
            {summary.byDay.length ? <SalesChart summary={summary} /> : <div className="empty">{t('No sales in this period.')}</div>}
          </section>

          <section className="card">
            <div className="row">
              <div>
                <h2>{t('GST by rate')}</h2>
                <p className="small muted">{t('For your GST return. Credit notes are subtracted; rejected and cancelled documents are left out. Check with your accountant before filing.')}</p>
              </div>
              <span className="spacer" />
              <a className="button secondary" href={link(`/v1/reports/summary?${qs}&format=csv`)} download>CSV</a>
            </div>
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Rate')}</th><th scope="col" className="right">{t('Net sales')}</th><th scope="col" className="right">GST</th></tr></thead>
                <tbody>
                  {summary.byRate.map((r) => (
                    <tr key={r.category}><td data-label={t('Rate')}>{rateLabel[r.category]}</td><td data-label={t('Net sales')} className="right">{money(r.net)}</td><td data-label="GST" className="right">{money(r.gst)}</td></tr>
                  ))}
                  <tr className="total-row"><td><strong>{t('Total')}</strong></td><td className="right"><strong>{money(summary.totals.net)}</strong></td><td className="right"><strong>{money(summary.totals.gst)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid two">
            <section className="card">
              <div className="row"><h2>{t('Top customers')}</h2><span className="spacer" /><a className="button secondary" href={link(`/v1/reports/customers?${qs}&format=csv`)} download>CSV</a></div>
              {customers.length === 0 ? <div className="empty">{t('No sales in this period.')}</div> : (
                <div className="table-wrap">
                  <table className="responsive">
                    <thead><tr><th scope="col">{t('Customer')}</th><th scope="col" className="right">{t('Documents')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
                    <tbody>
                      {customers.slice(0, 15).map((c) => (
                        <tr key={`${c.name}|${c.tin}`}><td data-label={t('Customer')}>{c.name === 'Walk-in customers' ? t('Walk-in customers') : c.name}{c.tin && <span className="small muted"> · TIN {c.tin}</span>}</td><td data-label={t('Documents')} className="right">{c.documents}</td><td data-label={t('Total')} className="right">{money(c.total)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card">
              <div className="row"><h2>{t('Top items')}</h2><span className="spacer" /><a className="button secondary" href={link(`/v1/reports/items?${qs}&format=csv`)} download>CSV</a></div>
              {items.length === 0 ? <div className="empty">{t('No sales in this period.')}</div> : (
                <div className="table-wrap">
                  <table className="responsive">
                    <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Qty')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
                    <tbody>
                      {items.slice(0, 15).map((i) => (
                        <tr key={`${i.description}|${i.unitCode}`}><td data-label={t('Item')}>{i.description}</td><td data-label={t('Qty')} className="right">{i.quantity}</td><td data-label={t('Total')} className="right">{money(i.total)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
