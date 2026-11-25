/**
 * Layaways: goods put aside for customers who pay over time. Each is started
 * at the counter (a customer on the sale, "On account", "Layaway"). Here: who
 * owes what and until when, taking a payment, handing the goods over once
 * nothing is owed, and cancelling (the goods back on the shelf, the money back).
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money, Segmented, Select, usePageTitle, whatsappNumber } from '../ui';

interface Layaway {
  id: string;
  number: string;
  status: 'open' | 'collected' | 'cancelled';
  customer: { id: string | null; name: string; phone: string | null };
  items: Array<{ description: string; quantity: string }>;
  total: string;
  paid: string;
  balance: string;
  ready: boolean;
  holdUntil: string;
  daysLeft: number;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  collectedAt: string | null;
  cancelledAt: string | null;
  refunded: string | null;
}
interface Listing { data: Layaway[]; summary: { open: number; owed: string; ready: number; expired: number } }
type Method = 'cash' | 'card' | 'bank_transfer' | 'online';

const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const METHODS: Array<[Method, string]> = [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['online', 'Mobile wallet']];

function PayDialog({ layaway, onClose, onDone }: { layaway: Layaway; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [amount, setAmount] = useState(layaway.balance);
  const [method, setMethod] = useState<Method>('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= Number(layaway.balance);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/documents/${layaway.id}/payments`, { method: 'POST', body: { amount, method, note: 'Layaway payment' } });
      toast(Number(amount) >= Number(layaway.balance) ? t('Paid in full. {name} can collect.', { name: layaway.customer.name }) : t('Payment of {amount} recorded', { amount: money(amount) }));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Payment from {name}', { name: layaway.customer.name })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="muted small" style={{ margin: 0 }}>{t('{balance} is still owed of {total}.', { balance: money(layaway.balance), total: money(layaway.total) })}</p>
        <Field label={t('Amount')}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label={t('Paid by')}>
          <Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {METHODS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
          </Select>
        </Field>
        {!valid && amount !== '' && <p className="form-error">{t('An amount up to {balance}', { balance: money(layaway.balance) })}</p>}
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={!valid || busy}>{busy ? t('Saving…') : t('Record payment')}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelDialog({ layaway, onClose, onDone }: { layaway: Layaway; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [method, setMethod] = useState<Method>('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const paid = Number(layaway.paid) > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await api<Layaway>(`/v1/layaways/${layaway.id}/cancel`, { method: 'POST', body: paid ? { refundMethod: method } : {} });
      toast(done.refunded && Number(done.refunded) > 0 ? t('Cancelled. Give {name} back {amount}.', { name: layaway.customer.name, amount: money(done.refunded) }) : t('Cancelled. The goods are back in stock.'));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Cancel this layaway?')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p style={{ margin: 0 }}>{t('A credit note is issued for the invoice, and the goods go back on the shelf.')}</p>
        {paid ? (
          <>
            <p style={{ margin: 0 }}><strong>{t('{name} has paid {amount}. It is given back now.', { name: layaway.customer.name, amount: money(layaway.paid) })}</strong></p>
            <Field label={t('Given back by')}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                {METHODS.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
              </Select>
            </Field>
          </>
        ) : <p className="muted" style={{ margin: 0 }}>{t('Nothing was paid, so there is nothing to give back.')}</p>}
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Keep it')}</button>
          <button type="submit" className="danger" disabled={busy}>{busy ? t('Cancelling…') : t('Cancel the layaway')}</button>
        </div>
      </form>
    </Modal>
  );
}

function Until({ l }: { l: Layaway }) {
  const t = useT();
  if (l.status === 'collected') return <span className="badge authorized">{t('Collected')}</span>;
  if (l.status === 'cancelled') return <span className="badge cancelled">{t('Cancelled')}</span>;
  if (l.ready) return <span className="badge authorized">{t('Paid: ready to collect')}</span>;
  if (l.daysLeft < 0) return <span className="badge rejected">{l.daysLeft === -1 ? t('1 day late') : t('{n} days late', { n: -l.daysLeft })}</span>;
  return <span className="badge pending">{l.daysLeft === 0 ? t('Until today') : l.daysLeft === 1 ? t('1 day left') : t('{n} days left', { n: l.daysLeft })}</span>;
}

export function Layaways() {
  const t = useT();
  usePageTitle(t('Layaways'));
  const toast = useToast();
  const confirm = useConfirm();
  const { can, session } = useSession();
  const [status, setStatus] = useState<'open' | 'collected' | 'cancelled'>('open');
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState<Layaway | null>(null);
  const [cancelling, setCancelling] = useState<Layaway | null>(null);
  const load = useCallback(() => {
    void api<Listing>(`/v1/layaways?status=${status}`).then((d) => {
      setData(d);
      setError(null);
    }).catch(setError);
  }, [status]);
  useEffect(load, [load]);

  const collect = async (l: Layaway) => {
    if (!(await confirm({ title: t('Hand over the goods?'), body: t('{name} has paid in full and takes: {items}.', { name: l.customer.name, items: l.items.map((i) => `${i.quantity} × ${i.description}`).join(', ') }), confirm: t('Collected') }))) return;
    try {
      await api(`/v1/layaways/${l.id}/collect`, { method: 'POST', body: {} });
      toast(t('Collected by {name}', { name: l.customer.name }));
      load();
    } catch (err) {
      setError(err);
    }
  };
  const remind = (l: Layaway) => {
    const phone = whatsappNumber(l.customer.phone);
    if (!phone) return null;
    const text = t('Hello {name}, this is {business}. Your layaway ({items}) has {balance} left to pay, and we are keeping it until {day}.', {
      name: l.customer.name, business: session?.business.tradeName ?? session?.business.legalName ?? '', items: l.items.map((i) => i.description).join(', '), balance: money(l.balance), day: day(l.holdUntil),
    });
    return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  };

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Sell')}</span><h1>{t('Layaways')}</h1></div>
        <span className="spacer" />
        <Link className="button" to="../counter">{t('Start one at the counter')}</Link>
      </div>
      <p className="muted small" style={{ margin: 0, maxWidth: '52rem' }}>
        {t('Goods put aside for a customer who pays over time. Start one at the counter: choose the customer, then “On account” and “Layaway”. The goods leave the shelf at once and are handed over when nothing is owed.')}
      </p>
      <div className="grid four">
        <div className="card kpi"><span className="kpi-head">{t('Open')}</span><span className="kpi-value">{data ? data.summary.open : '—'}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Still owed')}</span><span className="kpi-value">{data ? money(data.summary.owed) : '—'}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Ready to collect')}</span><span className="kpi-value">{data ? data.summary.ready : '—'}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Past their day')}</span><span className="kpi-value">{data ? data.summary.expired : '—'}</span><span className="kpi-note">{t('Remind the customer, or cancel and put the goods back.')}</span></div>
      </div>
      <Segmented label={t('Show')} value={status} onChange={setStatus} options={[['open', t('Open')], ['collected', t('Collected')], ['cancelled', t('Cancelled')]]} />
      <ErrorText error={error} />
      <section className="card">
        {data === null ? !error && <div className="skeleton" style={{ height: '6rem' }} /> : data.data.length === 0 ? (
          <div className="empty">{status === 'open' ? t('No open layaways.') : t('None here.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive layaways">
              <thead>
                <tr>
                  <th scope="col">{t('Customer')}</th><th scope="col">{t('Goods')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col" className="right">{t('Paid')}</th>
                  <th scope="col" className="right">{t('Still owed')}</th><th scope="col">{t('Kept until')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((l) => (
                  <tr key={l.id}>
                    <td data-label={t('Customer')}>
                      <strong>{l.customer.name}</strong>
                      <div className="small muted">{l.customer.phone ?? t('No phone')} · <Link to={`../documents/${l.id}`}>{t('Invoice {n}', { n: l.number })}</Link></div>
                    </td>
                    <td data-label={t('Goods')} className="small">{l.items.map((i) => `${i.quantity} × ${i.description}`).join(', ')}{l.note && <div className="muted">{l.note}</div>}</td>
                    <td data-label={t('Total')} className="right num">{money(l.total)}</td>
                    <td data-label={t('Paid')} className="right num">{money(l.paid)}</td>
                    <td data-label={t('Still owed')} className="right num"><strong>{money(l.balance)}</strong></td>
                    <td data-label={t('Kept until')} className="small">{day(l.holdUntil)}<div><Until l={l} /></div></td>
                    <td className="right layaway-actions">
                      {l.status === 'open' && !l.ready && can('payments.record') && <button type="button" className="small-button" onClick={() => setPaying(l)}>{t('Take a payment')}</button>}
                      {l.status === 'open' && l.ready && <button type="button" className="small-button" onClick={() => void collect(l)}>{t('Hand over')}</button>}
                      {l.status === 'open' && !l.ready && remind(l) && <a className="button secondary small-button" href={remind(l)!} target="_blank" rel="noreferrer">{t('Remind on WhatsApp')}</a>}
                      {l.status === 'open' && can('documents.adjust') && <button type="button" className="link" onClick={() => setCancelling(l)}>{t('Cancel')}</button>}
                      {l.status === 'cancelled' && l.refunded && Number(l.refunded) > 0 && <span className="small muted">{t('{amount} given back', { amount: money(l.refunded) })}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {paying && <PayDialog layaway={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />}
      {cancelling && <CancelDialog layaway={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); load(); }} />}
    </div>
  );
}
