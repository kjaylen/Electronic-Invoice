/**
 * Repeating expenses (Expenses → Repeating): rent, internet, a phone plan… recorded on their own on
 * schedule, as a bill to pay or as already paid.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeToday, Combobox, ErrorText, Field, Modal, money, PAYMENT_METHOD_TEXT, Select } from '../ui';

type Treatment = 'standard' | 'zero' | 'exempt' | 'none';
type Method = 'cash' | 'cheque' | 'bank_transfer' | 'card' | 'online' | 'other';
type Frequency = 'weekly' | 'monthly' | 'yearly';
interface Repeating {
  id: string;
  supplier: { id: string | null; name: string; tin: string | null };
  category: string;
  description: string | null;
  gstTreatment: Treatment;
  total: string;
  frequency: Frequency;
  nextDate: string;
  endDate: string | null;
  dueDays: number;
  paidBy: Method | null;
  active: boolean;
  lastRun: string | null;
  finished: boolean;
}
interface SupplierLite { id: string; name: string; tin: string | null }

const FREQUENCY: Record<Frequency, string> = { weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };

export function RecurringExpenses({ onChange }: { onChange: () => void }) {
  const t = useT();
  const { can } = useSession();
  const [data, setData] = useState<{ data: Repeating[]; monthly: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Repeating | 'new' | null>(null);
  const load = useCallback(() => api<{ data: Repeating[]; monthly: string }>('/v1/recurring-expenses').then(setData).catch(setError), []);
  useEffect(() => void load(), [load]);
  const manage = can('expenses.manage');
  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Repeating expenses')}</h2>
          <p className="small muted">{t('Rent, internet, a phone plan: recorded on their own on the day, as a bill to pay or as paid.')}</p>
        </div>
        <span className="spacer" />
        {manage && <button type="button" onClick={() => setEditing('new')}>{t('Add a repeating expense')}</button>}
      </div>
      <ErrorText error={error} />
      {!data ? <div className="skeleton" style={{ height: '6rem' }} /> : data.data.length === 0 ? <div className="empty">{t('Nothing repeats yet.')}</div> : (
        <>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Supplier')}</th><th scope="col">{t('Category')}</th><th scope="col">{t('How often')}</th><th scope="col">{t('Next')}</th><th scope="col" className="right">{t('Amount')}</th><th scope="col">{t('Paid')}</th></tr></thead>
              <tbody>
                {data.data.map((r) => (
                  <tr key={r.id} className={manage ? 'clickable' : ''} onClick={() => manage && setEditing(r)}>
                    <td data-label={t('Supplier')}><strong>{r.supplier.name}</strong>{r.description && <div className="small muted">{r.description}</div>}</td>
                    <td data-label={t('Category')}>{t(r.category)}</td>
                    <td data-label={t('How often')}>{t(FREQUENCY[r.frequency])}</td>
                    <td data-label={t('Next')}>{!r.active ? <span className="muted">{t('Paused')}</span> : r.finished ? <span className="muted">{t('Finished')}</span> : r.nextDate}</td>
                    <td data-label={t('Amount')} className="right">{money(r.total)}</td>
                    <td data-label={t('Paid')} className="small">{r.paidBy ? t(PAYMENT_METHOD_TEXT[r.paidBy]) : r.dueDays ? t('A bill, due in {n} days', { n: r.dueDays }) : t('A bill, due on the day')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{t('About {amount} a month.', { amount: money(data.monthly) })}</p>
        </>
      )}
      {editing && <RepeatingModal initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void load(); onChange(); }} />}
    </section>
  );
}

function RepeatingModal({ initial, onClose, onDone }: { initial: Repeating | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [supplier, setSupplier] = useState<SupplierLite | null>(initial?.supplier.id ? { id: initial.supplier.id, name: initial.supplier.name, tin: initial.supplier.tin } : null);
  const [supplierName, setSupplierName] = useState(initial?.supplier.name ?? '');
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState(initial?.category ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [treatment, setTreatment] = useState<Treatment>(initial?.gstTreatment ?? 'standard');
  const [total, setTotal] = useState(initial?.total ?? '');
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? 'monthly');
  const [startDate, setStartDate] = useState(initial?.nextDate ?? belizeToday());
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [paidBy, setPaidBy] = useState<Method | ''>(initial?.paidBy ?? '');
  const [dueDays, setDueDays] = useState(String(initial?.dueDays ?? 0));
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<{ data: string[] }>('/v1/expense-categories').then((r) => {
    setCategories(r.data);
    setCategory((c) => c || r.data.find((x) => x === 'Rent') || r.data[0] || 'Other');
  }).catch(() => {}), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(supplier ? { supplierId: supplier.id } : { supplierName: supplierName.trim() }),
        category, description: description.trim() || null, gstTreatment: treatment, total: total.trim(), frequency, startDate,
        endDate: endDate || null, paidBy: paidBy || null, dueDays: Math.max(0, Math.min(90, Number(dueDays) || 0)), ...(initial && { active }),
      };
      await api(initial ? `/v1/recurring-expenses/${initial.id}` : '/v1/recurring-expenses', { method: initial ? 'PUT' : 'POST', body });
      toast(initial ? t('Saved') : t('Repeating expense added'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial) return;
    setBusy(true);
    try {
      await api(`/v1/recurring-expenses/${initial.id}`, { method: 'DELETE' });
      toast(t('Repeating expense deleted'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal wide title={initial ? t('Repeating expense') : t('Add a repeating expense')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Combobox<SupplierLite>
          label={t('Supplier')}
          placeholder={t('Search your suppliers, or type a name')}
          search={(q) => api<{ data: SupplierLite[] }>(`/v1/suppliers?q=${encodeURIComponent(q)}`).then((r) => r.data)}
          render={(s) => <><strong>{s.name}</strong>{s.tin && <span className="muted"> · TIN {s.tin}</span>}</>}
          value={supplier?.name ?? supplierName}
          onText={(v) => { setSupplier(null); setSupplierName(v); }}
          onPick={(s) => { setSupplier(s); setSupplierName(s.name); }}
        />
        <div className="form-grid">
          <Field label={t('Category')}><Select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}</Select></Field>
          <Field label={t('Description')}><input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('Shop rent')} /></Field>
        </div>
        <div className="form-grid">
          <Field label={t('Amount (BZ$)')} {...(treatment === 'standard' && { hint: t('GST included.') })}><input required inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" value={total} onChange={(e) => setTotal(e.target.value)} /></Field>
          <Field label="GST">
            <Select value={treatment} onChange={(e) => setTreatment(e.target.value as Treatment)}>
              <option value="standard">{t('Standard rate, GST included')}</option>
              <option value="zero">{t('Zero-rated')}</option>
              <option value="exempt">{t('Exempt')}</option>
              <option value="none">{t('No GST (supplier not registered)')}</option>
            </Select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label={t('How often')}>
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(['monthly', 'weekly', 'yearly'] as const).map((f) => <option key={f} value={f}>{t(FREQUENCY[f])}</option>)}
            </Select>
          </Field>
          <Field label={initial ? t('Next date') : t('First date')} hint={t('A date today or earlier is recorded right away.')}><input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label={t('Until')} hint={t('Optional.')}><input type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
        </div>
        <div className="form-grid">
          <Field label={t('Payment')}>
            <Select value={paidBy || 'bill'} onChange={(e) => setPaidBy(e.target.value === 'bill' ? '' : (e.target.value as Method))}>
              <option value="bill">{t('A bill to pay')}</option>
              {(['bank_transfer', 'cash', 'cheque', 'card', 'online', 'other'] as const).map((m) => <option key={m} value={m}>{t('Paid by {method}', { method: t(PAYMENT_METHOD_TEXT[m]).toLowerCase() })}</option>)}
            </Select>
          </Field>
          {!paidBy && <Field label={t('Due after (days)')}><input inputMode="numeric" pattern="\d{1,2}" value={dueDays} onChange={(e) => setDueDays(e.target.value)} /></Field>}
        </div>
        {initial && <label className="row small"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('Running (untick to pause it)')}</label>}
        <ErrorText error={error} />
        <div className="row">
          {initial && <button type="button" className="link danger-link" disabled={busy} onClick={() => void remove()}>{t('Delete')}</button>}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || !total.trim() || (!supplier && !supplierName.trim())}>{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </form>
    </Modal>
  );
}
