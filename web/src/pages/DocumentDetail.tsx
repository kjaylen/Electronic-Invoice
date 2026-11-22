import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, type DocumentDetailInfo, type DocumentInfo, link } from '../api';
import { type T, useT } from '../i18n';
import { printPdf } from '../print';
import { useSession } from '../session';
import { useToast } from '../toast';
import { DocumentPaper, type PaperData } from '../paper';
import { ErrorText, Field, Modal, money, Segmented, StatusBadge, TYPE_NAMES, usePageTitle, whatsappNumber } from '../ui';
import { customerLabel } from './Dashboard';
import { PaymentsCard } from './Receivables';

const EXPLAIN: Partial<Record<DocumentInfo['status'], { tone: string; title: string; text: string }>> = {
  authorized: { tone: 'ok', title: 'Authorized by BTS', text: 'This document is valid. Print it or send it to your customer.' },
  authorized_with_alert: { tone: 'ok', title: 'Authorized by BTS, with notes', text: 'This document is valid. BTS flagged the points below; fix them on future documents.' },
  rejected: { tone: 'bad', title: 'Rejected by BTS', text: 'This document has no legal value. Fix the problem below and issue a new one.' },
  pending: { tone: 'warn', title: 'Waiting for BTS', text: 'BTS has not answered yet. We keep trying automatically; this page updates by itself.' },
  contingency_pending: { tone: 'warn', title: 'Issued while BTS was unreachable', text: 'You can give this copy to your customer: it says "Pending of BTS authorization". We send it to BTS automatically when it is back; this page updates by itself.' },
  superseded: { tone: 'info', title: 'Replaced', text: 'BTS could not be reached, so this sale was reissued as a contingency document. This one will never be sent.' },
  cancelled: { tone: 'info', title: 'Cancelled', text: 'This document was cancelled with BTS and no longer has legal value.' },
};

interface Message {
  id: string;
  channel: string;
  recipient: string;
  status: string;
  sentBy: string | null;
  createdAt: string;
}

function shareText(t: T, doc: DocumentInfo, business: string): string {
  return t('{type} {number} from {business}, {amount}:', { type: t(TYPE_NAMES[doc.type] ?? doc.typeName), number: `${doc.series}-${doc.number}`, business, amount: money(doc.totals.payable) });
}

export function DocumentDetail() {
  const t = useT();
  const toast = useToast();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { me, can } = useSession();
  const [doc, setDoc] = useState<DocumentDetailInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [paper, setPaper] = useState<PaperData | null>(null);
  const [variant, setVariant] = useState<'sheet' | 'receipt'>(() => (localStorage.getItem('etd.paper') === 'receipt' ? 'receipt' : 'sheet'));
  const shareUrl = useRef<string | null>(null);
  usePageTitle(doc ? `${t(TYPE_NAMES[doc.type] ?? doc.typeName)} ${doc.series}-${doc.number}` : t('Document'));

  const load = useCallback(() => api<DocumentDetailInfo>(`/v1/documents/${id}`).then(setDoc).catch(setError), [id]);
  const loadMessages = useCallback(() => api<{ data: Message[] }>(`/v1/documents/${id}/messages`).then((r) => setMessages(r.data)).catch(() => {}), [id]);
  useEffect(() => {
    void load();
    void loadMessages();
  }, [load, loadMessages]);
  // The on-screen copy, read again when the status changes (authorization number, stamps).
  const status = doc?.status;
  useEffect(() => {
    if (!status) return;
    void api<PaperData>(`/v1/documents/${id}/view`).then(setPaper).catch(() => setPaper(null));
  }, [id, status]);
  const chooseVariant = (v: 'sheet' | 'receipt') => {
    setVariant(v);
    try {
      localStorage.setItem('etd.paper', v);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };

  // While BTS has not settled the document, check again: soon at first, then less often.
  const waiting = doc?.status === 'pending' || doc?.status === 'contingency_pending';
  useEffect(() => {
    if (!waiting) return;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') void load();
        delay = Math.min(delay * 2, 30_000);
        tick();
      }, delay);
    };
    tick();
    return () => clearTimeout(timer);
  }, [waiting, load]);

  // Tell the person when a document they are looking at gets authorized.
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    if ((previous.current === 'pending' || previous.current === 'contingency_pending') && doc.status.startsWith('authorized')) toast(t('Authorized by BTS'), 'ok');
    previous.current = doc.status;
  }, [doc, t, toast]);

  if (error && !doc) return <ErrorText error={error} />;
  if (!doc) return <div className="stack" aria-busy="true"><div className="skeleton" style={{ width: '50%', height: '2.2rem' }} /><div className="skeleton" style={{ height: '6rem' }} /></div>;

  const printable = ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status);
  const explain = EXPLAIN[doc.status];
  const justIssued = (location.state as { justIssued?: boolean } | null)?.justIssued;
  const canNote = can('documents.adjust') && (doc.status === 'authorized' || doc.status === 'authorized_with_alert') && (doc.type === '01' || doc.type === '02');
  const business = me?.tradeName ?? me?.legalName ?? '';
  const typeName = t(TYPE_NAMES[doc.type] ?? doc.typeName);

  const getShareUrl = async () => {
    shareUrl.current ??= (await api<{ url: string }>(`/v1/documents/${doc.id}/share`, { method: 'POST' })).url;
    return shareUrl.current;
  };
  const whatsapp = async () => {
    // Open the window now (inside the click) so pop-up blockers allow it, then point it at WhatsApp.
    const w = window.open('', '_blank');
    try {
      const url = await getShareUrl();
      const phone = whatsappNumber(doc.customer?.contact?.telephone);
      const target = `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(`${shareText(t, doc, business)} ${url}`)}`;
      if (w) {
        w.opener = null;
        w.location.href = target;
      } else {
        window.location.href = target;
      }
    } catch (e) {
      w?.close();
      setError(e);
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(await getShareUrl());
      toast(t('Link copied. Anyone with it can open this document for 90 days.'));
    } catch (e) {
      setError(e);
    }
  };
  const nativeShare = async () => {
    try {
      const url = await getShareUrl();
      await navigator.share({ title: `${typeName} ${doc.series}-${doc.number}`, text: shareText(t, doc, business), url });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
    }
  };

  const cancel = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ cancellation: { status: string; conditions: Array<{ code: string; description?: string }> }; document: DocumentInfo }>(`/v1/documents/${doc.id}/cancel`, { method: 'POST', body: { reason } });
      setDoc({ ...r.document, lines: doc.lines });
      if (r.cancellation.status === 'rejected') setError(new Error(`${t('BTS refused the cancellation:')} ${r.cancellation.conditions.map((c) => c.description ?? c.code).join('; ')}`));
      else if (r.cancellation.status === 'pending') setError(new Error(t('BTS could not be reached; the cancellation will be retried.')));
      else toast(t('Document cancelled'));
      setCancelling(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/documents" viewTransition style={{ color: 'inherit' }}>{t('Documents')}</Link> / {doc.series}-{doc.number}</span>
          <h1>{typeName} <span className="num muted" style={{ fontWeight: 400 }}>{doc.series}-{doc.number}</span></h1>
          <p className="muted">{doc.issueDate} {doc.issueTime} · {customerLabel(t, doc)}{doc.issuedBy && <> · {t('issued by {name}', { name: doc.issuedBy })}</>}</p>
        </div>
        <span className="spacer" />
        <StatusBadge status={doc.status} />
      </div>

      {explain && (
        <div className={`banner ${explain.tone}`} role={doc.status === 'rejected' ? 'alert' : 'status'}>
          <div>
            <strong>{justIssued && doc.status.startsWith('authorized') ? t('Issued and authorized by BTS') : t(explain.title)}</strong>
            {t(explain.text)}
            {waiting && <span className="pulse" aria-hidden="true" />}
            {doc.conditions.length > 0 && (
              <ul>
                {doc.conditions.map((c) => <li key={c.code}><strong>{c.code}</strong> {c.description}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      <ErrorText error={error} />

      <div className="doc-layout">
        <div className="doc-main">
          <div className="paper-toolbar">
            <Segmented label={t('View')} value={variant} onChange={chooseVariant} options={[['sheet', t('Sheet')], ['receipt', t('Receipt')]]} />
            <span className="spacer" />
            {printable && (
              <>
                <button className="secondary small-button" onClick={() => printPdf(link(variant === 'receipt' ? `/v1/documents/${doc.id}/pdf?format=receipt&widthMm=80` : `/v1/documents/${doc.id}/pdf`))}>{t('Print')}<span className="chip" aria-hidden="true">⎙</span></button>
                <a className="button secondary small-button" href={link(`/v1/documents/${doc.id}/pdf${variant === 'receipt' ? '?format=receipt&widthMm=80' : ''}`)} target="_blank" rel="noreferrer">PDF</a>
              </>
            )}
          </div>
          <div className={`paper-stage ${variant}`}>
            {paper ? <DocumentPaper data={paper} variant={variant} /> : <div className="paper paper-sheet paper-loading" aria-busy="true"><div className="skeleton" style={{ height: '3rem', width: '45%' }} /><div className="skeleton" style={{ height: '8rem' }} /><div className="skeleton" style={{ height: '4rem', width: '40%', marginLeft: 'auto' }} /></div>}
          </div>
        </div>

        <aside className="doc-aside">
          <section className="card stack doc-total">
            <span className="kicker">{doc.totals.payable !== doc.totals.taxInclusive ? t('Amount due') : t('Total')} · BZD</span>
            <span className="doc-total-amount">{money(doc.totals.payable)}</span>
            <span className="small muted">{t('Subtotal')} {money(doc.totals.lineExtension)} · GST {money(doc.totals.gst)}</span>
            {doc.credit && (doc.credit.credited !== '0.00' || doc.credit.debited !== '0.00') && (
              <span className="small">{t('Credited so far: {credited}. Left to credit: {left}.', { credited: money(doc.credit.credited), left: money(doc.credit.remaining) })}</span>
            )}
          </section>

          {(doc.type === '01' || doc.type === '03') && doc.payment && <PaymentsCard doc={doc} onChange={() => void load()} />}

          <section className="card stack actions-bar">
            <h2>{t('Print and download')}</h2>
            <div className="action-grid">
              {printable && (
                <>
                  <button onClick={() => printPdf(link(`/v1/documents/${doc.id}/pdf`))}>{t('Print')}<span className="chip" aria-hidden="true">⎙</span></button>
                  {(doc.type === '01' || doc.type === '02') && <button className="secondary" onClick={() => printPdf(link(`/v1/documents/${doc.id}/pdf?format=receipt&widthMm=80`))}>{t('Print receipt')}</button>}
                  <a className="button secondary" href={link(`/v1/documents/${doc.id}/pdf`)} target="_blank" rel="noreferrer">{t('Open PDF')}</a>
                </>
              )}
              <a className="button secondary" href={link(`/v1/documents/${doc.id}/xml`)}>{t('Download XML')}</a>
            </div>
          </section>

          {printable && can('documents.send') && (
            <section className="card stack send">
              <div>
                <h2>{t('Send to the customer')}</h2>
                <p className="small muted">{t('By email with the PDF and XML attached, or as a link that opens the PDF (valid 90 days).')}</p>
              </div>
              <div className="action-grid">
                <button onClick={() => setEmailing(true)}>{t('Email')}<span className="chip" aria-hidden="true">@</span></button>
                <button className="secondary whatsapp" onClick={() => void whatsapp()}>WhatsApp</button>
                <button className="secondary" onClick={() => void copyLink()}>{t('Copy link')}</button>
                {'share' in navigator && <button className="secondary" onClick={() => void nativeShare()}>{t('Share…')}</button>}
              </div>
              {messages.length > 0 && (
                <ul className="sent-log small">
                  {messages.map((m) => (
                    <li key={m.id} className={m.status}>
                      {m.status === 'sent' ? t('Emailed to {to}', { to: m.recipient }) : t('Email to {to} failed', { to: m.recipient })}
                      <span className="muted"> · {new Date(m.createdAt).toLocaleString()}{m.sentBy && ` · ${m.sentBy}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(can('documents.issue') || canNote || can('documents.cancel')) && (doc.type === '01' || doc.type === '02' || doc.status.startsWith('authorized')) && (
            <section className="card stack">
              <h2>{t('Correct or repeat')}</h2>
              <div className="action-grid">
                {can('documents.issue') && (doc.type === '01' || doc.type === '02') && <button className="secondary" onClick={() => navigate(`/documents/new?type=${doc.type}&from=${doc.id}`, { viewTransition: true })}>{t('Issue again')}</button>}
                {canNote && <button className="secondary" disabled={doc.credit?.remaining === '0.00'} title={doc.credit?.remaining === '0.00' ? t('Fully credited') : undefined} onClick={() => navigate(`/documents/new?type=04&ref=${doc.id}`, { viewTransition: true })}>{t('Credit note')}</button>}
                {canNote && doc.type === '01' && <button className="secondary" onClick={() => navigate(`/documents/new?type=03&ref=${doc.id}`, { viewTransition: true })}>{t('Debit note')}</button>}
                {can('documents.cancel') && (doc.status === 'authorized' || doc.status === 'authorized_with_alert') && <button className="danger" onClick={() => setCancelling(true)}>{t('Cancel document')}</button>}
              </div>
            </section>
          )}

          <section className="card stack doc-facts">
            <h2>BTS</h2>
            <div><div className="small muted">{t('Document ID (ETDUI)')}</div><div className="mono">{doc.etdui}</div></div>
            <div><div className="small muted">{t('Authorization')}</div><div className="mono">{doc.protocolNumber ?? '—'}</div></div>
            <div className="small muted">{t('Environment')}: {doc.environment === 'test' ? t('Test (no fiscal value)') : t('Production')}</div>
            {doc.supersededBy && <p><Link to={`/documents/${doc.supersededBy}`}>{t('Replaced by the contingency document')}</Link></p>}
            {doc.supersedes && <p><Link to={`/documents/${doc.supersedes}`}>{t('Replaces the original attempt')}</Link></p>}
          </section>
        </aside>
      </div>

      {emailing && <EmailModal doc={doc} onClose={() => setEmailing(false)} onSent={(to) => { setEmailing(false); toast(t('Sent to {to}', { to })); void loadMessages(); }} />}

      {cancelling && (
        <Modal title={t('Cancel this document?')} onClose={() => setCancelling(false)}>
          <p>{t('Cancelling tells BTS this document no longer counts. It cannot be undone. To correct amounts, a credit note is usually better.')}</p>
          <form className="stack" onSubmit={cancel}>
            <Field label={t('Reason')}><input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="row">
              <span className="spacer" />
              <button type="button" className="secondary" onClick={() => setCancelling(false)}>{t('Keep it')}</button>
              <button type="submit" className="danger" disabled={busy || !reason.trim()}>{busy ? t('Cancelling…') : t('Cancel document')}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function EmailModal({ doc, onClose, onSent }: { doc: DocumentInfo; onClose: () => void; onSent: (to: string) => void }) {
  const t = useT();
  const [to, setTo] = useState(doc.customer?.contact?.email ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/documents/${doc.id}/email`, { method: 'POST', body: { to: to.trim(), ...(message.trim() && { message: message.trim() }) } });
      onSent(to.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Email this document')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('To')}><input type="email" required autoFocus value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('Message')} hint={t('Optional. The PDF and the XML are attached.')}><textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{busy ? t('Sending…') : t('Send')}</button>
        </div>
      </form>
    </Modal>
  );
}
