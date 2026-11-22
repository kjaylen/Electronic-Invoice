/** The page a customer opens from a quote email: the offer, the PDF, accept or decline. No sign-in. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useT } from '../i18n';
import { ErrorText, Field, money, usePageTitle } from '../ui';
import { PayShell } from './Pay';
import { QuoteBadge, unitLabel } from './Quotes';

interface QuoteInfo {
  business: { name: string; email: string; telephone: string };
  quote: {
    number: string;
    status: 'draft' | 'sent' | 'accepted' | 'declined' | 'invoiced' | 'cancelled';
    expired: boolean;
    validUntil: string;
    customer: string | null;
    totals: { subtotal: string; gst: string; total: string };
    acceptedBy: string | null;
    terms: string | null;
    note: string | null;
  };
  lines: Array<{ description: string; quantity: string; unitCode: string; unitPrice: string; total: string }>;
  canRespond: boolean;
  pdfUrl: string;
}

export function QuoteView() {
  const t = useT();
  const { token = '' } = useParams();
  const [info, setInfo] = useState<QuoteInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null);
  usePageTitle(info ? `${t('Quotation')} ${info.quote.number}` : t('Quotation'));
  const load = useCallback(() => api<QuoteInfo>(`/v1/quote/${token}`).then(setInfo).catch(setError), [token]);
  useEffect(() => void load(), [load]);

  const respond = async (e: FormEvent, what: 'accept' | 'decline') => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/quote/${token}/${what}`, { method: 'POST', body: what === 'accept' ? { name: name.trim() } : { ...(reason.trim() && { reason: reason.trim() }) } });
      setDone(what === 'accept' ? 'accepted' : 'declined');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (error instanceof ApiError && error.status === 404) {
    return <PayShell><section className="card stack pay-card"><h1>{t('This link is not available')}</h1><p className="muted">{t('It may have expired. Ask the business to send it again.')}</p></section></PayShell>;
  }
  if (!info) return <PayShell><section className="card pay-card"><ErrorText error={error} />{!error && <div className="skeleton" style={{ height: '16rem' }} />}</section></PayShell>;
  const q = info.quote;
  return (
    <PayShell>
      <section className="card stack pay-card quote-card">
        <div className="row">
          <div>
            <span className="kicker">{info.business.name}</span>
            <h1>{t('Quotation')} <span className="mono">{q.number}</span></h1>
            {q.customer && <p className="small muted">{t('Prepared for {name}', { name: q.customer })}</p>}
          </div>
          <span className="spacer" />
          <QuoteBadge q={q} />
        </div>

        {done === 'accepted' && <div className="banner ok"><div><strong>{t('Thank you, the quote is accepted.')}</strong>{t('{business} has been told and will send you the invoice.', { business: info.business.name })}</div></div>}
        {done === 'declined' && <div className="banner info"><div><strong>{t('Thanks for letting us know.')}</strong>{t('{business} has been told.', { business: info.business.name })}</div></div>}
        {!done && (q.status === 'accepted' || q.status === 'invoiced') && <div className="banner ok"><div>{t('Accepted by {name}.', { name: q.acceptedBy ?? '—' })}</div></div>}
        {!done && q.expired && <div className="banner warn"><div><strong>{t('This quote expired on {date}.', { date: q.validUntil })}</strong>{t('Contact {business} for an updated one.', { business: info.business.name })}</div></div>}
        {q.status === 'cancelled' && <div className="banner warn"><div>{t('This quote was withdrawn. Contact {business}.', { business: info.business.name })}</div></div>}

        <ul className="quote-lines">
          {info.lines.map((l, i) => (
            <li key={i}>
              <div><strong>{l.description}</strong><span className="small muted">{l.quantity} {unitLabel(t, l.unitCode)} × {money(l.unitPrice)}</span></div>
              <span className="mono">{money(l.total)}</span>
            </li>
          ))}
        </ul>
        <dl className="quote-totals">
          <div><dt>{t('Subtotal')}</dt><dd>{money(q.totals.subtotal)}</dd></div>
          <div><dt>GST</dt><dd>{money(q.totals.gst)}</dd></div>
          <div className="grand"><dt>{t('Total')}</dt><dd>{money(q.totals.total)}</dd></div>
        </dl>
        {(q.terms || q.note) && <p className="small">{[q.terms, q.note].filter(Boolean).join(' · ')}</p>}
        {!q.expired && q.status !== 'cancelled' && <p className="small muted">{t('Valid until {date}.', { date: q.validUntil })}</p>}

        <ErrorText error={error} />
        {info.canRespond && !done && !declining && (
          <form className="stack accept-box" onSubmit={(e) => void respond(e, 'accept')}>
            <Field label={t('Your name')} hint={t('Accepting tells {business} to go ahead; they send you the invoice.', { business: info.business.name })}>
              <input required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="row">
              <button className="lime big" disabled={busy || name.trim().length < 2}>{busy ? t('Sending…') : t('Accept quote')}</button>
              <span className="spacer" />
              <button type="button" className="link" onClick={() => setDeclining(true)}>{t('Decline')}</button>
            </div>
          </form>
        )}
        {info.canRespond && !done && declining && (
          <form className="stack accept-box" onSubmit={(e) => void respond(e, 'decline')}>
            <Field label={t('Anything to tell {business}?', { business: info.business.name })} hint={t('Optional.')}>
              <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="row">
              <button type="button" className="secondary" onClick={() => setDeclining(false)}>{t('Back')}</button>
              <span className="spacer" />
              <button className="danger" disabled={busy}>{t('Decline quote')}</button>
            </div>
          </form>
        )}
        <div className="action-grid">
          <a className="button secondary" href={info.pdfUrl} target="_blank" rel="noreferrer">{t('Download the quote (PDF)')}</a>
        </div>
        <p className="small muted">{t('Questions? {email} · {phone}', { email: info.business.email, phone: info.business.telephone })}</p>
      </section>
    </PayShell>
  );
}
