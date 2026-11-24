/**
 * Gift cards: sell or give one (its code is shown once, and can be emailed),
 * find a card, see what it paid for; managers adjust a balance or turn a card off.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money, Segmented, useDebounced, usePageTitle } from '../ui';

interface GiftCard {
  id: string;
  last4: string;
  initial: string;
  balance: string;
  status: 'active' | 'used_up' | 'expired' | 'disabled';
  expiresOn: string | null;
  source: 'sold' | 'given';
  paidBy: 'cash' | 'card' | 'bank_transfer' | null;
  recipient: { name: string | null; email: string | null };
  message: string | null;
  note: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Activity {
  id: string;
  kind: 'issued' | 'used' | 'returned' | 'adjusted' | 'disabled' | 'enabled';
  amount: string;
  balanceAfter: string;
  note: string | null;
  at: string;
  by: string | null;
  order: { id: string; number: number } | null;
  document: { id: string; type: string | null; label: string | null } | null;
}

type Issued = { card: GiftCard; code: string; emailed: string | null };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function StatusText({ status }: { status: GiftCard['status'] }) {
  const t = useT();
  const text = { active: t('Active'), used_up: t('Used up'), expired: t('Expired'), disabled: t('Turned off') }[status];
  return <span className={`badge ${status === 'active' ? 'authorized' : status === 'disabled' ? 'cancelled' : 'test'}`}>{text}</span>;
}

export function GiftCards() {
  const t = useT();
  usePageTitle(t('Gift cards'));
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const [status, setStatus] = useState<'active' | 'used_up' | 'disabled' | 'all'>('active');
  const [data, setData] = useState<{ data: GiftCard[]; summary: { active: number; outstanding: string } } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selling, setSelling] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<NonNullable<typeof data>>(`/v1/gift-cards?status=${query ? 'all' : status}${query ? `&q=${encodeURIComponent(query)}` : ''}`).then(setData).catch(setError);
  }, [status, query]);
  useEffect(load, [load]);

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Sell')}</span><h1>{t('Gift cards')}</h1></div>
        <span className="spacer" />
        <button type="button" onClick={() => setSelling(true)}>{t('Sell a gift card')}</button>
      </div>
      <p className="muted small" style={{ margin: 0, maxWidth: '52rem' }}>
        {t('A gift card is paid in advance, so selling one issues no BTS receipt: GST is charged when it is used, on the receipt of that sale. Cards work at the counter, on the tills and in the online store, over as many purchases as it takes.')}
      </p>
      <div className="grid three gift-summary">
        <div className="card kpi"><span className="kpi-head">{t('Active cards')}</span><span className="kpi-value">{data ? data.summary.active : '—'}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Still to be spent')}</span><span className="kpi-value">{data ? money(data.summary.outstanding) : '—'}</span><span className="kpi-note">{t('What customers can still spend with their cards.')}</span></div>
      </div>
      <div className="row">
        <Segmented label={t('Show')} value={status} onChange={setStatus} options={[['active', t('Active')], ['used_up', t('Used up')], ['disabled', t('Turned off')], ['all', t('All')]]} />
        <span className="spacer" />
        <input type="search" placeholder={t('Code, last four, name or email')} aria-label={t('Search gift cards')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <ErrorText error={error} />
      <section className="card">
        {data === null ? <div className="skeleton" style={{ height: '6rem' }} /> : data.data.length === 0 ? (
          <div className="empty">{query ? t('No gift card matches your search.') : status === 'active' ? t('No active gift cards. Sell one to get started.') : t('None here.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive clickable">
              <thead><tr><th scope="col">{t('Card')}</th><th scope="col">{t('For')}</th><th scope="col" className="right">{t('Value')}</th><th scope="col" className="right">{t('Balance')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Since')}</th></tr></thead>
              <tbody>
                {data.data.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c.id)}>
                    <td data-label={t('Card')}><button type="button" className="link mono" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }}>••••{c.last4}</button></td>
                    <td data-label={t('For')}>{c.recipient.name ?? '—'}{c.recipient.email && <div className="small muted">{c.recipient.email}</div>}</td>
                    <td data-label={t('Value')} className="right num">{money(c.initial)}</td>
                    <td data-label={t('Balance')} className="right num"><strong>{money(c.balance)}</strong></td>
                    <td data-label={t('Status')}><StatusText status={c.status} /></td>
                    <td data-label={t('Since')} className="small">{day(c.createdAt)} · {c.source === 'given' ? t('Given') : t('Sold')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {selling && <SellDialog onClose={() => setSelling(false)} onIssued={(r) => { setSelling(false); setIssued(r); load(); }} />}
      {issued && <IssuedDialog issued={issued} onClose={() => setIssued(null)} />}
      {open && <CardDialog id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function SellDialog({ onClose, onIssued }: { onClose: () => void; onIssued: (r: Issued) => void }) {
  const t = useT();
  const { can } = useSession();
  const [amount, setAmount] = useState('');
  const [how, setHow] = useState<'cash' | 'card' | 'bank_transfer' | 'given'>('cash');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [send, setSend] = useState(true);
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = /^\d{1,5}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Issued>('/v1/gift-cards', {
        method: 'POST',
        body: {
          amount: Number(amount).toFixed(2),
          source: how === 'given' ? 'given' : 'sold',
          ...(how !== 'given' && { paidBy: how }),
          ...(name.trim() && { recipientName: name.trim() }),
          ...(email.trim() && { recipientEmail: email.trim() }),
          ...(message.trim() && { message: message.trim() }),
          ...(note.trim() && { note: note.trim() }),
          ...(expires && { expiresOn: expires }),
          send: Boolean(email.trim()) && send,
        },
      });
      onIssued(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const ways: Array<[typeof how, string]> = [['cash', t('Cash')], ['card', t('Card')], ['bank_transfer', t('Transfer')], ...(can('documents.adjust') ? [['given', t('Given free')] as [typeof how, string]] : [])];
  return (
    <Modal title={t('Sell a gift card')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('Amount (BZ$)')}>
          <input inputMode="decimal" required autoFocus placeholder="50.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="quick-amounts row" role="group" aria-label={t('Quick amounts')}>
          {['25', '50', '100', '200'].map((a) => <button key={a} type="button" className="secondary" aria-pressed={Number(amount) === Number(a)} onClick={() => setAmount(`${a}.00`)}>BZ${a}</button>)}
        </div>
        <Segmented label={t('Paid by')} value={how} onChange={setHow} options={ways} />
        {how === 'given' && <p className="small muted" style={{ margin: 0 }}>{t('No money taken: store credit, a prize or a goodwill gesture.')}</p>}
        {how === 'cash' && <p className="small muted" style={{ margin: 0 }}>{t('Cash for a card counts in your open shift’s drawer.')}</p>}
        <div className="form-grid">
          <Field label={t('For (name)')} hint={t('Optional.')}><input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('Their email')} hint={t('Optional. To email them the card.')}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        </div>
        {email.trim() && <label className="row small"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> {t('Email the card to them now')}</label>}
        <Field label={t('Message')} hint={t('Optional. Goes in the email.')}><textarea rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label={t('Use by')} hint={t('Optional. Leave empty for a card that does not expire.')}><input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Field label={t('Note for staff')} hint={t('Optional.')}><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <ErrorText error={error} />
        <div className="row">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <span className="spacer" />
          <button type="submit" disabled={busy || !valid}>{busy ? t('Making the card…') : how === 'given' ? t('Give {amount} card', { amount: valid ? money(Number(amount).toFixed(2)) : '' }) : t('Sell {amount} card', { amount: valid ? money(Number(amount).toFixed(2)) : '' })}</button>
        </div>
      </form>
    </Modal>
  );
}

function IssuedDialog({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const copy = () => void navigator.clipboard?.writeText(issued.code).then(() => toast(t('Code copied'))).catch(() => {});
  return (
    <Modal title={t('The gift card is ready')} onClose={onClose}>
      <div className="stack">
        <div className="gift-card-face">
          <span className="small">{t('Gift card')}</span>
          <strong className="gift-card-amount">{money(issued.card.initial)}</strong>
          <span className="gift-card-code mono">{issued.code}</span>
        </div>
        <p style={{ margin: 0 }}>{issued.emailed ? t('Emailed to {email}. Give the customer the code too if they want it now.', { email: issued.emailed }) : t('Give this code to the customer. It is what they pay with.')}</p>
        <p className="small muted" style={{ margin: 0 }}>{t('The code is shown only now. Later you can email it again from the card.')}</p>
        <div className="row">
          <button type="button" className="secondary" onClick={copy}>{t('Copy the code')}</button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>{t('Done')}</button>
        </div>
      </div>
    </Modal>
  );
}

function CardDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const manager = can('documents.adjust');
  const [data, setData] = useState<{ card: GiftCard; activity: Activity[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'adjust' | 'send' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    void api<NonNullable<typeof data>>(`/v1/gift-cards/${id}`).then(setData).catch(setError);
  }, [id]);
  const run = async (call: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (r && typeof r === 'object' && 'card' in r) setData(r as NonNullable<typeof data>);
      setPanel(null);
      setAmount('');
      setNote('');
      if (done) toast(done);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Modal title={t('Gift card')} onClose={onClose}>{error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '10rem' }} />}</Modal>;
  const c = data.card;
  const kind = (a: Activity) => ({ issued: c.source === 'given' ? t('Given') : t('Sold'), used: t('Paid for a sale'), returned: t('Given back'), adjusted: t('Adjusted'), disabled: t('Turned off'), enabled: t('Turned on') }[a.kind]);
  return (
    <Modal title={t('Gift card ••••{last4}', { last4: c.last4 })} onClose={onClose} wide>
      <div className="stack">
        <div className="row" style={{ alignItems: 'baseline', gap: '1rem' }}>
          <div><span className="kicker">{t('Balance')}</span><div className="gift-balance">{money(c.balance)}</div></div>
          <StatusText status={c.status} />
          <span className="spacer" />
          <span className="small muted">{t('Value {amount}', { amount: money(c.initial) })} · {c.source === 'given' ? t('Given') : t('Sold')}{c.paidBy && ` (${c.paidBy === 'bank_transfer' ? t('Transfer') : c.paidBy === 'card' ? t('Card') : t('Cash')})`} · {day(c.createdAt)}{c.expiresOn && ` · ${t('Use by {date}', { date: c.expiresOn })}`}</span>
        </div>
        {(c.recipient.name || c.recipient.email || c.message || c.note) && (
          <div className="small">
            {(c.recipient.name || c.recipient.email) && <div>{t('For')}: {c.recipient.name}{c.recipient.email && ` <${c.recipient.email}>`}</div>}
            {c.message && <div className="muted">“{c.message}”</div>}
            {c.note && <div className="muted">{t('Note')}: {c.note}</div>}
          </div>
        )}
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('When')}</th><th scope="col">{t('What')}</th><th scope="col" className="right">{t('Amount')}</th><th scope="col" className="right">{t('Balance')}</th></tr></thead>
            <tbody>
              {data.activity.map((a) => (
                <tr key={a.id}>
                  <td data-label={t('When')} className="small">{when(a.at)}{a.by && <div className="muted">{a.by}</div>}</td>
                  <td data-label={t('What')}>
                    {kind(a)}
                    {a.order && <> · <Link to={`/orders/${a.order.id}`} onClick={onClose}>{t('Order #{n}', { n: a.order.number ?? '' })}</Link></>}
                    {a.document && <> · <Link to={`/documents/${a.document.id}`} onClick={onClose}>{a.document.label ?? t('Receipt')}</Link></>}
                    {a.note && <div className="small muted">{a.note}</div>}
                  </td>
                  <td data-label={t('Amount')} className={`right num ${a.amount.startsWith('-') ? '' : 'gain-text'}`}>{a.amount === '0.00' ? '' : a.amount.startsWith('-') ? `−${money(a.amount.slice(1))}` : `+${money(a.amount)}`}</td>
                  <td data-label={t('Balance')} className="right num">{money(a.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {panel === 'adjust' && (
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/gift-cards/${c.id}/adjust`, { method: 'POST', body: { amount: amount.trim(), note: note.trim() } }), t('Balance changed')); }}>
            <div className="form-grid">
              <Field label={t('Add or take off (BZ$)')} hint={t('A minus sign takes off: -5.00.')}><input inputMode="decimal" required autoFocus pattern="-?\d{1,5}(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Field label={t('Why')}><input required maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            <div className="row"><button type="submit" disabled={busy}>{t('Change the balance')}</button><button type="button" className="secondary" onClick={() => setPanel(null)}>{t('Cancel')}</button></div>
          </form>
        )}
        {panel === 'send' && (
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void run(() => api<{ emailed: string }>(`/v1/gift-cards/${c.id}/send`, { method: 'POST', body: to.trim() ? { email: to.trim() } : {} }).then((r) => toast(t('Emailed to {email}', { email: r.emailed })))); }}>
            <Field label={t('Email')} hint={manager ? t('Leave empty to send it to {email}.', { email: c.recipient.email ?? '—' }) : undefined}>
              <input type="email" autoFocus placeholder={c.recipient.email ?? ''} readOnly={!manager} value={manager ? to : c.recipient.email ?? ''} onChange={(e) => setTo(e.target.value)} required={!c.recipient.email} />
            </Field>
            <div className="row"><button type="submit" disabled={busy}>{t('Email the card')}</button><button type="button" className="secondary" onClick={() => setPanel(null)}>{t('Cancel')}</button></div>
          </form>
        )}
        <ErrorText error={error} />
        {panel === null && (
          <div className="row">
            {(c.recipient.email || manager) && <button type="button" className="secondary" disabled={busy} onClick={() => { setTo(''); setPanel('send'); }}>{t('Email it again')}</button>}
            {manager && <button type="button" className="secondary" disabled={busy} onClick={() => setPanel('adjust')}>{t('Adjust the balance')}</button>}
            <span className="spacer" />
            {manager && (c.status === 'disabled'
              ? <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api(`/v1/gift-cards/${c.id}/enable`, { method: 'POST', body: {} }), t('The card works again'))}>{t('Turn it back on')}</button>
              : <button type="button" className="link danger-link" disabled={busy} onClick={() => void run(() => api(`/v1/gift-cards/${c.id}/disable`, { method: 'POST', body: { note: 'Turned off' } }), t('The card is turned off'))}>{t('Turn it off (lost or stolen)')}</button>)}
          </div>
        )}
      </div>
    </Modal>
  );
}
