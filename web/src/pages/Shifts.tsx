/** Cash registers and shifts: open with a float, cash in and out, count the drawer, the end-of-day report. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, link } from '../api';
import { useT } from '../i18n';
import { printPdf } from '../print';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, fromCents, Modal, money, Select, toCents, usePageTitle } from '../ui';

type Means = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';
const MEANS: Array<[Means, string]> = [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']];
const DENOMINATIONS = ['100', '50', '20', '10', '5', '2', '1', '0.50', '0.25', '0.10', '0.05', '0.01'] as const;

export interface Shift {
  id: string;
  number: number;
  register: { id: string; name: string };
  openedBy: { id: string; name: string };
  openedAt: string;
  openingFloat: string;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedAt: string | null;
  expectedCash: string | null;
  countedCash: string | null;
  difference: string | null;
  note: string | null;
}

export interface ShiftReport {
  documents: Array<{ type: string; name: string; count: number; total: string; gst: string }>;
  gst: string;
  sales: Record<Means, string>;
  invoicePayments: Record<Means, string>;
  refunds: Record<Means, string>;
  refundCount: number;
  takings: Record<Means, string>;
  totalTakings: string;
  voided: { count: number; total: string };
  discounts?: { count: number; total: string };
  cash: { float: string; in: string; payIn: string; payOut: string; expected: string; counted: string | null; difference: string | null };
  movements: Array<{ id: string; kind: 'pay_in' | 'pay_out'; amount: string; reason: string; at: string; by: string | null }>;
}

interface Register { id: string; name: string; openBy: string | null; openSince: string | null }

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

export function DifferenceText({ difference }: { difference: string | null }) {
  const t = useT();
  if (difference === null) return <>—</>;
  const c = toCents(difference);
  return <span className={c === 0n ? 'gain-text' : 'late'}>{c === 0n ? t('Balanced') : c < 0n ? t('Short {amount}', { amount: money(difference.replace('-', '')) }) : t('Over {amount}', { amount: money(difference) })}</span>;
}

// ---------- the bar at the top of the counter ----------

export function ShiftBar({ refreshKey }: { refreshKey?: string | null } = {}) {
  const t = useT();
  const navigate = useNavigate();
  const [current, setCurrent] = useState<{ shift: Shift | null; report: ShiftReport | null } | null>(null);
  const [dialog, setDialog] = useState<null | 'open' | 'cash' | 'close'>(null);
  const load = useCallback(() => api<{ shift: Shift | null; report: ShiftReport | null }>('/v1/shifts/current').then(setCurrent).catch(() => {}), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => clearInterval(timer);
  }, [load, refreshKey]);
  if (!current) return null;
  const s = current.shift;
  return (
    <>
      {s ? (
        <div className="shift-bar open">
          <span className="shift-dot" aria-hidden="true" />
          <span><strong>{t('Shift #{n}', { n: s.number })}</strong> · {s.register.name} · {t('since {time}', { time: time(s.openedAt) })}</span>
          <span className="spacer" />
          <span className="small">{t('Cash expected {amount}', { amount: money(current.report?.cash.expected ?? s.openingFloat) })}</span>
          <button type="button" className="secondary small-button" onClick={() => setDialog('cash')}>{t('Cash in/out')}</button>
          <button type="button" className="small-button" onClick={() => setDialog('close')}>{t('Close shift')}</button>
        </div>
      ) : (
        <div className="shift-bar">
          <span>{t('No shift open. Open one to count the drawer at the end of the day.')}</span>
          <span className="spacer" />
          <button type="button" className="small-button" onClick={() => setDialog('open')}>{t('Open shift')}</button>
        </div>
      )}
      {dialog === 'open' && <OpenShiftModal onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'cash' && s && <CashModal shift={s} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'close' && s && current.report && <CloseShiftModal shift={s} report={current.report} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); navigate(`/shifts/${id}`, { viewTransition: true }); }} />}
    </>
  );
}

export function OpenShiftModal({ onClose, onDone, atTill }: { onClose: () => void; onDone: () => void; atTill?: boolean }) {
  const t = useT();
  const toast = useToast();
  const [registers, setRegisters] = useState<Register[] | null>(null);
  const [registerId, setRegisterId] = useState('');
  const [float, setFloat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void (atTill ? Promise.resolve({ data: [] as Register[] }) : api<{ data: Register[] }>('/v1/registers')).then((r) => {
    setRegisters(r.data);
    setRegisterId(r.data.find((x) => !x.openBy)?.id ?? '');
  }).catch(setError), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/shifts', { method: 'POST', body: { openingFloat: float.trim() || '0', ...(registerId && !atTill && { registerId }) } });
      toast(t('Shift open'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Open a shift')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {!atTill && registers && registers.length > 1 && (
          <Field label={t('Register')}>
            <Select value={registerId} onChange={(e) => setRegisterId(e.target.value)} required>
              {registers.map((r) => <option key={r.id} value={r.id} disabled={Boolean(r.openBy)}>{r.name}{r.openBy ? ` (${t('open by {name}', { name: r.openBy })})` : ''}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('Cash in the drawer to start (float)')} hint={t('Count it now; it is what the drawer should still hold at the end, plus cash sales.')}>
          <input inputMode="decimal" placeholder="0.00" value={float} onChange={(e) => setFloat(e.target.value.trim())} autoFocus />
        </Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || (float !== '' && !MONEY.test(float))}>{t('Open shift')}</button></div>
      </form>
    </Modal>
  );
}

export function CashModal({ shift, onClose, onDone }: { shift: Shift; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [kind, setKind] = useState<'pay_out' | 'pay_in'>('pay_out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/shifts/${shift.id}/cash`, { method: 'POST', body: { kind, amount, reason: reason.trim() } });
      toast(kind === 'pay_out' ? t('Cash out recorded') : t('Cash in recorded'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Cash in or out of the drawer')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="tabs" role="group" aria-label={t('Kind')}>
          <button type="button" className={kind === 'pay_out' ? 'active' : ''} onClick={() => setKind('pay_out')}>{t('Take cash out')}</button>
          <button type="button" className={kind === 'pay_in' ? 'active' : ''} onClick={() => setKind('pay_in')}>{t('Put cash in')}</button>
        </div>
        <div className="form-grid">
          <Field label={t('Amount (BZ$)')}><input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value.trim())} autoFocus /></Field>
          <Field label={t('Why?')}><input required minLength={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'pay_out' ? t('e.g. Petty cash: cleaning, bank drop') : t('e.g. Change from the bank')} /></Field>
        </div>
        <p className="small muted">{t('Recorded on the shift and its end-of-day report. A mistake is corrected with the opposite movement.')}</p>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !MONEY.test(amount)}>{t('Record')}</button></div>
      </form>
    </Modal>
  );
}

export function CloseShiftModal({ shift, report, onClose, onDone }: { shift: Shift; report: ShiftReport; onClose: () => void; onDone: (id: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [byNotes, setByNotes] = useState(true);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const notesTotal = DENOMINATIONS.reduce((a, d) => a + toCents(d) * BigInt(Number(counts[d] || 0) || 0), 0n);
  const counted = byNotes ? notesTotal : MONEY.test(total) ? toCents(total) : null;
  const diff = counted === null ? null : counted - toCents(report.cash.expected);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (counted === null) return;
    setBusy(true);
    try {
      const detail = Object.fromEntries(DENOMINATIONS.filter((d) => Number(counts[d] || 0) > 0).map((d) => [d, Number(counts[d])]));
      await api(`/v1/shifts/${shift.id}/close`, { method: 'POST', body: { countedCash: fromCents(counted), ...(byNotes && { counted: detail }), ...(note.trim() && { note: note.trim() }) } });
      toast(t('Shift closed'));
      onDone(shift.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Close shift #{n}', { n: shift.number })} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small muted">{t('Count the cash in the drawer without looking at what is expected; the difference shows once you have counted.')}</p>
        <div className="tabs" role="group" aria-label={t('How to count')}>
          <button type="button" className={byNotes ? 'active' : ''} onClick={() => setByNotes(true)}>{t('Notes and coins')}</button>
          <button type="button" className={!byNotes ? 'active' : ''} onClick={() => setByNotes(false)}>{t('Just the total')}</button>
        </div>
        {byNotes ? (
          <div className="denominations">
            {DENOMINATIONS.map((d) => (
              <label key={d} className="denomination">
                <span className="mono">{toCents(d) >= 100n ? `$${Number(d)}` : `${Math.round(Number(d) * 100)}¢`}</span>
                <input inputMode="numeric" value={counts[d] ?? ''} onChange={(e) => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '').slice(0, 5) })} aria-label={t('How many of {d}', { d })} />
                <span className="small muted mono">{counts[d] ? money(fromCents(toCents(d) * BigInt(Number(counts[d])))) : ''}</span>
              </label>
            ))}
          </div>
        ) : (
          <Field label={t('Cash counted (BZ$)')}><input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value.trim())} autoFocus /></Field>
        )}
        <div className="close-summary">
          <div><span className="kicker">{t('Counted')}</span><div className="stock-big">{counted === null ? '—' : money(fromCents(counted))}</div></div>
          {counted !== null && counted > 0n && (
            <>
              <div><span className="kicker">{t('Expected')}</span><div>{money(report.cash.expected)}</div></div>
              <div><span className="kicker">{t('Difference')}</span><div className="strong"><DifferenceText difference={fromCents(diff!)} /></div></div>
            </>
          )}
        </div>
        <Field label={t('Note')} hint={t('Optional: explain a difference.')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || counted === null}>{t('Close shift')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- the report on screen ----------

export function ReportView({ report, shift }: { report: ShiftReport; shift: Shift }) {
  const t = useT();
  const used = MEANS.filter(([m]) => report.takings[m] !== '0.00' || report.refunds[m] !== '0.00');
  return (
    <div className="grid two">
      <section className="card stack">
        <h2>{t('Takings by payment')}</h2>
        <table>
          <tbody>
            {used.length === 0 && <tr><td className="muted">{t('Nothing taken yet.')}</td></tr>}
            {used.map(([m, name]) => (
              <tr key={m}>
                <td>{t(name)}{report.invoicePayments[m] !== '0.00' && <span className="small muted"> · {t('{amount} on invoices', { amount: money(report.invoicePayments[m]) })}</span>}{report.refunds[m] !== '0.00' && <span className="small late"> · {t('{amount} refunded', { amount: money(report.refunds[m]) })}</span>}</td>
                <td className="right mono">{money(report.takings[m])}</td>
              </tr>
            ))}
            <tr className="total-row"><td><strong>{t('Total')}</strong></td><td className="right mono"><strong>{money(report.totalTakings)}</strong></td></tr>
          </tbody>
        </table>
        <h3>{t('Documents')}</h3>
        <table>
          <tbody>
            {report.documents.length === 0 && <tr><td className="muted">{t('None yet.')}</td></tr>}
            {report.documents.map((d) => <tr key={d.type}><td>{t(d.name)} ({d.count})</td><td className="right mono">{money(d.total)}</td></tr>)}
            <tr><td>GST</td><td className="right mono">{money(report.gst)}</td></tr>
            {report.voided.count > 0 && <tr><td className="muted">{t('Cancelled ({n})', { n: report.voided.count })}</td><td className="right mono muted">{money(report.voided.total)}</td></tr>}
            {report.discounts && report.discounts.count > 0 && <tr><td className="muted">{t('Discounts given ({n} sales, before GST)', { n: report.discounts.count })}</td><td className="right mono muted">−{money(report.discounts.total)}</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="card stack">
        <h2>{t('Cash drawer')}</h2>
        <table>
          <tbody>
            <tr><td>{t('Opening float')}</td><td className="right mono">{money(report.cash.float)}</td></tr>
            <tr><td>{t('Cash takings')}</td><td className="right mono">{money(report.cash.in)}</td></tr>
            {report.cash.payIn !== '0.00' && <tr><td>{t('Paid in')}</td><td className="right mono">{money(report.cash.payIn)}</td></tr>}
            {report.cash.payOut !== '0.00' && <tr><td>{t('Paid out')}</td><td className="right mono">-{money(report.cash.payOut)}</td></tr>}
            <tr className="total-row"><td><strong>{t('Expected in drawer')}</strong></td><td className="right mono"><strong>{money(report.cash.expected)}</strong></td></tr>
            {report.cash.counted !== null && <tr><td>{t('Counted')}</td><td className="right mono">{money(report.cash.counted)}</td></tr>}
            {report.cash.counted !== null && <tr><td>{t('Difference')}</td><td className="right strong"><DifferenceText difference={report.cash.difference} /></td></tr>}
          </tbody>
        </table>
        {report.movements.length > 0 && (
          <>
            <h3>{t('Cash in and out')}</h3>
            <ul className="plain small">
              {report.movements.map((m) => <li key={m.id}>{time(m.at)} · {m.reason}{m.by && ` · ${m.by}`} · <span className={`mono ${m.kind === 'pay_out' ? 'late' : 'gain-text'}`}>{m.kind === 'pay_out' ? '-' : '+'}{money(m.amount)}</span></li>)}
            </ul>
          </>
        )}
        {shift.note && <p className="small">{t('Note')}: {shift.note}</p>}
      </section>
    </div>
  );
}

// ---------- the pages ----------

export function Shifts() {
  const t = useT();
  usePageTitle(t('Cash register'));
  const { can } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState<{ shift: Shift | null; report: ShiftReport | null } | null>(null);
  const [history, setHistory] = useState<Shift[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<{ shift: Shift | null; report: ShiftReport | null }>('/v1/shifts/current').then(setCurrent).catch(setError);
    api<{ data: Shift[] }>('/v1/shifts').then((r) => setHistory(r.data)).catch(setError);
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Sell')}</span><h1>{t('Cash register')}</h1></div>
        <span className="spacer" />
        <Link className="button secondary" to="/counter" viewTransition>{t('Counter')}</Link>
      </div>
      <ShiftBar key={current?.shift?.id ?? 'none'} />
      <ErrorText error={error} />
      {current?.shift && current.report && (
        <>
          <h2>{t('This shift so far')}</h2>
          <ReportView report={current.report} shift={current.shift} />
        </>
      )}
      <section className="card">
        <h2>{t('Shifts')}</h2>
        {!history ? <div className="skeleton" style={{ height: '8rem' }} /> : history.length === 0 ? <div className="empty">{t('No shifts yet. Open one at the counter when the day starts.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">#</th><th scope="col">{t('Register')}</th><th scope="col">{t('Opened')}</th><th scope="col">{t('Closed')}</th><th scope="col" className="right">{t('Expected')}</th><th scope="col" className="right">{t('Counted')}</th><th scope="col">{t('Difference')}</th></tr></thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/shifts/${s.id}`, { viewTransition: true })}>
                    <td data-label="#"><Link to={`/shifts/${s.id}`} onClick={(e) => e.stopPropagation()} className="mono">{s.number}</Link></td>
                    <td data-label={t('Register')}>{s.register.name} <span className="small muted">· {s.openedBy.name}</span></td>
                    <td data-label={t('Opened')} className="small">{new Date(s.openedAt).toLocaleString()}</td>
                    <td data-label={t('Closed')} className="small">{s.closedAt ? new Date(s.closedAt).toLocaleString() : <span className="badge authorized">{t('Still open')}</span>}</td>
                    <td data-label={t('Expected')} className="right mono">{s.expectedCash ? money(s.expectedCash) : '—'}</td>
                    <td data-label={t('Counted')} className="right mono">{s.countedCash ? money(s.countedCash) : '—'}</td>
                    <td data-label={t('Difference')}><DifferenceText difference={s.difference} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {can('business.manage') && <Registers />}
    </div>
  );
}

function Registers() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<Register[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: Register[] }>('/v1/registers').then((r) => setRows(r.data)).catch(setError), []);
  useEffect(() => void load(), [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/registers', { method: 'POST', body: { name: name.trim() } });
      setName('');
      toast(t('Register added'));
      void load();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card stack">
      <div>
        <h2>{t('Registers')}</h2>
        <p className="small muted">{t('One for each cash drawer (front counter, bar, second till). Each has one shift open at a time.')}</p>
      </div>
      {rows && rows.length > 0 && (
        <ul className="plain">
          {rows.map((r) => (
            <li key={r.id} className="row">
              <strong>{r.name}</strong>
              <span className="small muted">{r.openBy ? t('open by {name}', { name: r.openBy }) : t('closed')}</span>
              <span className="spacer" />
              {!r.openBy && <button type="button" className="link danger-link small" onClick={() => void api(`/v1/registers/${r.id}`, { method: 'DELETE' }).then(load).catch(setError)}>{t('Archive')}</button>}
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={(e) => void add(e)}>
        <Field label={t('New register')} className="grow"><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Bar')} /></Field>
        <button className="secondary">{t('Add')}</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

export function ShiftDetail() {
  const t = useT();
  const { id } = useParams();
  const [data, setData] = useState<{ shift: Shift; report: ShiftReport } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<{ shift: Shift; report: ShiftReport }>(`/v1/shifts/${id}`).then(setData).catch(setError), [id]);
  usePageTitle(data ? t('Shift #{n}', { n: data.shift.number }) : t('Shift'));
  if (error && !data) return <div className="stack"><ErrorText error={error} /></div>;
  if (!data) return <div className="stack"><div className="skeleton" style={{ height: '16rem' }} /></div>;
  const s = data.shift;
  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/shifts" viewTransition>{t('Cash register')}</Link></span>
          <h1>{t('Shift #{n}', { n: s.number })} <span className="small muted">· {s.register.name}</span></h1>
          <p className="small muted">{s.openedBy.name} · {new Date(s.openedAt).toLocaleString()}{s.closedAt && ` → ${new Date(s.closedAt).toLocaleString()}${s.closedBy && s.closedBy !== s.openedBy.name ? ` (${t('closed by {name}', { name: s.closedBy })})` : ''}`}</p>
        </div>
        <span className="spacer" />
        <button className="secondary" onClick={() => printPdf(link(`/v1/shifts/${s.id}/report.pdf?format=receipt`))}>{t('Print on the receipt printer')}</button>
        <a className="button secondary" href={link(`/v1/shifts/${s.id}/report.pdf?format=sheet`)} target="_blank" rel="noreferrer">PDF</a>
      </div>
      {s.status === 'open' && <div className="banner info"><div>{t('This shift is still open: the figures are so far (an X report).')}</div></div>}
      {s.status === 'closed' && data.report.cash.difference !== null && (
        <section className={`card shift-result ${toCents(data.report.cash.difference) === 0n ? 'ok' : 'off'}`}>
          <div><span className="kicker">{t('Drawer count')}</span><div className="stock-big"><DifferenceText difference={data.report.cash.difference} /></div></div>
          <span className="spacer" />
          <div className="small">{t('Expected {e}, counted {c}', { e: money(data.report.cash.expected), c: money(data.report.cash.counted ?? '0') })}</div>
        </section>
      )}
      <ReportView report={data.report} shift={s} />
    </div>
  );
}
