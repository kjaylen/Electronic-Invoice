import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, type DocumentInfo } from '../api';
import { ErrorText, Field, Modal, money, StatusBadge } from '../ui';

const EXPLAIN: Partial<Record<DocumentInfo['status'], { tone: string; title: string; text: string }>> = {
  authorized: { tone: 'ok', title: 'Authorized by BTS', text: 'This document is valid. You can print it or send the PDF to your customer.' },
  authorized_with_alert: { tone: 'ok', title: 'Authorized by BTS, with notes', text: 'This document is valid. BTS flagged the points below; fix them on future documents.' },
  rejected: { tone: 'bad', title: 'Rejected by BTS', text: 'This document has no legal value. Fix the problem below and issue a new one.' },
  pending: { tone: 'warn', title: 'Waiting for BTS', text: 'BTS has not answered yet. We keep trying automatically; this page updates when it does.' },
  contingency_pending: { tone: 'warn', title: 'Issued while BTS was unreachable', text: 'You can give this copy to your customer: it says "Pending of BTS authorization". We send it to BTS automatically when it is back.' },
  superseded: { tone: 'info', title: 'Replaced', text: 'BTS could not be reached, so this sale was reissued as a contingency document. This one will never be sent.' },
  cancelled: { tone: 'info', title: 'Cancelled', text: 'This document was cancelled with BTS and no longer has legal value.' },
};

export function DocumentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<DocumentInfo>(`/v1/documents/${id}`).then(setDoc).catch(setError);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Keep checking while BTS has not settled the document.
  useEffect(() => {
    if (!doc || (doc.status !== 'pending' && doc.status !== 'contingency_pending')) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.status]);

  if (error && !doc) return <ErrorText error={error} />;
  if (!doc) return <p className="muted">Loading…</p>;

  const printable = ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status);
  const explain = EXPLAIN[doc.status];
  const justIssued = (location.state as { justIssued?: boolean } | null)?.justIssued;
  const canNote = (doc.status === 'authorized' || doc.status === 'authorized_with_alert') && (doc.type === '01' || doc.type === '02');

  const cancel = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ cancellation: { status: string; conditions: Array<{ code: string; description?: string }> }; document: DocumentInfo }>(`/v1/documents/${doc.id}/cancel`, { method: 'POST', body: { reason } });
      setDoc(r.document);
      if (r.cancellation.status === 'rejected') setError(new Error(`BTS refused the cancellation: ${r.cancellation.conditions.map((c) => c.description ?? c.code).join('; ')}`));
      else if (r.cancellation.status === 'pending') setError(new Error('BTS could not be reached; the cancellation will be retried.'));
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
          <span className="kicker"><Link to="/documents" viewTransition style={{ color: 'inherit' }}>Documents</Link> / {doc.series}-{doc.number}</span>
          <h1>{doc.typeName} <span className="num muted" style={{ fontWeight: 400 }}>{doc.series}-{doc.number}</span></h1>
          <p className="muted">{doc.issueDate} {doc.issueTime} · {doc.customer?.name ?? (doc.customer?.tin ? `TIN ${doc.customer.tin}` : 'Walk-in customer')}</p>
        </div>
        <span className="spacer" />
        <StatusBadge status={doc.status} />
      </div>

      {explain && (
        <div className={`banner ${explain.tone}`}>
          <div>
            <strong>{justIssued && doc.status.startsWith('authorized') ? `Issued and ${explain.title.charAt(0).toLowerCase()}${explain.title.slice(1)}` : explain.title}</strong>
            {explain.text}
            {doc.conditions.length > 0 && (
              <ul>
                {doc.conditions.map((c) => <li key={c.code}><strong>{c.code}</strong> {c.description}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      <ErrorText error={error} />

      <div className="row">
        {printable && (
          <>
            <a className="button" href={`/v1/documents/${doc.id}/pdf`} target="_blank" rel="noreferrer">Print A4<span className="chip">↗</span></a>
            {(doc.type === '01' || doc.type === '02') && (
              <a className="button secondary" href={`/v1/documents/${doc.id}/pdf?format=receipt`} target="_blank" rel="noreferrer">Print receipt</a>
            )}
          </>
        )}
        <a className="button secondary" href={`/v1/documents/${doc.id}/xml`}>Download XML</a>
        {canNote && <button className="secondary" onClick={() => navigate(`/documents/new?type=04&ref=${doc.id}`, { viewTransition: true })}>Credit note</button>}
        {canNote && doc.type === '01' && <button className="secondary" onClick={() => navigate(`/documents/new?type=03&ref=${doc.id}`, { viewTransition: true })}>Debit note</button>}
        <span className="spacer" />
        {(doc.status === 'authorized' || doc.status === 'authorized_with_alert') && <button className="danger" onClick={() => setCancelling(true)}>Cancel document</button>}
      </div>

      <div className="grid">
        <section className="card totals ticket">
          <span className="kicker" style={{ color: 'var(--lime)' }}>Amounts · BZD</span>
          <div><span>Subtotal</span><span>{money(doc.totals.lineExtension)}</span></div>
          <div><span>GST</span><span>{money(doc.totals.gst)}</span></div>
          {doc.totals.tax !== doc.totals.gst && <div><span>All taxes</span><span>{money(doc.totals.tax)}</span></div>}
          <div className="grand"><span>Total</span><span>{money(doc.totals.taxInclusive)}</span></div>
          {doc.totals.payable !== doc.totals.taxInclusive && <div><span>Amount due</span><span>{money(doc.totals.payable)}</span></div>}
        </section>
        <section className="card stack">
          <h2>BTS</h2>
          <div><div className="small muted">Document ID (ETDUI)</div><div className="mono">{doc.etdui}</div></div>
          <div><div className="small muted">Authorization</div><div className="mono">{doc.protocolNumber ?? '—'}</div></div>
          <div className="small muted">Environment: {doc.environment === 'test' ? 'Test (no fiscal value)' : 'Production'}</div>
          {doc.supersededBy && <p>Replaced by <Link to={`/documents/${doc.supersededBy}`}>the contingency document</Link>.</p>}
          {doc.supersedes && <p>Replaces <Link to={`/documents/${doc.supersedes}`}>the original attempt</Link>.</p>}
        </section>
      </div>

      {printable && <iframe className="pdf-frame" title="Printed copy" src={`/v1/documents/${doc.id}/pdf`} />}

      {cancelling && (
        <Modal title="Cancel this document?" onClose={() => setCancelling(false)}>
          <p>Cancelling tells BTS this document no longer counts. It cannot be undone. To correct amounts, a credit note is usually better.</p>
          <form className="stack" onSubmit={cancel}>
            <Field label="Reason"><input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="row">
              <span className="spacer" />
              <button type="button" className="secondary" onClick={() => setCancelling(false)}>Keep it</button>
              <button type="submit" className="danger" disabled={busy || !reason.trim()}>{busy ? 'Cancelling…' : 'Cancel document'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
