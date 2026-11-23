/** Time and jobs: work done for customers, logged as it happens and invoiced in one go (for businesses that sell services). */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type Customer, type Item, type Page } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { store } from '../storage';
import { useToast } from '../toast';
import { belizeToday, Combobox, ErrorText, Field, Modal, money, Segmented, Select, unitName, usePageTitle } from '../ui';

export interface WorkEntry {
  id: string;
  customer: { id: string; name: string };
  item: { id: string; name: string } | null;
  date: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode: string | null;
  amount: string;
  by: string | null;
  invoice: { documentId: string; number: string | null; at: string | null } | null;
}
export interface ToInvoice { customer: { id: string; name: string; email: string | null }; entries: number; hours: string; amount: string; oldest: string }
interface WorkList { data: WorkEntry[]; toInvoice: ToInvoice[] }

/** How work is counted. */
const WORK_UNITS = ['HUR', 'E48', 'DAY', 'WEE', 'MON'];
const TIMER_KEY = 'etd.work.timer';

const cents = (v: string) => Math.round(Number(v) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

export function Work() {
  const t = useT();
  const { can } = useSession();
  usePageTitle(t('Time and jobs'));
  const [params, setParams] = useSearchParams();
  const status = (['unbilled', 'billed', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'unbilled') as 'unbilled' | 'billed' | 'all';
  const [data, setData] = useState<WorkList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<WorkEntry | null>(null);
  const [invoicing, setInvoicing] = useState<ToInvoice | null>(null);
  const toast = useToast();
  const canLog = can('documents.issue');
  const load = useCallback(() => api<WorkList>(`/v1/work?status=${status}`).then(setData).catch(setError), [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = (w: WorkEntry) => void api(`/v1/work/${w.id}`, { method: 'DELETE' }).then(() => { toast(t('Removed')); void load(); }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad'));

  return (
    <div className="stack">
      <div>
        <span className="kicker">{t('Sell')}</span>
        <h1>{t('Time and jobs')}</h1>
        <p className="muted">{t('Log the work you do for each customer as you go, by the hour or by the job, then invoice it in one go.')}</p>
      </div>

      {canLog && (
        <WorkForm
          key={editing?.id ?? 'new'}
          entry={editing}
          presetCustomer={params.get('customer')}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}

      <section className="card stack">
        <h2>{t('To invoice')}</h2>
        {!data ? <div className="skeleton" style={{ height: '5rem' }} /> : data.toInvoice.length === 0 ? <p className="muted">{t('Nothing waiting to be invoiced.')}</p> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Customer')}</th><th scope="col" className="num">{t('Entries')}</th><th scope="col" className="num">{t('Hours')}</th><th scope="col" className="num">{t('Before GST')}</th><th scope="col">{t('Since')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {data.toInvoice.map((r) => (
                  <tr key={r.customer.id}>
                    <td data-label={t('Customer')}><Link to={`/customers/${r.customer.id}`}><strong>{r.customer.name}</strong></Link></td>
                    <td data-label={t('Entries')} className="num">{r.entries}</td>
                    <td data-label={t('Hours')} className="num">{r.hours === '0' ? '—' : r.hours}</td>
                    <td data-label={t('Before GST')} className="num"><strong>{money(r.amount)}</strong></td>
                    <td data-label={t('Since')} className="small">{r.oldest}</td>
                    <td className="right">{canLog && <button className="small-button" onClick={() => setInvoicing(r)}>{t('Invoice')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="row">
          <h2>{t('Work')}</h2>
          <span className="spacer" />
          <Segmented label={t('Show')} value={status} onChange={(v) => setParams(v === 'unbilled' ? {} : { status: v }, { replace: true })} options={[['unbilled', t('To invoice')], ['billed', t('Invoiced')], ['all', t('All')]]} />
        </div>
        <ErrorText error={error} />
        {!data ? <div className="skeleton" style={{ height: '8rem' }} /> : data.data.length === 0 ? <p className="muted">{status === 'billed' ? t('Nothing invoiced yet.') : t('No work logged yet.')}</p> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('Customer')}</th><th scope="col">{t('Work')}</th><th scope="col" className="num">{t('Quantity')}</th><th scope="col" className="num">{t('Rate')}</th><th scope="col" className="num">{t('Before GST')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {data.data.map((w) => (
                  <tr key={w.id}>
                    <td data-label={t('Date')} className="small">{w.date}</td>
                    <td data-label={t('Customer')}>{w.customer.name}</td>
                    <td data-label={t('Work')}>{w.description}{w.item && <div className="small muted">{w.item.name}</div>}</td>
                    <td data-label={t('Quantity')} className="num">{w.quantity} <span className="small muted">{unitName(t, w.unitCode).toLowerCase()}</span></td>
                    <td data-label={t('Rate')} className="num">{money(Number(w.unitPrice).toFixed(2))}</td>
                    <td data-label={t('Before GST')} className="num">{money(w.amount)}</td>
                    <td className="right">
                      {w.invoice ? (
                        <Link to={`/documents/${w.invoice.documentId}`} className="small">{t('Invoice {number}', { number: w.invoice.number ?? '' })}</Link>
                      ) : canLog && (
                        <div className="row" style={{ justifyContent: 'flex-end', gap: '0.35rem' }}>
                          <button className="secondary small-button" onClick={() => { setEditing(w); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t('Edit')}</button>
                          <button className="secondary small-button" aria-label={t('Remove')} onClick={() => remove(w)}>×</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {invoicing && <InvoiceWork row={invoicing} onClose={() => setInvoicing(null)} onDone={() => { setInvoicing(null); void load(); }} />}
    </div>
  );
}

/** Log work, or change an entry not yet invoiced. A timer can count the hours. */
function WorkForm({ entry, presetCustomer, onSaved, onCancel }: { entry: WorkEntry | null; presetCustomer: string | null; onSaved: () => void; onCancel: () => void }) {
  const t = useT();
  const toast = useToast();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(entry?.customer ?? null);
  const [service, setService] = useState<{ id: string; name: string } | null>(entry?.item ?? null);
  const [form, setForm] = useState({
    date: entry?.date ?? belizeToday(),
    description: entry?.description ?? '',
    quantity: entry?.quantity ?? '',
    unitCode: entry?.unitCode ?? 'HUR',
    unitPrice: entry ? Number(entry.unitPrice).toFixed(2) : '',
    gstCategory: entry?.gstCategory ?? 'S',
    exemptionReasonCode: entry?.exemptionReasonCode ?? null,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // From a customer's page: start with them chosen.
  useEffect(() => {
    if (entry || !presetCustomer) return;
    void api<Customer>(`/v1/customers/${presetCustomer}`).then((c) => setCustomer({ id: c.id, name: c.name })).catch(() => {});
  }, [entry, presetCustomer]);

  // The timer: started here, kept on this device (so it survives moving around the app).
  const [started, setStarted] = useState<number | null>(() => store.get<number>(TIMER_KEY));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [started]);
  const startTimer = () => {
    const at = Date.now();
    store.set(TIMER_KEY, at);
    setStarted(at);
    setNow(at);
  };
  const stopTimer = () => {
    if (!started) return;
    // To the quarter hour, at least one.
    const hours = Math.max(0.25, Math.ceil((Date.now() - started) / 900_000) / 4);
    store.remove(TIMER_KEY);
    setStarted(null);
    setForm((f) => ({ ...f, quantity: String(hours), unitCode: 'HUR' }));
  };
  const elapsed = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const clock = `${Math.floor(elapsed / 3600)}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  const amount = form.quantity && form.unitPrice ? fromCents(Math.round(Number(form.quantity) * cents(form.unitPrice))) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!customer) {
      setError(new Error(t('Choose the customer')));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        customerId: customer.id, date: form.date, description: form.description, quantity: form.quantity, unitCode: form.unitCode,
        itemId: service?.id ?? null, unitPrice: form.unitPrice, gstCategory: form.gstCategory, ...(form.gstCategory === 'E' && { exemptionReasonCode: form.exemptionReasonCode }),
      };
      if (entry) await api(`/v1/work/${entry.id}`, { method: 'PUT', body });
      else await api('/v1/work', { method: 'POST', body });
      toast(entry ? t('Saved') : t('Work logged for {name}', { name: customer.name }));
      if (!entry) setForm((f) => ({ ...f, description: '', quantity: '' }));
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack work-form" onSubmit={submit}>
      <div className="row">
        <h2>{entry ? t('Change this work') : t('Log work')}</h2>
        <span className="spacer" />
        {!entry && (started ? (
          <button type="button" className="secondary timer running" onClick={stopTimer}><span className="pulse" aria-hidden="true" /> <span className="num">{clock}</span> · {t('Stop')}</button>
        ) : (
          <button type="button" className="secondary timer" onClick={startTimer}>{t('Start a timer')}</button>
        ))}
      </div>
      <div className="form-grid">
        <Field label={t('Customer')}>
          <Combobox<Customer>
            placeholder={t('Search by name or TIN')}
            search={(q) => api<Page<Customer>>(`/v1/customers?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data)}
            render={(c) => <><strong>{c.name}</strong>{c.tin && <span className="muted"> · TIN {c.tin}</span>}</>}
            onPick={(c) => setCustomer({ id: c.id, name: c.name })}
            value={customer?.name ?? ''}
          />
        </Field>
        <Field label={t('Date')}><input type="date" required value={form.date} max={belizeToday()} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
      </div>
      <div className="form-grid">
        <Field label={t('Service (optional)')}>
          <Combobox<Item>
          placeholder={t('From your catalog: fills in the rate')}
          search={(q) => api<Page<Item>>(`/v1/items?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data)}
          render={(it) => <><strong>{it.name}</strong> <span className="muted">· {money(it.unitPrice)} / {unitName(t, it.unitCode).toLowerCase()}</span></>}
          onText={(v) => { if (!v) setService(null); }}
          onPick={(it) => {
            setService({ id: it.id, name: it.name });
            setForm((f) => ({
              ...f,
              description: f.description || it.name,
              unitCode: WORK_UNITS.includes(it.unitCode) ? it.unitCode : f.unitCode,
              unitPrice: Number(it.unitPrice).toFixed(2),
              gstCategory: it.gstCategory,
              exemptionReasonCode: it.exemptionReasonCode ?? null,
            }));
          }}
          value={service?.name ?? ''}
          />
        </Field>
        <Field label={t('What was done')}><input required maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('e.g. Monthly bookkeeping, AC repair at the shop')} /></Field>
      </div>
      <div className="form-grid work-numbers">
        <Field label={t('How much')}><input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,2})?" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.trim() })} placeholder="1.5" /></Field>
        <Field label={t('Counted in')}>
          <Select value={form.unitCode} onChange={(e) => setForm({ ...form, unitCode: e.target.value })}>
            {WORK_UNITS.map((u) => <option key={u} value={u}>{unitName(t, u)}</option>)}
          </Select>
        </Field>
        <Field label={t('Rate, before GST')}><input required inputMode="decimal" pattern="\d{1,12}(\.\d{1,4})?" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value.trim() })} placeholder="75.00" /></Field>
        <Field label="GST">
          <Select value={form.gstCategory} onChange={(e) => setForm({ ...form, gstCategory: e.target.value as 'S' | 'Z' | 'E' })} disabled={form.gstCategory === 'E'}>
            <option value="S">{t('GST 12.5%')}</option>
            <option value="Z">{t('Zero-rated (0%)')}</option>
            {form.gstCategory === 'E' && <option value="E">{t('Exempt')}</option>}
          </Select>
        </Field>
      </div>
      <ErrorText error={error} />
      <div className="row">
        <span className="small muted">{amount ? t('{amount} before GST', { amount: money(amount) }) : ' '}</span>
        <span className="spacer" />
        {entry && <button type="button" className="secondary" onClick={onCancel}>{t('Cancel')}</button>}
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : entry ? t('Save changes') : t('Log work')}</button>
      </div>
    </form>
  );
}

/** Invoice a customer's work: choose the entries, when it is due, and whether to email it. */
function InvoiceWork({ row, onClose, onDone }: { row: ToInvoice; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<WorkEntry[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dueDays, setDueDays] = useState('30');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState(Boolean(row.customer.email));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<WorkList>(`/v1/work?status=unbilled&customerId=${row.customer.id}`).then((r) => {
      setEntries(r.data);
      setPicked(new Set(r.data.map((w) => w.id)));
    }).catch(setError);
  }, [row.customer.id]);
  const chosen = (entries ?? []).filter((w) => picked.has(w.id));
  const total = fromCents(chosen.reduce((a, w) => a + cents(w.amount), 0));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const all = entries && chosen.length === entries.length;
      const r = await api<{ documentId: string; status: string; invoiced: number; emailed?: string | null; problem?: { message?: string } }>('/v1/work/invoice', {
        method: 'POST',
        body: { customerId: row.customer.id, ...(!all && { entryIds: chosen.map((w) => w.id) }), dueDays: Number(dueDays), ...(note.trim() && { note: note.trim() }), email },
      });
      if (r.invoiced === 0) {
        setError(new Error(t('BTS did not accept the invoice; the work is still to invoice. Open the document to see why.')));
        setBusy(false);
        return;
      }
      toast(r.emailed ? t('Invoice issued and emailed to {email}', { email: r.emailed }) : t('Invoice issued'));
      onDone();
      navigate(`/documents/${r.documentId}`, { viewTransition: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Invoice {name}', { name: row.customer.name })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!entries ? <div className="skeleton" style={{ height: '6rem' }} /> : (
          <ul className="plain-list work-pick">
            {entries.map((w) => (
              <li key={w.id}>
                <label className="row">
                  <input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} />
                  <span style={{ flex: 1, minWidth: 0 }}><strong>{w.description}</strong><span className="small muted"> · {w.date} · {w.quantity} {unitName(t, w.unitCode).toLowerCase()}</span></span>
                  <span className="num">{money(w.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="form-grid">
          <Field label={t('Payment due')}>
            <Select value={dueDays} onChange={(e) => setDueDays(e.target.value)}>
              <option value="0">{t('On receipt')}</option>
              {['7', '15', '30', '60'].map((d) => <option key={d} value={d}>{t('In {n} days', { n: d })}</option>)}
            </Select>
          </Field>
          <Field label={t('Note on the invoice (optional)')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. November')} /></Field>
        </div>
        {row.customer.email && <label className="row small"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> {t('Email it to {email}', { email: row.customer.email })}</label>}
        <p className="small muted">{t('{amount} before GST; GST is added on the invoice. It is signed and sent to BTS when you issue it.', { amount: money(total) })}</p>
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || chosen.length === 0}>{busy ? t('Issuing…') : t('Issue the invoice')}</button>
        </div>
      </form>
    </Modal>
  );
}
