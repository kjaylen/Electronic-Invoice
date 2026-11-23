/** Money out: expenses and bills (with receipts), bills to pay, suppliers. */

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, link } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeDate, belizeToday, Combobox, ErrorText, Field, fromCents, Modal, money, PAYMENT_METHOD_TEXT, Segmented, Select, toCents, useDebounced, usePageTitle } from '../ui';

type Treatment = 'standard' | 'zero' | 'exempt' | 'none';
type Method = 'cash' | 'cheque' | 'bank_transfer' | 'card' | 'online' | 'other';
const METHODS: Method[] = ['bank_transfer', 'cash', 'cheque', 'card', 'online', 'other'];

interface Expense {
  id: string;
  supplier: { id: string | null; name: string; tin: string | null };
  reference: string | null;
  date: string;
  dueDate: string | null;
  category: string;
  description: string | null;
  gstTreatment: Treatment;
  net: string;
  gst: string;
  total: string;
  claimableGst: string;
  claimGst: boolean;
  paid: { on: string; method: Method } | null;
  overdue: boolean;
  receipt: { contentType: string; bytes: number } | null;
  recordedBy: string | null;
}

interface Totals { count: number; net: string; gst: string; total: string; claimableGst: string; unpaid: string; overdue: string }

interface Supplier { id: string; name: string; tin: string | null; email: string | null; telephone: string | null; address: string | null; notes: string | null; spent?: string; unpaid?: string }

const TREATMENT: Record<Treatment, string> = { standard: 'Standard rate, GST included', zero: 'Zero-rated', exempt: 'Exempt', none: 'No GST (supplier not registered)' };

const monthRange = (offset: number): [string, string] => {
  const now = new Date(Date.now() - 6 * 3600_000);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  const end = offset === 0 ? now : last;
  return [first.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
};

// ---------- the page ----------

export function Expenses() {
  const t = useT();
  usePageTitle(t('Expenses'));
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'expenses' | 'bills' | 'suppliers' | null) ?? 'expenses';
  const [summary, setSummary] = useState<{ month: Totals; bills: Totals } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const [from, to] = monthRange(0);
    void Promise.all([
      api<{ totals: Totals }>(`/v1/expenses?from=${from}&to=${to}`),
      api<{ totals: Totals }>('/v1/expenses?status=unpaid'),
    ]).then(([m, b]) => setSummary({ month: m.totals, bills: b.totals })).catch(() => {});
  }, [version]);
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Money out')}</span><h1>{t('Expenses')}</h1></div>
        <span className="spacer" />
        {can('expenses.manage') && <Link className="button" to="/expenses/new" viewTransition>{t('Add expense')}<span className="chip" aria-hidden="true">+</span></Link>}
      </div>
      <div className="kpis">
        <div className="card kpi">
          <span className="kpi-head">{t('Spent this month')}</span>
          <span className="kpi-value">{summary ? money(summary.month.total) : '—'}</span>
          <span className="kpi-note">{summary ? t('{n} expenses, GST included', { n: summary.month.count }) : ' '}</span>
        </div>
        <div className="card kpi good">
          <span className="kpi-head">{t('GST to claim this month')}</span>
          <span className="kpi-value">{summary ? money(summary.month.claimableGst) : '—'}</span>
          <span className="kpi-note">{t('Paid on purchases with a tax invoice')}</span>
        </div>
        <div className={`card kpi ${summary && toCents(summary.bills.overdue) > 0n ? 'alert' : ''}`}>
          <span className="kpi-head">{t('Bills to pay')}</span>
          <span className="kpi-value">{summary ? money(summary.bills.unpaid) : '—'}</span>
          <span className="kpi-note">{summary ? (toCents(summary.bills.overdue) > 0n ? t('{amount} overdue', { amount: money(summary.bills.overdue) }) : t('Nothing overdue')) : ' '}</span>
        </div>
        <Link className="card kpi" to="/reports?view=gst" viewTransition>
          <span className="kpi-head">{t('GST return')}</span>
          <span className="kpi-value small-value">{t('See this month')} →</span>
          <span className="kpi-note">{t('GST on sales less GST you can claim')}</span>
        </Link>
      </div>
      <Segmented switches label={t('View')} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={[['expenses', t('Expenses')], ['bills', t('Bills to pay')], ['suppliers', t('Suppliers')]]} />
      {tab === 'expenses' && <ExpenseList key={version} />}
      {tab === 'bills' && <BillsToPay onChange={changed} />}
      {tab === 'suppliers' && <Suppliers />}
    </div>
  );
}

function ExpenseTable({ rows, onPay }: { rows: Expense[]; onPay?: (e: Expense) => void }) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('Supplier')}</th><th scope="col">{t('Category')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col" className="right">{t('GST to claim')}</th><th scope="col">{onPay ? t('Due') : t('Paid')}</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => navigate(`/expenses/${e.id}`, { viewTransition: true })}>
              <td data-label={t('Date')}>{e.date}</td>
              <td data-label={t('Supplier')}>
                <Link to={`/expenses/${e.id}`} viewTransition onClick={(ev) => ev.stopPropagation()}>{e.supplier.name}</Link>
                {e.reference && <span className="small muted"> · {e.reference}</span>}
                {e.receipt && <span className="receipt-mark" title={t('Receipt attached')} aria-label={t('Receipt attached')}>📎</span>}
              </td>
              <td data-label={t('Category')}>{t(e.category)}</td>
              <td data-label={t('Total')} className="right">{money(e.total)}</td>
              <td data-label={t('GST to claim')} className="right">{toCents(e.claimableGst) > 0n ? money(e.claimableGst) : '—'}</td>
              <td data-label={onPay ? t('Due') : t('Paid')}>
                {onPay ? (
                  <span className="row nowrap">
                    <span className={e.overdue ? 'late' : ''}>{e.dueDate ?? '—'}</span>
                    <button type="button" className="secondary small-button" onClick={(ev) => { ev.stopPropagation(); onPay(e); }}>{t('Mark paid')}</button>
                  </span>
                ) : e.paid ? <span className="small">{e.paid.on} · {t(PAYMENT_METHOD_TEXT[e.paid.method])}</span> : <span className={`badge ${e.overdue ? 'pay-overdue' : 'pay-unpaid'}`}>{e.overdue ? t('Overdue') : t('Unpaid')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpenseList() {
  const t = useT();
  const [preset, setPreset] = useState<'month' | 'last-month' | 'custom'>('month');
  const [range, setRange] = useState<[string, string]>(() => monthRange(0));
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const [data, setData] = useState<{ data: Expense[]; totals: Totals } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [from, to] = range;
  const qs = `from=${from}&to=${to}${category ? `&category=${encodeURIComponent(category)}` : ''}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`;
  useEffect(() => void api<{ data: string[] }>('/v1/expense-categories').then((r) => setCategories(r.data)).catch(() => {}), []);
  useEffect(() => {
    if (!from || !to || from > to) return;
    setData(null);
    api<{ data: Expense[]; totals: Totals }>(`/v1/expenses?${qs}`).then(setData).catch(setError);
  }, [qs, from, to]);
  return (
    <section className="card stack">
      <div className="row filters">
        <Segmented switches label={t('Period')} value={preset} onChange={(p) => { setPreset(p); if (p !== 'custom') setRange(monthRange(p === 'month' ? 0 : -1)); }} options={[['month', t('This month')], ['last-month', t('Last month')], ['custom', t('Custom')]]} />
        {preset === 'custom' && (
          <>
            <Field label={t('From')}><input type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></Field>
            <Field label={t('To')}><input type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></Field>
          </>
        )}
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('Category')}>
          <option value="">{t('All categories')}</option>
          {categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}
        </Select>
        <input type="search" className="search-input" placeholder={t('Supplier, reference or note')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search expenses')} />
        <span className="spacer" />
        <a className="button secondary" href={link(`/v1/expenses.csv?${qs}`)} download>CSV</a>
      </div>
      <ErrorText error={error} />
      {!data ? <div className="skeleton" style={{ height: '10rem' }} /> : data.data.length === 0 ? (
        <div className="empty">{t('No expenses in this period. Add what you pay suppliers, with a photo of the receipt, to see your profit and the GST you can claim back.')}</div>
      ) : (
        <>
          <ExpenseTable rows={data.data} />
          <p className="small muted right">{t('{n} expenses · total {total} · GST to claim {gst}', { n: data.totals.count, total: money(data.totals.total), gst: money(data.totals.claimableGst) })}</p>
        </>
      )}
    </section>
  );
}

function BillsToPay({ onChange }: { onChange: () => void }) {
  const t = useT();
  const [data, setData] = useState<{ data: Expense[]; totals: Totals } | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: Expense[]; totals: Totals }>('/v1/expenses?status=unpaid').then(setData).catch(setError), []);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack">
      <ErrorText error={error} />
      {!data ? <div className="skeleton" style={{ height: '8rem' }} /> : data.data.length === 0 ? <div className="empty">{t('No bills waiting to be paid.')}</div> : (
        <>
          <ExpenseTable rows={data.data} onPay={setPaying} />
          <p className="small muted right">{t('{total} to pay, {overdue} of it overdue', { total: money(data.totals.unpaid), overdue: money(data.totals.overdue) })}</p>
        </>
      )}
      {paying && <PayBillModal expense={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); void load(); onChange(); }} />}
    </section>
  );
}

function PayBillModal({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [paidOn, setPaidOn] = useState(belizeToday());
  const [method, setMethod] = useState<Method>('bank_transfer');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/expenses/${expense.id}/pay`, { method: 'POST', body: { paidOn, method } });
      toast(t('Marked paid'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Pay {supplier}: {amount}', { supplier: expense.supplier.name, amount: money(expense.total) })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="form-grid">
          <Field label={t('Paid on')}><input type="date" required value={paidOn} min={expense.date} max={belizeToday()} onChange={(e) => setPaidOn(e.target.value)} autoFocus /></Field>
          <Field label={t('Method')}><Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>{METHODS.map((m) => <option key={m} value={m}>{t(PAYMENT_METHOD_TEXT[m])}</option>)}</Select></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy}>{t('Mark paid')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- suppliers ----------

function Suppliers() {
  const t = useT();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: Supplier[] }>(`/v1/suppliers${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`).then((r) => setRows(r.data)).catch(setError), [search]);
  useEffect(() => void load(), [load]);
  return (
    <section className="card stack">
      <div className="row">
        <input type="search" className="search-input" placeholder={t('Name or TIN')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search suppliers')} />
        <span className="spacer" />
        {can('expenses.manage') && <button className="secondary" onClick={() => setEditing('new')}>{t('Add supplier')}</button>}
      </div>
      <ErrorText error={error} />
      {!rows ? <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? <div className="empty">{t('No suppliers yet. Save the ones you buy from often, with their TIN, to claim the GST on their invoices.')}</div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Supplier')}</th><th scope="col">TIN</th><th scope="col">{t('Contact')}</th><th scope="col" className="right">{t('Spent')}</th><th scope="col" className="right">{t('To pay')}</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={can('expenses.manage') ? 'clickable' : ''} onClick={() => can('expenses.manage') && setEditing(s)}>
                  <td data-label={t('Supplier')}><strong>{s.name}</strong></td>
                  <td data-label="TIN">{s.tin ?? <span className="muted small">{t('none')}</span>}</td>
                  <td data-label={t('Contact')} className="small">{[s.telephone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td data-label={t('Spent')} className="right">{money(s.spent ?? '0')}</td>
                  <td data-label={t('To pay')} className="right">{s.unpaid && toCents(s.unpaid) > 0n ? money(s.unpaid) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <SupplierModal supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void load(); }} />}
    </section>
  );
}

function SupplierModal({ supplier, onClose, onDone, initialName }: { supplier: Supplier | null; onClose: () => void; onDone: (s: Supplier) => void; initialName?: string }) {
  const t = useT();
  const [f, setF] = useState({ name: supplier?.name ?? initialName ?? '', tin: supplier?.tin ?? '', email: supplier?.email ?? '', telephone: supplier?.telephone ?? '', address: supplier?.address ?? '', notes: supplier?.notes ?? '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name: f.name.trim(), tin: f.tin.trim() || null, email: f.email.trim() || null, telephone: f.telephone.trim() || null, address: f.address.trim() || null, notes: f.notes.trim() || null };
      const s = await api<Supplier>(supplier ? `/v1/suppliers/${supplier.id}` : '/v1/suppliers', { method: supplier ? 'PUT' : 'POST', body });
      onDone(s);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!supplier) return;
    await api(`/v1/suppliers/${supplier.id}`, { method: 'DELETE' }).then(() => onDone(supplier)).catch(setError);
  };
  return (
    <Modal title={supplier ? t('Edit supplier') : t('Add supplier')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="form-grid">
          <Field label={t('Name')}><input required maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="TIN" hint={t('From their tax invoices; needed to claim the GST.')}><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={f.tin} onChange={(e) => setF({ ...f, tin: e.target.value })} /></Field>
          <Field label={t('Telephone')}><input type="tel" value={f.telephone} onChange={(e) => setF({ ...f, telephone: e.target.value })} /></Field>
          <Field label={t('Email')}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <Field label={t('Address')}><input maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label={t('Notes')}><textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorText error={error} />
        <div className="row">
          {supplier && <button type="button" className="link danger-link" onClick={() => void archive()}>{t('Archive')}</button>}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button disabled={busy}>{t('Save')}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- one expense: add, change, the receipt ----------

export function ExpenseEditor() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const { can } = useSession();
  const editing = Boolean(id && id !== 'new');
  usePageTitle(editing ? t('Expense') : t('Add expense'));
  const [loaded, setLoaded] = useState<Expense | null>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [supplierTin, setSupplierTin] = useState('');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(belizeToday());
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [treatment, setTreatment] = useState<Treatment>('standard');
  const [total, setTotal] = useState('');
  const [gstOverride, setGstOverride] = useState('');
  const [claim, setClaim] = useState(true);
  const [isPaid, setIsPaid] = useState(true);
  const [paidOn, setPaidOn] = useState(belizeToday());
  const [method, setMethod] = useState<Method>('cash');
  const [dueDate, setDueDate] = useState(belizeDate(30));
  const [file, setFile] = useState<File | null>(null);
  const [newSupplier, setNewSupplier] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readOnly = !can('expenses.manage');

  useEffect(() => void api<{ data: string[] }>('/v1/expense-categories').then((r) => {
    setCategories(r.data);
    setCategory((c) => c || r.data[0] || 'Other');
  }).catch(() => {}), []);
  useEffect(() => {
    if (!editing) return;
    void api<Expense>(`/v1/expenses/${id}`).then((e) => {
      setLoaded(e);
      if (e.supplier.id) setSupplier({ id: e.supplier.id, name: e.supplier.name, tin: e.supplier.tin, email: null, telephone: null, address: null, notes: null });
      setSupplierName(e.supplier.name);
      setSupplierTin(e.supplier.tin ?? '');
      setReference(e.reference ?? '');
      setDate(e.date);
      setCategory(e.category);
      setDescription(e.description ?? '');
      setTreatment(e.gstTreatment);
      setTotal(e.total);
      setGstOverride(e.gstTreatment === 'standard' ? e.gst : '');
      setClaim(e.claimGst);
      setIsPaid(Boolean(e.paid));
      if (e.paid) {
        setPaidOn(e.paid.on);
        setMethod(e.paid.method);
      }
      if (e.dueDate) setDueDate(e.dueDate);
    }).catch(setError);
  }, [editing, id]);

  // The GST inside the total at 12.5%, shown as the user types (the receipt's own figure can replace it).
  const totalCents = /^\d{1,13}(\.\d{1,2})?$/.test(total) ? toCents(total) : null;
  const autoGst = totalCents !== null && treatment === 'standard' ? (totalCents * 125n * 2n + 1125n) / 2250n : 0n;
  const gst = treatment === 'standard' ? (/^\d{1,13}(\.\d{1,2})?$/.test(gstOverride) ? toCents(gstOverride) : autoGst) : 0n;
  const tin = supplier?.tin ?? (supplierTin.trim() || null);
  const claimable = treatment === 'standard' && claim && Boolean(tin);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(supplier ? { supplierId: supplier.id } : { supplierName: supplierName.trim() }),
        ...(!supplier && supplierTin.trim() && { supplierTin: supplierTin.trim() }),
        ...(reference.trim() && { reference: reference.trim() }),
        date, category, ...(description.trim() && { description: description.trim() }),
        gstTreatment: treatment, total: total.trim(),
        ...(treatment === 'standard' && gstOverride.trim() && { gst: gstOverride.trim() }),
        claimGst: claim,
        ...(isPaid ? { paid: { on: paidOn, method } } : { paid: null, dueDate }),
      };
      const saved = await api<Expense>(editing ? `/v1/expenses/${id}` : '/v1/expenses', { method: editing ? 'PUT' : 'POST', body });
      if (file) {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        await api(`/v1/expenses/${saved.id}/receipt`, { method: 'POST', body: { dataBase64 } });
      }
      toast(editing ? t('Saved') : t('Expense added'));
      navigate('/expenses', { viewTransition: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api(`/v1/expenses/${id}`, { method: 'DELETE' });
      toast(t('Expense deleted'));
      navigate('/expenses', { viewTransition: true });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <div><span className="kicker"><Link to="/expenses" viewTransition>{t('Expenses')}</Link></span><h1>{editing ? `${loaded?.supplier.name ?? t('Expense')}` : t('Add expense')}</h1></div>
        <span className="spacer" />
        {editing && !readOnly && <button type="button" className="link danger-link" onClick={() => void remove()}>{t('Delete')}</button>}
      </div>
      <div className="doc-layout">
        <div className="stack">
          <fieldset className="stack" disabled={readOnly}>
            <legend>{t('Paid to')}</legend>
            <Combobox<Supplier>
              label={t('Supplier')}
              placeholder={t('Search your suppliers, or type a name')}
              search={(q) => api<{ data: Supplier[] }>(`/v1/suppliers?q=${encodeURIComponent(q)}`).then((r) => r.data)}
              render={(s) => <><strong>{s.name}</strong>{s.tin && <span className="muted"> · TIN {s.tin}</span>}</>}
              value={supplier?.name ?? supplierName}
              onText={(v) => { setSupplier(null); setSupplierName(v); }}
              onPick={(s) => { setSupplier(s); setSupplierName(s.name); }}
            />
            <div className="form-grid">
              {!supplier && <Field label={t('Supplier TIN')} hint={t('On their tax invoice. Needed to claim the GST.')}><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={supplierTin} onChange={(e) => setSupplierTin(e.target.value)} /></Field>}
              <Field label={t('Their invoice or receipt number')}><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
              <Field label={t('Date')}><input type="date" required max={belizeToday()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            </div>
            {!supplier && supplierName.trim().length > 1 && !readOnly && <button type="button" className="link small" onClick={() => setNewSupplier(supplierName.trim())}>{t('Save “{name}” to my suppliers', { name: supplierName.trim() })}</button>}
          </fieldset>
          <fieldset className="stack" disabled={readOnly}>
            <legend>{t('What for')}</legend>
            <div className="form-grid">
              <Field label={t('Category')}>
                <input list="expense-categories" required maxLength={60} value={category} onChange={(e) => setCategory(e.target.value)} />
                <datalist id="expense-categories">{categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}</datalist>
              </Field>
              <Field label={t('Note')} hint={t('Optional.')}><input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            </div>
          </fieldset>
          <fieldset className="stack" disabled={readOnly}>
            <legend>{t('Amount')}</legend>
            <div className="form-grid">
              <Field label={t('Total paid (BZ$)')}><input inputMode="decimal" required placeholder="0.00" value={total} onChange={(e) => setTotal(e.target.value.trim())} /></Field>
              <Field label="GST">
                <Select value={treatment} onChange={(e) => setTreatment(e.target.value as Treatment)}>
                  {(Object.keys(TREATMENT) as Treatment[]).map((k) => <option key={k} value={k}>{t(TREATMENT[k])}</option>)}
                </Select>
              </Field>
              {treatment === 'standard' && <Field label={t('GST on the receipt (BZ$)')} hint={t('Worked out at 12.5%: {amount}. Change it if the receipt shows another figure.', { amount: money(fromCents(autoGst)) })}><input inputMode="decimal" placeholder={fromCents(autoGst)} value={gstOverride} onChange={(e) => setGstOverride(e.target.value.trim())} /></Field>}
            </div>
            {treatment === 'standard' && (
              <label className="row small"><input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} /> {t('Claim this GST on my GST return (I have their tax invoice)')}</label>
            )}
            {treatment === 'standard' && claim && !tin && <p className="small late">{t('Add the supplier’s TIN to claim the GST; without it, the GST counts as a cost.')}</p>}
          </fieldset>
          <fieldset className="stack" disabled={readOnly}>
            <legend>{t('Payment')}</legend>
            <Segmented label={t('Payment')} value={isPaid ? 'paid' : 'bill'} onChange={(v) => setIsPaid(v === 'paid')} options={[['paid', t('Paid')], ['bill', t('A bill to pay later')]]} />
            <div className="form-grid">
              {isPaid ? (
                <>
                  <Field label={t('Paid on')}><input type="date" required min={date} max={belizeToday()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
                  <Field label={t('Method')}><Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>{METHODS.map((m) => <option key={m} value={m}>{t(PAYMENT_METHOD_TEXT[m])}</option>)}</Select></Field>
                </>
              ) : (
                <Field label={t('Due on')}><input type="date" required min={date} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
              )}
            </div>
          </fieldset>
        </div>
        <aside className="doc-aside">
          <section className="card totals ticket stack">
            <span className="kicker" style={{ color: 'var(--lime)' }}>{t('Expense')} · BZD</span>
            <div><span>{t('Net')}</span><span>{money(fromCents(totalCents !== null ? totalCents - gst : 0n))}</span></div>
            <div><span>GST</span><span>{money(fromCents(gst))}</span></div>
            <div className="grand"><span>{t('Total')}</span><span>{money(fromCents(totalCents ?? 0n))}</span></div>
            <span className="small" style={{ color: claimable ? 'var(--lime)' : 'rgba(251,248,241,0.7)' }}>{claimable ? t('{amount} goes on your GST return', { amount: money(fromCents(gst)) }) : t('No GST to claim')}</span>
            <ErrorText error={error} />
            {!readOnly && <button type="submit" className="big lime" disabled={busy || totalCents === null || !(supplier || supplierName.trim())}>{busy ? t('Saving…') : editing ? t('Save') : t('Add expense')}<span className="chip" aria-hidden="true">→</span></button>}
          </section>
          <section className="card stack receipt-box">
            <h2>{t('Receipt')}</h2>
            {loaded?.receipt && !file && (
              loaded.receipt.contentType === 'application/pdf'
                ? <a className="button secondary" href={link(`/v1/expenses/${loaded.id}/receipt`)} target="_blank" rel="noreferrer">{t('Open the PDF')}</a>
                : <a href={link(`/v1/expenses/${loaded.id}/receipt`)} target="_blank" rel="noreferrer"><img className="receipt-preview" src={link(`/v1/expenses/${loaded.id}/receipt`)} alt={t('Receipt')} /></a>
            )}
            {file && <p className="small">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
            {!readOnly && (
              <>
                <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" hidden onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 5 * 1024 * 1024) { setError(new Error(t('Receipts can be up to 5 MB'))); return; }
                  setFile(f);
                }} />
                <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>{loaded?.receipt || file ? t('Replace the receipt') : t('Take a photo or choose a file')}</button>
                <p className="small muted">{t('A photo or PDF of the receipt (up to 5 MB). Keep tax invoices for the GST you claim.')}</p>
              </>
            )}
          </section>
        </aside>
      </div>
      {newSupplier && (
        <SupplierModal supplier={null} initialName={newSupplier} onClose={() => setNewSupplier(null)} onDone={(s) => { setNewSupplier(null); setSupplier(s); setSupplierName(s.name); }} />
      )}
    </form>
  );
}
