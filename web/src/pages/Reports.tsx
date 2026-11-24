import { useEffect, useMemo, useState } from 'react';
import { api, link, type Summary } from '../api';
import { useI18n, useT } from '../i18n';
import { belizeToday, ErrorText, Field, fromCents, Modal, money, Segmented, toCents, usePageTitle } from '../ui';
import { useSearchParams } from 'react-router';
import { GstReturnView, ProfitView } from './Accounting';
import { BusinessTaxView } from './BusinessTax';
import { useSession } from '../session';
import { HoursWorkedPanel } from './TimeClock';

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
interface CategoryRow { name: string | null; sales: number; net: string; total: string }
interface StaffRow { name: string | null; documents: number; total: string; discounts: string; receipts: number; averageReceipt: string | null }
interface HourRow { hour: number; documents: number; total: string }

/** Sales by hour of the day, from the first hour with a sale to the last (at least 7 am to 7 pm). */
function HoursChart({ hours }: { hours: HourRow[] }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const first = Math.min(7, ...hours.map((h) => h.hour));
  const last = Math.max(19, ...hours.map((h) => h.hour));
  const data = Array.from({ length: last - first + 1 }, (_, i) => {
    const h = hours.find((x) => x.hour === first + i);
    return { hour: first + i, total: h ? toCents(h.total) : 0n, documents: h?.documents ?? 0 };
  });
  const max = data.reduce((m, d) => (d.total > m ? d.total : m), 0n);
  const pct = (v: bigint) => (max > 0n && v > 0n ? Math.max(Number((v * 1000n) / max) / 10, 1.5) : 0);
  const label = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  const active = hover !== null ? data[hover] : null;
  return (
    <figure className="chart">
      <figcaption className="sr-only">{t('Sales by hour of the day, in BZ$.')}</figcaption>
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <span className="chart-max num">{money(fromCents(max))}</span>
        <div className="chart-grid" aria-hidden="true"><span /><span /></div>
        <div className="chart-bars">
          {data.map((d, i) => (
            <button key={d.hour} type="button" className={`bar-hit ${hover === i ? 'hover' : ''}`} aria-label={`${label(d.hour)}: ${money(fromCents(d.total))}, ${t('{n} documents', { n: d.documents })}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              <span className="bar" style={{ height: `${pct(d.total)}%`, '--i': i } as React.CSSProperties} />
            </button>
          ))}
        </div>
        {active && hover !== null && (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }} role="status">
            <strong>{label(active.hour)}</strong>
            <span className="num">{money(fromCents(active.total))}</span>
            <span className="muted">{t('{n} documents', { n: active.documents })}</span>
          </div>
        )}
      </div>
      <div className="chart-axis" aria-hidden="true">{data.map((d, i) => <span key={d.hour}>{i % 2 === 0 ? label(d.hour) : ''}</span>)}</div>
    </figure>
  );
}

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

export function SalesChart({ summary }: { summary: Summary }) {
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
              <span className="bar" style={{ height: `${pct(d.total)}%`, '--i': i } as React.CSSProperties} />
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
  const { can } = useSession();
  usePageTitle(t('Reports'));
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'sales' | 'gst' | 'business-tax' | 'profit' | null) ?? 'sales';
  // A link can name the period (the overview's "coming up" opens last month's worksheet).
  const asked = [params.get('from') ?? '', params.get('to') ?? ''] as [string, string];
  const named = asked.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) && asked[0] <= asked[1];
  const [preset, setPreset] = useState<Preset>(named ? 'custom' : 'month');
  const [range, setRange] = useState<[string, string]>(() => (named ? asked : presetRange('month')));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [hours, setHours] = useState<HourRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [archiving, setArchiving] = useState(false);
  const [withPdf, setWithPdf] = useState(true);
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
      api<{ data: StaffRow[] }>(`/v1/reports/staff?${qs}`),
      api<{ data: HourRow[] }>(`/v1/reports/hours?${qs}`),
      api<{ data: CategoryRow[] }>(`/v1/reports/categories?${qs}`),
    ]).then(([s, c, i, st, h, cat]) => {
      setSummary(s);
      setCustomers(c.data);
      setItems(i.data);
      setStaff(st.data);
      setHours(h.data);
      setCategories(cat.data);
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
        <a className="button secondary" href={link(`/v1/reports/accountant-pack?${qs}`)} download title={t('The GST return, profit and loss, sales, payments, expenses with their receipts, who owes you and your stock, in one ZIP')}>{t('For your accountant (ZIP)')}</a>
        <button className="secondary" onClick={() => setArchiving(true)}>{t('Download archive')}</button>
      </div>
      {archiving && (
        <Modal title={t('Download the archive')} onClose={() => setArchiving(false)}>
          <div className="stack">
            <p>{t('One ZIP file with every document from {from} to {to}: the signed XML exactly as sent to BTS, BTS’s replies, cancellations and the register. Keep it with your tax records.', { from, to })}</p>
            <label className="row small"><input type="checkbox" checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} /> {t('Include the PDFs (slower for long periods)')}</label>
            <div className="row">
              <span className="spacer" />
              <button type="button" className="secondary" onClick={() => setArchiving(false)}>{t('Close')}</button>
              <a className="button" href={link(`/v1/reports/archive?${qs}${withPdf ? '&pdf=true' : ''}`)} download onClick={() => setArchiving(false)}>{t('Download ZIP')}</a>
            </div>
          </div>
        </Modal>
      )}
      <div className="card row filters">
        <Segmented switches
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
      <Segmented switches label={t('Report')} value={view} onChange={(v) => setParams(v === 'sales' ? {} : { view: v }, { replace: true })} options={[['sales', t('Sales')], ['gst', t('GST return')], ['business-tax', t('Business tax')], ['profit', t('Profit and loss')]]} />
      {view === 'gst' && <GstReturnView from={from} to={to} />}
      {view === 'business-tax' && <BusinessTaxView from={from} to={to} />}
      {view === 'profit' && <ProfitView from={from} to={to} />}

      {view !== 'sales' ? null : !summary ? <div className="grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: '6rem' }} />)}</div> : (
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

          <div className="grid two">
            <section className="card">
              <div className="row"><h2>{t('Sales by staff')}</h2><span className="spacer" /><a className="button secondary" href={link(`/v1/reports/staff?${qs}&format=csv`)} download>CSV</a></div>
              {staff.length === 0 ? <div className="empty">{t('No sales in this period.')}</div> : (
                <div className="table-wrap">
                  <table className="responsive">
                    <thead><tr><th scope="col">{t('Person')}</th><th scope="col" className="right">{t('Documents')}</th><th scope="col" className="right">{t('Average receipt')}</th><th scope="col" className="right">{t('Discounts')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
                    <tbody>
                      {staff.map((s) => (
                        <tr key={s.name ?? '-'}>
                          <td data-label={t('Person')}>{s.name ?? <span className="muted">{t('API and automatic')}</span>}</td>
                          <td data-label={t('Documents')} className="right">{s.documents}</td>
                          <td data-label={t('Average receipt')} className="right">{s.averageReceipt ? money(s.averageReceipt) : '—'}</td>
                          <td data-label={t('Discounts')} className="right">{s.discounts !== '0.00' ? money(s.discounts) : '—'}</td>
                          <td data-label={t('Total')} className="right">{money(s.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card">
              <h2>{t('Busiest hours')}</h2>
              {hours.length === 0 ? <div className="empty">{t('No sales in this period.')}</div> : <HoursChart hours={hours} />}
            </section>
          </div>
          {categories.some((c) => c.name !== null) && <CategoryPanel rows={categories} qs={qs} />}
          {can('documents.adjust') && <HoursWorkedPanel from={from} to={to} />}
        </>
      )}
    </div>
  );
}

/** Sales by item category, each with its share of the period's sales. */
function CategoryPanel(props: { rows: CategoryRow[]; qs: string }) {
  const t = useT();
  const sum = props.rows.reduce((a, r) => a + Math.max(0, Number(r.total)), 0);
  return (
    <section className="card">
      <div className="row"><h2>{t('Sales by category')}</h2><span className="spacer" /><a className="button secondary" href={link(`/v1/reports/categories?${props.qs}&format=csv`)} download>CSV</a></div>
      <div className="table-wrap">
        <table className="responsive category-report">
          <thead><tr><th scope="col">{t('Category')}</th><th scope="col" className="right">{t('Sales')}</th><th scope="col">{t('Share')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
          <tbody>
            {props.rows.map((r) => {
              const share = sum > 0 ? Math.max(0, Number(r.total)) / sum : 0;
              return (
                <tr key={r.name ?? '-'}>
                  <td data-label={t('Category')}>{r.name ?? <span className="muted">{t('No category')}</span>}</td>
                  <td data-label={t('Sales')} className="right">{r.sales}</td>
                  <td data-label={t('Share')}><span className="share"><span className="share-bar" style={{ width: `${(share * 100).toFixed(1)}%` }} /><span className="small muted num">{Math.round(share * 100)}%</span></span></td>
                  <td data-label={t('Total')} className="right">{money(r.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
