/** Service reports: the day or a range (sales, covers, voids and comps, tenders, taxes), a server's checkout, tips and their pool, and the day's close. */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, money, Segmented, Select, usePageTitle } from '../ui';
import './venue.css';

interface Row { name: string; count: number; amount: string }
interface Report {
  period: { from: string; to: string };
  sales: { net: string; serviceCharge: string; checks: number };
  covers: { covers: number; tables: number; averagePerCover: string; averageTurnMinutes: number | null };
  byArea: Row[]; byCategory: Row[]; byServer: Row[]; byHour: Array<{ hour: string; items: number; amount: string }>;
  byItem: Array<{ name: string; quantity: number; amount: string; cost: string | null; margin: string | null; marginPercent: number | null }>;
  voids: Row[]; comps: Row[]; discounts: Row[]; tips: { total: string; byServer: Row[] }; tenders: Row[];
  taxes: { gst: string; documents: number; documentsNet: string; hotelTax: string };
  hotel: { nights: number; roomNights: number; occupancyPercent: number; roomRevenue: string; adr: string; revpar: string } | null;
}
interface Checkout { server: { id: string; name: string }; businessDate: string; sales: Report['sales']; covers: Report['covers']; tenders: Row[]; tips: Report['tips']; voids: Row[]; comps: Row[]; discounts: Row[]; openChecks: Array<{ id: string; number: number; name: string }>; cashTaken: string; tipsToPayOut: string; cashDue: string }
interface Tips { method: string; pool: string; shared: string; notShared: string; people: Array<{ id: string; name: string; role: string; hours: number; tipsTaken: string; share: string }> }
interface Day { businessDate: string; closedThrough: string | null; openTables: Array<{ id: string; number: number; table: string | null; server: string; status: string }>; openTabs: Array<{ id: string; number: number; name: string; server: string }>; openShifts: Array<{ id: string; number: number; register: string; openedBy: string }>; ticketsNotPrinted: number }

const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

function Table({ title, rows, columns, empty }: { title: string; rows: Array<Array<ReactNode>>; columns: string[]; empty?: string }) {
  const t = useT();
  return (
    <section className="card stack">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted small">{empty ?? t('Nothing in this period.')}</p> : (
        <div className="table-wrap"><table className="responsive">
          <thead><tr>{columns.map((c, n) => <th key={c} scope="col" className={n > 0 ? 'right' : ''}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, n) => <td key={n} data-label={columns[n]} className={n > 0 ? 'right' : ''}>{cell}</td>)}</tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function VenueReportsPage() {
  const t = useT();
  usePageTitle(t('Service reports'));
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'sales' | 'checkout' | 'tips' | 'close' | null) ?? 'sales';
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  return (
    <div className="stack">
      <div className="row"><div><span className="kicker">{t('Service')}</span><h1>{t('Service reports')}</h1></div></div>
      <Segmented switches label={t('Report')} value={view} onChange={(v) => setParams({ view: v }, { replace: true })} options={[['sales', t('Sales and service')], ['checkout', t('Server checkout')], ['tips', t('Tips')], ...(can('venue.approve') ? [['close', t('Close the day')] as ['close', string]] : [])]} />
      {view !== 'close' && view !== 'checkout' && (
        <div className="card row filters">
          <Field label={t('From')}><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label={t('To')}><input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
          <span className="spacer" /><span className="small muted">{t('By business day: sales after midnight count with the evening before.')}</span>
        </div>
      )}
      {view === 'sales' && <SalesReport from={from} to={to} />}
      {view === 'checkout' && <ServerCheckout />}
      {view === 'tips' && <TipReport from={from} to={to} />}
      {view === 'close' && <CloseDay />}
    </div>
  );
}

function SalesReport({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setR(null); void api<Report>(`/v1/venue/reports?from=${from}&to=${to}`).then(setR).catch(setError); }, [from, to]);
  if (error) return <ErrorText error={error} />;
  if (!r) return <div className="skeleton" style={{ height: '16rem' }} />;
  const amount = (rows: Row[]) => rows.map((x) => [x.name, x.count, money(x.amount)]);
  return (
    <div className="stack">
      <div className="kpis">
        <div className="card kpi"><span className="kpi-head">{t('Sales before GST')}</span><span className="kpi-value">{money(r.sales.net)}</span><span className="kpi-note">{t('{n} checks · service charge {amount}', { n: r.sales.checks, amount: money(r.sales.serviceCharge) })}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Covers')}</span><span className="kpi-value">{r.covers.covers}</span><span className="kpi-note">{t('{amount} a cover · {n} tables', { amount: money(r.covers.averagePerCover), n: r.covers.tables })}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Table turn')}</span><span className="kpi-value">{r.covers.averageTurnMinutes === null ? '—' : `${r.covers.averageTurnMinutes}′`}</span><span className="kpi-note">{t('From seated to cleared, on average')}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('GST on the documents')}</span><span className="kpi-value">{money(r.taxes.gst)}</span><span className="kpi-note">{t('{n} tax documents for {amount}', { n: r.taxes.documents, amount: money(r.taxes.documentsNet) })}</span></div>
      </div>
      <div className="grid two">
        <Table title={t('By area')} columns={[t('Area'), t('Checks'), t('Sales')]} rows={amount(r.byArea)} />
        <Table title={t('By server')} columns={[t('Server'), t('Checks'), t('Sales')]} rows={amount(r.byServer)} />
        <Table title={t('By category')} columns={[t('Category'), t('Items'), t('Sales')]} rows={amount(r.byCategory)} />
        <Table title={t('By hour')} columns={[t('Hour'), t('Items'), t('Sales')]} rows={r.byHour.map((h) => [h.hour, h.items, money(h.amount)])} />
      </div>
      <Table title={t('Menu performance')} columns={[t('Item'), t('Sold'), t('Sales'), t('Recipe cost'), t('Margin'), '%']} rows={r.byItem.map((i) => [i.name, i.quantity, money(i.amount), i.cost === null ? '—' : money(i.cost), i.margin === null ? '—' : money(i.margin), i.marginPercent === null ? '—' : `${i.marginPercent}%`])} />
      <div className="grid two">
        <Table title={t('Voids after sending')} columns={[t('Who and why'), t('Items'), t('Value')]} rows={amount(r.voids)} empty={t('None.')} />
        <Table title={t('On the house')} columns={[t('Who and why'), t('Items'), t('Value')]} rows={amount(r.comps)} empty={t('None.')} />
        <Table title={t('Discounts')} columns={[t('Who and why'), t('Items'), t('Value')]} rows={amount(r.discounts)} empty={t('None.')} />
        <Table title={t('How it was paid')} columns={[t('Tender'), t('Payments'), t('Amount')]} rows={amount(r.tenders)} />
      </div>
      <Table title={t('Tips: {amount}', { amount: money(r.tips.total) })} columns={[t('Server'), t('Tips'), t('Amount')]} rows={amount(r.tips.byServer)} empty={t('None.')} />
      {r.hotel && (
        <section className="card stack">
          <h2>{t('Hotel')}</h2>
          <div className="kpis">
            <div className="card kpi"><span className="kpi-head">{t('Occupancy')}</span><span className="kpi-value">{r.hotel.occupancyPercent}%</span><span className="kpi-note">{t('{n} room nights', { n: r.hotel.roomNights })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Room revenue')}</span><span className="kpi-value">{money(r.hotel.roomRevenue)}</span><span className="kpi-note">{t('Hotel tax {amount}', { amount: money(r.taxes.hotelTax) })}</span></div>
            <div className="card kpi"><span className="kpi-head">ADR</span><span className="kpi-value">{money(r.hotel.adr)}</span><span className="kpi-note">RevPAR {money(r.hotel.revpar)}</span></div>
          </div>
        </section>
      )}
    </div>
  );
}

function ServerCheckout() {
  const t = useT();
  const { can, session } = useSession();
  const [staff, setStaff] = useState<Array<{ id: string; name: string; orders: boolean }>>([]);
  const [userId, setUserId] = useState(session?.user.id ?? '');
  const [date, setDate] = useState('');
  const [c, setC] = useState<Checkout | null>(null);
  const [error, setError] = useState<unknown>(null);
  const any = can('venue.approve') || can('reports.view');
  useEffect(() => { if (any) void api<{ staff?: Array<{ id: string; name: string; orders: boolean }> }>('/v1/venue').then((r) => setStaff((r.staff ?? []).filter((s) => s.orders))).catch(() => {}); }, [any]);
  useEffect(() => { setC(null); setError(null); void api<Checkout>(`/v1/venue/checkout?userId=${userId}${date ? `&date=${date}` : ''}`).then(setC).catch(setError); }, [userId, date]);
  const amount = (rows: Row[]) => rows.map((x) => [x.name, x.count, money(x.amount)]);
  return (
    <div className="stack">
      <div className="card row filters">
        {any && staff.length > 0 && <Field label={t('Server')}><Select value={userId} onChange={(e) => setUserId(e.target.value)}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
        <Field label={t('Business day')}><input type="date" value={date || c?.businessDate || ''} onChange={(e) => setDate(e.target.value)} /></Field>
        <span className="spacer" /><button type="button" className="secondary" onClick={() => window.print()}>{t('Print')}</button>
      </div>
      <ErrorText error={error} />
      {!c ? !error && <div className="skeleton" style={{ height: '12rem' }} /> : (
        <>
          <div className="kpis">
            <div className="card kpi"><span className="kpi-head">{c.server.name}</span><span className="kpi-value">{money(c.sales.net)}</span><span className="kpi-note">{t('{n} checks · {c} covers', { n: c.sales.checks, c: c.covers.covers })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Cash taken')}</span><span className="kpi-value">{money(c.cashTaken)}</span><span className="kpi-note">{t('Card and wallet tips to pay out: {amount}', { amount: money(c.tipsToPayOut) })}</span></div>
            <div className="card kpi good"><span className="kpi-head">{t('Cash due')}</span><span className="kpi-value">{money(c.cashDue)}</span><span className="kpi-note">{t('What they hand in')}</span></div>
          </div>
          {c.openChecks.length > 0 && <div className="banner warn"><div><strong>{t('Still open')}:</strong> {c.openChecks.map((x) => x.name).join(', ')}</div></div>}
          <div className="grid two">
            <Table title={t('How it was paid')} columns={[t('Tender'), t('Payments'), t('Amount')]} rows={amount(c.tenders)} />
            <Table title={t('Tips: {amount}', { amount: money(c.tips.total) })} columns={[t('Server'), t('Tips'), t('Amount')]} rows={amount(c.tips.byServer)} empty={t('None.')} />
            <Table title={t('Voids after sending')} columns={[t('Who and why'), t('Items'), t('Value')]} rows={amount(c.voids)} empty={t('None.')} />
            <Table title={t('On the house and discounts')} columns={[t('Who and why'), t('Items'), t('Value')]} rows={amount([...c.comps, ...c.discounts])} empty={t('None.')} />
          </div>
        </>
      )}
    </div>
  );
}

function TipReport({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [r, setR] = useState<Tips | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setR(null); void api<Tips>(`/v1/venue/tips?from=${from}&to=${to}`).then(setR).catch(setError); }, [from, to]);
  if (error) return <ErrorText error={error} />;
  if (!r) return <div className="skeleton" style={{ height: '10rem' }} />;
  const METHOD: Record<string, string> = { none: 'Not pooled: each keeps their own', hours: 'By hours worked', role: 'By role, in percent', points: 'By points per hour, by role' };
  return (
    <div className="stack">
      <div className="kpis">
        <div className="card kpi"><span className="kpi-head">{t('Tips in the period')}</span><span className="kpi-value">{money(r.pool)}</span><span className="kpi-note">{t(METHOD[r.method] ?? r.method)}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Shared out')}</span><span className="kpi-value">{money(r.shared)}</span><span className="kpi-note">{Number(r.notShared) > 0 ? t('{amount} not shared: nobody to give it to by the rule', { amount: money(r.notShared) }) : t('All of it')}</span></div>
      </div>
      <Table title={t('Who gets what')} columns={[t('Person'), t('Role'), t('Hours'), t('Tips taken'), t('Share')]} rows={r.people.map((p) => [p.name, t(p.role), p.hours.toFixed(2), money(p.tipsTaken), <strong key="s">{money(p.share)}</strong>])} />
      <p className="small muted">{t('Hours come from the time clock. These are the figures only: paying staff is done outside this system. Change how tips are shared under Settings → Venue.')}</p>
    </div>
  );
}

function CloseDay() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<Day | null>(null);
  const [done, setDone] = useState<{ closed: string; businessDate: string; report: Report } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Day>('/v1/venue/day').then(setD).catch(setError), []);
  useEffect(() => void load(), [load]);
  if (!d) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '10rem' }} />;
  const open = [...d.openTables.filter((x) => x.status === 'open'), ...d.openTabs];
  const close = async (carryOver: boolean) => {
    if (!(await confirm({ title: t('Close {date}?', { date: d.businessDate }), body: carryOver && open.length ? t('{n} open tables and tabs are carried over to tomorrow. The day’s report is kept, and what is rung up from now on belongs to the next day.', { n: open.length }) : t('The day’s report is kept, and what is rung up from now on belongs to the next day.'), confirm: t('Close the day') }))) return;
    setBusy(true);
    setError(null);
    try { const r = await api<NonNullable<typeof done>>('/v1/venue/day/close', { method: 'POST', body: { carryOver } }); setDone(r); toast(t('{date} is closed.', { date: r.closed })); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const step = (ok: boolean, title: string, detail: ReactNode) => <li className="row"><span className={`badge ${ok ? 'pay-paid' : 'pay-overdue'}`}>{ok ? '✓' : '!'}</span><div><strong>{title}</strong><div className="small muted">{detail}</div></div></li>;
  return (
    <div className="stack">
      <section className="card stack">
        <div><span className="kicker">{t('Business day')}</span><div className="stock-big">{d.businessDate}</div>{d.closedThrough && <p className="small muted">{t('Closed through {date}', { date: d.closedThrough })}</p>}</div>
        <ul className="plain venue-setup-list">
          {step(open.length === 0, open.length ? t('{n} tables and tabs are still open', { n: open.length }) : t('No tables or tabs are open'), open.length ? [...d.openTables.filter((x) => x.status === 'open').map((x) => `${x.table} (${x.server})`), ...d.openTabs.map((x) => `${x.name} (${x.server})`)].join(', ') : t('Every check is paid or closed.'))}
          {step(d.openShifts.length === 0, d.openShifts.length ? t('{n} shifts are still open', { n: d.openShifts.length }) : t('Every shift is closed'), d.openShifts.length ? `${d.openShifts.map((s) => `${s.register} (${s.openedBy})`).join(', ')}. ${t('Each is closed with its blind count under Cash register.')}` : t('Each drawer was counted.'))}
          {step(d.ticketsNotPrinted === 0, d.ticketsNotPrinted ? t('{n} kitchen tickets did not print', { n: d.ticketsNotPrinted }) : t('Every kitchen ticket printed'), t('From the last 24 hours.'))}
        </ul>
        <ErrorText error={error} />
        <div className="row">
          <button type="button" disabled={busy || d.openShifts.length > 0 || open.length > 0} onClick={() => void close(false)}>{t('Close the day')}</button>
          {open.length > 0 && <button type="button" className="secondary" disabled={busy || d.openShifts.length > 0} onClick={() => void close(true)}>{t('Carry the open ones over and close')}</button>}
        </div>
      </section>
      {done && (
        <section className="card stack">
          <h2>{t('Day report for {date}', { date: done.closed })}</h2>
          <div className="kpis">
            <div className="card kpi"><span className="kpi-head">{t('Sales before GST')}</span><span className="kpi-value">{money(done.report.sales.net)}</span><span className="kpi-note">{t('{n} checks · service charge {amount}', { n: done.report.sales.checks, amount: money(done.report.sales.serviceCharge) })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Covers')}</span><span className="kpi-value">{done.report.covers.covers}</span><span className="kpi-note">{money(done.report.covers.averagePerCover)}</span></div>
            <div className="card kpi"><span className="kpi-head">GST</span><span className="kpi-value">{money(done.report.taxes.gst)}</span><span className="kpi-note">{t('{n} tax documents for {amount}', { n: done.report.taxes.documents, amount: money(done.report.taxes.documentsNet) })}</span></div>
          </div>
          <p className="small muted">{t('The full report for any day is under Sales and service.')} {t('The next business day is {date}.', { date: done.businessDate })}</p>
        </section>
      )}
    </div>
  );
}
