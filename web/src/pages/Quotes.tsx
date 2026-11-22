/** Quotes (estimates) and recurring invoices: the lists and each one's page. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, link } from '../api';
import { type T, useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeToday, ErrorText, Field, Modal, money, Segmented, TYPE_NAMES, UNITS, useDebounced, usePageTitle, whatsappNumber } from '../ui';

// ---------- quotes ----------

type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'invoiced' | 'cancelled';

interface Quote {
  id: string;
  number: string;
  status: QuoteStatus;
  expired: boolean;
  customer: { id: string | null; name: string | null; tin: string | null; email: string | null };
  totals: { subtotal: string; gst: string; total: string };
  validUntil: string;
  dueDays: number;
  documentType: '01' | '02';
  sentAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  documentId: string | null;
  createdAt: string;
}

interface QuoteDetailInfo extends Quote {
  document: { payment?: { terms?: string }; note?: string; customer?: { contact?: { telephone?: string } } };
  lines: Array<{ description: string; quantity: string; unitCode: string; unitPrice: string; gstCategory: string; net: string; gst: string; total: string }>;
}

const QUOTE_STATUS: Record<QuoteStatus, string> = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', invoiced: 'Invoiced', cancelled: 'Cancelled' };
export const unitLabel = (t: T, code: string) => t(UNITS.find(([c]) => c === code)?.[1] ?? code);

export function QuoteBadge({ q }: { q: Pick<Quote, 'status' | 'expired'> }) {
  const t = useT();
  if (q.expired) return <span className="badge q-expired">{t('Expired')}</span>;
  return <span className={`badge q-${q.status}`}>{t(QUOTE_STATUS[q.status])}</span>;
}

export function Quotes() {
  const t = useT();
  usePageTitle(t('Quotes'));
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as 'open' | 'accepted' | 'invoiced' | 'all' | null) ?? 'open';
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const [rows, setRows] = useState<Quote[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setRows(null);
    api<{ data: Quote[] }>(`/v1/quotes?status=${status}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`).then((r) => setRows(r.data)).catch(setError);
  }, [status, search]);
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Sell')}</span><h1>{t('Quotes')}</h1></div>
        <span className="spacer" />
        <Link className="button" to="/quotes/new" viewTransition>{t('New quote')}<span className="chip" aria-hidden="true">+</span></Link>
      </div>
      <div className="row">
        <Segmented label={t('Show')} value={status} onChange={(v) => setParams({ status: v }, { replace: true })} options={[['open', t('Open')], ['accepted', t('Accepted')], ['invoiced', t('Invoiced')], ['all', t('All')]]} />
        <span className="spacer" />
        <input type="search" className="search-input" placeholder={t('Customer or quote number')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search quotes')} />
      </div>
      <ErrorText error={error} />
      <section className="card">
        {!rows ? <div className="skeleton" style={{ height: '10rem' }} /> : rows.length === 0 ? (
          <div className="empty">{status === 'open' ? t('No open quotes. A quote shows the customer the price before you invoice; when they accept it online, turn it into a tax invoice in one click.') : t('Nothing here.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Quote')}</th><th scope="col">{t('Date')}</th><th scope="col">{t('Customer')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Valid until')}</th><th scope="col">{t('Status')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/quotes/${r.id}`, { viewTransition: true })}>
                    <td data-label={t('Quote')}><Link to={`/quotes/${r.id}`} viewTransition onClick={(e) => e.stopPropagation()} className="mono">{r.number}</Link></td>
                    <td data-label={t('Date')}>{r.createdAt.slice(0, 10)}</td>
                    <td data-label={t('Customer')}>{r.customer.name ?? '—'}</td>
                    <td data-label={t('Total')} className="right">{money(r.totals.total)}</td>
                    <td data-label={t('Valid until')}>{r.validUntil}</td>
                    <td data-label={t('Status')}><QuoteBadge q={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function QuoteDetail() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const { can } = useSession();
  const [q, setQ] = useState<QuoteDetailInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<null | 'send' | 'accept' | 'decline' | 'invoice' | 'cancel'>(null);
  usePageTitle(q ? `${t('Quote')} ${q.number}` : t('Quote'));
  const load = useCallback(() => api<QuoteDetailInfo>(`/v1/quotes/${id}`).then(setQ).catch(setError), [id]);
  useEffect(() => void load(), [load]);
  if (error && !q) return <div className="stack"><ErrorText error={error} /></div>;
  if (!q) return <div className="stack"><div className="skeleton" style={{ height: '2.4rem', width: '30%' }} /><div className="skeleton" style={{ height: '18rem' }} /></div>;

  const open = q.status === 'draft' || q.status === 'sent';
  const shareLink = async (via: 'copy' | 'whatsapp') => {
    try {
      const r = await api<{ url: string }>(`/v1/quotes/${q.id}/link`, { method: 'POST' });
      if (via === 'copy') {
        await navigator.clipboard.writeText(r.url);
        toast(t('Link copied'));
      } else {
        const phone = whatsappNumber(q.document.customer?.contact?.telephone);
        const text = t('Quotation {n} from us, {amount}: {url}', { n: q.number, amount: money(q.totals.total), url: r.url });
        window.open(`https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      }
      void load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/quotes" viewTransition>{t('Quotes')}</Link></span>
          <h1>{t('Quote')} <span className="mono">{q.number}</span></h1>
        </div>
        <QuoteBadge q={q} />
        <span className="spacer" />
        {open && can('documents.issue') && <Link className="button secondary" to={`/quotes/${q.id}/edit`} viewTransition>{t('Edit')}</Link>}
        <a className="button secondary" href={link(`/v1/quotes/${q.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>
      </div>
      <ErrorText error={error} />
      {q.status === 'accepted' && (
        <div className="banner ok"><div><strong>{t('Accepted by {name}', { name: q.acceptedBy ?? t('the customer') })}</strong>{t('Turn it into a {type} when you are ready: it is signed and sent to BTS like any other.', { type: t(TYPE_NAMES[q.documentType] ?? 'Tax invoice').toLowerCase() })}</div></div>
      )}
      {q.status === 'declined' && <div className="banner bad"><div><strong>{t('Declined')}</strong>{q.declineReason ?? t('No reason given.')}</div></div>}
      {q.expired && <div className="banner warn"><div><strong>{t('This quote expired on {date}.', { date: q.validUntil })}</strong>{t('Edit it to give a new date, then send it again.')}</div></div>}

      <div className="doc-layout">
        <section className="card stack quote-sheet">
          <div className="row">
            <div>
              <span className="kicker">{t('Prepared for')}</span>
              <h2>{q.customer.name ?? '—'}</h2>
              <p className="small muted">{[q.customer.tin && `TIN ${q.customer.tin}`, q.customer.email].filter(Boolean).join(' · ')}</p>
            </div>
            <span className="spacer" />
            <div className="right">
              <span className="kicker">{t('Valid until')}</span>
              <div className="strong">{q.validUntil}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Description')}</th><th scope="col" className="right">{t('Qty')}</th><th scope="col" className="right">{t('Unit price')}</th><th scope="col" className="right">GST</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
              <tbody>
                {q.lines.map((l, i) => (
                  <tr key={i}>
                    <td data-label={t('Description')}>{l.description}</td>
                    <td data-label={t('Qty')} className="right">{l.quantity} <span className="muted small">{unitLabel(t, l.unitCode)}</span></td>
                    <td data-label={t('Unit price')} className="right">{money(l.unitPrice)}</td>
                    <td data-label="GST" className="right">{money(l.gst)}</td>
                    <td data-label={t('Total')} className="right strong">{money(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="quote-totals">
            <div><dt>{t('Subtotal')}</dt><dd>{money(q.totals.subtotal)}</dd></div>
            <div><dt>GST</dt><dd>{money(q.totals.gst)}</dd></div>
            <div className="grand"><dt>{t('Total')}</dt><dd>{money(q.totals.total)}</dd></div>
          </dl>
          {(q.document.payment?.terms || q.document.note) && (
            <p className="small">{[q.document.payment?.terms, q.document.note].filter(Boolean).join(' · ')}</p>
          )}
        </section>

        <aside className="doc-aside">
          {(open || q.status === 'accepted') && can('documents.issue') && (
            <section className="card stack">
              <h2>{t('Invoice it')}</h2>
              <p className="small muted">{q.documentType === '01' ? t('Issues the tax invoice with these lines, due {n} days after.', { n: q.dueDays }) : t('Issues the tax receipt with these lines.')}</p>
              <button className="lime" onClick={() => setDialog('invoice')}>{t('Turn into a {type}', { type: t(TYPE_NAMES[q.documentType] ?? 'Tax invoice').toLowerCase() })}</button>
            </section>
          )}
          {q.status === 'invoiced' && q.documentId && (
            <section className="card stack">
              <h2>{t('Invoiced')}</h2>
              <Link className="button secondary" to={`/documents/${q.documentId}`} viewTransition>{t('Open the invoice')}</Link>
            </section>
          )}
          {open && can('documents.send') && (
            <section className="card stack send">
              <h2>{t('Send to the customer')}</h2>
              <p className="small muted">{t('With the PDF and a link where they can accept it online.')}</p>
              <div className="action-grid">
                <button onClick={() => setDialog('send')}>{t('Email')}<span className="chip" aria-hidden="true">@</span></button>
                <button className="secondary whatsapp" onClick={() => void shareLink('whatsapp')}>WhatsApp</button>
                <button className="secondary" onClick={() => void shareLink('copy')}>{t('Copy link')}</button>
              </div>
            </section>
          )}
          {open && can('documents.issue') && (
            <section className="card stack">
              <h2>{t('Answered another way?')}</h2>
              <div className="action-grid">
                <button className="secondary" onClick={() => setDialog('accept')}>{t('Mark accepted')}</button>
                <button className="secondary" onClick={() => setDialog('decline')}>{t('Mark declined')}</button>
              </div>
            </section>
          )}
          <section className="card stack doc-facts">
            <h2>{t('History')}</h2>
            <ul className="plain small timeline">
              <li>{t('Created {when}', { when: new Date(q.createdAt).toLocaleString() })}</li>
              {q.sentAt && <li>{t('Sent {when}', { when: new Date(q.sentAt).toLocaleString() })}</li>}
              {q.acceptedAt && <li>{t('Accepted by {name}, {when}', { name: q.acceptedBy ?? '—', when: new Date(q.acceptedAt).toLocaleString() })}</li>}
              {q.declinedAt && <li>{t('Declined {when}', { when: new Date(q.declinedAt).toLocaleString() })}</li>}
            </ul>
            {(open || q.status === 'accepted' || q.status === 'declined') && can('documents.issue') && <button className="link danger-link" onClick={() => setDialog('cancel')}>{t('Cancel this quote')}</button>}
          </section>
        </aside>
      </div>

      {dialog === 'send' && <SendQuoteModal quote={q} onClose={() => setDialog(null)} onDone={(to) => { setDialog(null); toast(t('Quote emailed to {to}', { to })); void load(); }} />}
      {(dialog === 'accept' || dialog === 'decline' || dialog === 'cancel') && (
        <QuoteStatusModal quote={q} status={dialog === 'accept' ? 'accepted' : dialog === 'decline' ? 'declined' : 'cancelled'} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />
      )}
      {dialog === 'invoice' && <InvoiceQuoteModal quote={q} onClose={() => setDialog(null)} onDone={(docId) => navigate(`/documents/${docId}`, { state: { justIssued: true }, viewTransition: true })} />}
    </div>
  );
}

function SendQuoteModal({ quote, onClose, onDone }: { quote: Quote; onClose: () => void; onDone: (to: string) => void }) {
  const t = useT();
  const [to, setTo] = useState(quote.customer.email ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ to: string }>(`/v1/quotes/${quote.id}/send`, { method: 'POST', body: { to: to.trim(), ...(message.trim() && { message: message.trim() }) } });
      onDone(r.to);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Email quote {n}', { n: quote.number })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Field label={t('Email')}><input type="email" required value={to} onChange={(e) => setTo(e.target.value)} autoFocus /></Field>
        <Field label={t('Message')} hint={t('Optional.')}><textarea rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy}>{busy ? t('Sending…') : t('Send quote')}</button></div>
      </form>
    </Modal>
  );
}

function QuoteStatusModal({ quote, status, onClose, onDone }: { quote: Quote; status: 'accepted' | 'declined' | 'cancelled'; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(status === 'accepted' ? quote.customer.name ?? '' : '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/quotes/${quote.id}/status`, { method: 'POST', body: { status, ...(text.trim() && (status === 'accepted' ? { name: text.trim() } : { reason: text.trim() })) } });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const title = status === 'accepted' ? t('Mark {n} accepted', { n: quote.number }) : status === 'declined' ? t('Mark {n} declined', { n: quote.number }) : t('Cancel quote {n}?', { n: quote.number });
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {status !== 'cancelled' && (
          <Field label={status === 'accepted' ? t('Accepted by') : t('Reason')} hint={status === 'declined' ? t('Optional.') : undefined}>
            <input value={text} maxLength={status === 'accepted' ? 120 : 500} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
        )}
        {status === 'cancelled' && <p className="small">{t('The customer can no longer accept it. It stays in your list, marked cancelled.')}</p>}
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Back')}</button><span className="spacer" /><button className={status === 'cancelled' ? 'danger' : ''} disabled={busy}>{status === 'accepted' ? t('Mark accepted') : status === 'declined' ? t('Mark declined') : t('Cancel quote')}</button></div>
      </form>
    </Modal>
  );
}

function InvoiceQuoteModal({ quote, onClose, onDone }: { quote: Quote; onClose: () => void; onDone: (documentId: string) => void }) {
  const t = useT();
  const [email, setEmail] = useState(Boolean(quote.customer.email));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const type = t(TYPE_NAMES[quote.documentType] ?? 'Tax invoice').toLowerCase();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ document: { id: string } }>(`/v1/quotes/${quote.id}/invoice`, { method: 'POST', body: { email } });
      onDone(r.document.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Issue the {type} for {n}?', { type, n: quote.number })} onClose={onClose}>
      <div className="stack">
        <p>{t('{total} to {customer}, signed and sent to BTS now.', { total: money(quote.totals.total), customer: quote.customer.name ?? '—' })}{quote.documentType === '01' && ` ${t('Due {date}.', { date: new Date(Date.parse(`${belizeToday()}T00:00:00Z`) + quote.dueDays * 86_400_000).toISOString().slice(0, 10) })}`}</p>
        {quote.customer.email && <label className="row small"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> {t('Email it to {to}, with a link to pay', { to: quote.customer.email })}</label>}
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Back')}</button><span className="spacer" /><button className="lime" disabled={busy} onClick={() => void submit()}>{busy ? t('Signing and sending…') : t('Issue {type}', { type })}</button></div>
      </div>
    </Modal>
  );
}

// ---------- recurring invoices ----------

interface Recurring {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'finished';
  customer: { id: string | null; name: string | null; email: string | null };
  total: string;
  frequency: 'weekly' | 'monthly' | 'yearly';
  intervalCount: number;
  nextDate: string | null;
  endDate: string | null;
  remaining: number | null;
  dueDays: number;
  autoSend: boolean;
  lastDocumentId: string | null;
  lastError: string | null;
}

interface RecurringDetailInfo extends Recurring {
  upcoming: string[];
  runs: Array<{ date: string; status: 'claimed' | 'issued' | 'failed'; error: string | null; documentId: string | null; emailed: boolean; documentStatus: string | null; number: string | null }>;
}

export function everyText(t: T, r: Pick<Recurring, 'frequency' | 'intervalCount'>): string {
  const n = r.intervalCount;
  if (r.frequency === 'weekly') return n === 1 ? t('Every week') : t('Every {n} weeks', { n });
  if (r.frequency === 'monthly') return n === 1 ? t('Every month') : n === 3 ? t('Every quarter') : t('Every {n} months', { n });
  return n === 1 ? t('Every year') : t('Every {n} years', { n });
}

const RECURRING_STATUS = { active: 'Active', paused: 'Paused', finished: 'Ended' } as const;

function RecurringBadge({ r }: { r: Pick<Recurring, 'status' | 'lastError'> }) {
  const t = useT();
  if (r.status === 'active' && r.lastError) return <span className="badge rejected">{t('Needs attention')}</span>;
  return <span className={`badge r-${r.status}`}>{t(RECURRING_STATUS[r.status])}</span>;
}

export function RecurringList() {
  const t = useT();
  usePageTitle(t('Recurring invoices'));
  const navigate = useNavigate();
  const [rows, setRows] = useState<Recurring[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<{ data: Recurring[] }>('/v1/recurring').then((r) => setRows(r.data)).catch(setError), []);
  const monthly = (rows ?? []).filter((r) => r.status === 'active').reduce((a, r) => {
    const perYear = r.frequency === 'weekly' ? 52 / r.intervalCount : r.frequency === 'monthly' ? 12 / r.intervalCount : 1 / r.intervalCount;
    return a + (Number(r.total) * perYear) / 12;
  }, 0);
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Records')}</span><h1>{t('Recurring invoices')}</h1></div>
        <span className="spacer" />
        <Link className="button" to="/recurring/new" viewTransition>{t('New recurring invoice')}<span className="chip" aria-hidden="true">+</span></Link>
      </div>
      <ErrorText error={error} />
      {rows && rows.some((r) => r.status === 'active') && <p className="muted">{t('About {amount} a month from active schedules (GST included).', { amount: money(monthly.toFixed(2)) })}</p>}
      <section className="card">
        {!rows ? <div className="skeleton" style={{ height: '10rem' }} /> : rows.length === 0 ? (
          <div className="empty">{t('No recurring invoices yet. For retainers, rent or service plans: the invoice is issued on its date, sent to BTS and emailed to the customer with a link to pay.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Customer')}</th><th scope="col">{t('Repeats')}</th><th scope="col">{t('Next invoice')}</th><th scope="col" className="right">{t('Amount')}</th><th scope="col">{t('Status')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/recurring/${r.id}`, { viewTransition: true })}>
                    <td data-label={t('Name')}><Link to={`/recurring/${r.id}`} viewTransition onClick={(e) => e.stopPropagation()}>{r.name}</Link></td>
                    <td data-label={t('Customer')}>{r.customer.name ?? '—'}</td>
                    <td data-label={t('Repeats')}>{everyText(t, r)}</td>
                    <td data-label={t('Next invoice')}>{r.status === 'active' ? r.nextDate : '—'}</td>
                    <td data-label={t('Amount')} className="right">{money(r.total)}</td>
                    <td data-label={t('Status')}><RecurringBadge r={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function RecurringDetail() {
  const t = useT();
  const toast = useToast();
  const { id } = useParams();
  const { can } = useSession();
  const [r, setR] = useState<RecurringDetailInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'run' | 'end'>(null);
  usePageTitle(r?.name ?? t('Recurring invoice'));
  const load = useCallback(() => api<RecurringDetailInfo>(`/v1/recurring/${id}`).then(setR).catch(setError), [id]);
  useEffect(() => void load(), [load]);
  const act = async (action: 'pause' | 'resume' | 'end' | 'run') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/recurring/${id}/${action}`, { method: 'POST' });
      toast(action === 'run' ? t('Invoice issued') : action === 'pause' ? t('Paused') : action === 'resume' ? t('Resumed') : t('Schedule ended'));
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (error && !r) return <div className="stack"><ErrorText error={error} /></div>;
  if (!r) return <div className="stack"><div className="skeleton" style={{ height: '2.4rem', width: '30%' }} /><div className="skeleton" style={{ height: '16rem' }} /></div>;
  const manage = can('documents.issue') && r.status !== 'finished';
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker"><Link to="/recurring" viewTransition>{t('Recurring invoices')}</Link></span><h1>{r.name}</h1></div>
        <RecurringBadge r={r} />
        <span className="spacer" />
        {manage && <Link className="button secondary" to={`/recurring/${r.id}/edit`} viewTransition>{t('Edit')}</Link>}
        {manage && (r.status === 'active' ? <button className="secondary" disabled={busy} onClick={() => void act('pause')}>{t('Pause')}</button> : <button disabled={busy} onClick={() => void act('resume')}>{t('Resume')}</button>)}
      </div>
      <ErrorText error={error} />
      {r.lastError && r.status !== 'finished' && <div className="banner bad"><div><strong>{t('The last invoice was not issued')}</strong>{r.lastError} {t('It is tried again an hour later; fix the cause (certificate, plan, customer details) in the meantime.')}</div></div>}
      <div className="doc-layout">
        <section className="card stack">
          <dl className="pay-facts">
            <div><dt>{t('Customer')}</dt><dd>{r.customer.name ?? '—'}</dd></div>
            <div><dt>{t('Amount')}</dt><dd className="strong">{money(r.total)}</dd></div>
            <div><dt>{t('Repeats')}</dt><dd>{everyText(t, r)}</dd></div>
            <div><dt>{t('Payment due')}</dt><dd>{r.dueDays ? t('{n} days after', { n: r.dueDays }) : t('On receipt')}</dd></div>
            <div><dt>{t('Ends')}</dt><dd>{r.status === 'finished' ? t('Ended') : r.remaining !== null ? t('After {n} more', { n: r.remaining }) : r.endDate ? r.endDate : t('Never')}</dd></div>
            <div><dt>{t('Emailed to the customer')}</dt><dd>{r.autoSend ? (r.customer.email ?? t('No email address')) : t('No')}</dd></div>
          </dl>
          {r.upcoming.length > 0 && r.status === 'active' && (
            <div className="stack-tight">
              <h3>{t('Next invoices')}</h3>
              <div className="chips">{r.upcoming.map((d) => <span key={d} className="chip-date">{d}</span>)}</div>
            </div>
          )}
          <div className="stack-tight">
            <h3>{t('Issued so far')}</h3>
            {r.runs.length === 0 ? <p className="small muted">{t('Nothing yet. The first invoice is issued on {date}.', { date: r.nextDate ?? '—' })}</p> : (
              <div className="table-wrap">
                <table className="responsive">
                  <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('Invoice')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Emailed')}</th></tr></thead>
                  <tbody>
                    {r.runs.map((x) => (
                      <tr key={x.date}>
                        <td data-label={t('Date')}>{x.date}</td>
                        <td data-label={t('Invoice')}>{x.documentId ? <Link to={`/documents/${x.documentId}`} viewTransition className="mono">{x.number}</Link> : '—'}</td>
                        <td data-label={t('Status')}>{x.status === 'failed' ? <span className="late small">{x.error}</span> : x.status === 'issued' ? t('Issued') : t('Issuing…')}</td>
                        <td data-label={t('Emailed')}>{x.emailed ? t('Yes') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
        <aside className="doc-aside">
          {manage && r.status === 'active' && (
            <section className="card stack">
              <h2>{t('Next invoice: {date}', { date: r.nextDate ?? '—' })}</h2>
              <p className="small muted">{t('Issued automatically on the morning of that date.')}</p>
              <button className="secondary" disabled={busy} onClick={() => setConfirm('run')}>{t('Issue it now')}</button>
            </section>
          )}
          {manage && (
            <section className="card stack">
              <button className="link danger-link" onClick={() => setConfirm('end')}>{t('End this schedule')}</button>
            </section>
          )}
        </aside>
      </div>
      {confirm && (
        <Modal title={confirm === 'run' ? t('Issue the next invoice now?') : t('End this schedule?')} onClose={() => setConfirm(null)}>
          <div className="stack">
            <p>{confirm === 'run' ? t('{amount} to {customer} is signed and sent to BTS now, and the schedule moves on to the following date.', { amount: money(r.total), customer: r.customer.name ?? '—' }) : t('No more invoices are issued. Those already issued are not affected.')}</p>
            <ErrorText error={error} />
            <div className="row"><button type="button" className="secondary" onClick={() => setConfirm(null)}>{t('Back')}</button><span className="spacer" /><button className={confirm === 'end' ? 'danger' : 'lime'} disabled={busy} onClick={() => void act(confirm)}>{confirm === 'run' ? t('Issue now') : t('End schedule')}</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
