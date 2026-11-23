/** Recent sales on the till: print a copy, email it, refund it (a credit note), with the drawer opening for cash. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type DocumentDetailInfo, type DocumentInfo, type Page } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, fromCents, Modal, money, PAYMENT_MEANS, Select, StatusBadge, toCents } from '../ui';
import { useTill } from './TillApp';

const SALE_TYPES = new Set(['02', '04', '01']);

export function Sales() {
  const t = useT();
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback((query: string) => {
    api<Page<DocumentInfo>>(`/v1/documents?limit=50${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`)
      .then((r) => setDocs(r.data.filter((d) => SALE_TYPES.has(d.type))))
      .catch(setError);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => load(q), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [q, load]);

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Receipts and refunds')}</span><h1>{t('Recent sales')}</h1></div>
        <span className="spacer" />
        <input type="search" className="till-search" aria-label={t('Search sales')} placeholder={t('Number, customer or amount')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorText error={error} />
      {docs && docs.length === 0 && <p className="muted">{t('No sales yet.')}</p>}
      {docs && docs.length > 0 && (
        <ul className="sale-list">
          {docs.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => setOpen(d.id)}>
                <span className="mono">{d.series}-{d.number}</span>
                <span className="muted small">{t(d.typeName)} · {d.issueDate} {d.issueTime.slice(0, 5)}{d.customer?.name ? ` · ${d.customer.name}` : ''}</span>
                <span className="spacer" />
                <StatusBadge status={d.status} />
                <strong className="num">{d.type === '04' ? '-' : ''}{money(d.totals.payable)}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <SaleDetail id={open} onClose={() => setOpen(null)} onChanged={() => load(q)} />}
    </div>
  );
}

function SaleDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const [doc, setDoc] = useState<DocumentDetailInfo | null>(null);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'view' | 'refund'>('view');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<DocumentDetailInfo>(`/v1/documents/${id}`).then(setDoc).catch(setError), [id]);
  const printable = doc && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status);
  const refundable = doc && printable && doc.type === '02' && till.can('documents.adjust') && doc.credit && toCents(doc.credit.remaining) > 0n;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/documents/${id}/email`, { method: 'POST', body: { to: email.trim() } });
      toast(t('Sent to {to}', { to: email.trim() }));
      setEmail('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (doc && mode === 'refund') return <Refund doc={doc} onClose={() => setMode('view')} onDone={() => { onChanged(); onClose(); }} />;
  return (
    <Modal title={doc ? `${t(doc.typeName)} ${doc.series}-${doc.number}` : t('Sale')} onClose={onClose} wide>
      {!doc ? <ErrorText error={error} /> : (
        <div className="stack">
          <div className="row"><StatusBadge status={doc.status} /><span className="muted small">{doc.issueDate} {doc.issueTime.slice(0, 5)}{doc.issuedBy ? ` · ${doc.issuedBy}` : ''}</span></div>
          <table>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.lineNumber}><td>{l.description}<span className="muted small"> · {l.quantity} × {money(l.unitPrice)}</span></td><td className="right mono">{money(l.total)}</td></tr>
              ))}
              <tr className="total-row"><td><strong>{t('Total')}</strong></td><td className="right mono"><strong>{money(doc.totals.payable)}</strong></td></tr>
              {doc.credit && doc.credit.credited !== '0.00' && <tr><td className="muted">{t('Already refunded')}</td><td className="right mono muted">-{money(doc.credit.credited)}</td></tr>}
            </tbody>
          </table>
          <div className="row">
            {printable && <button type="button" onClick={() => void till.printDocument(doc.id, { copy: true }).catch((e) => toast(e instanceof Error ? e.message : String(e), 'bad'))}>{t('Print a copy')}</button>}
            {refundable && <button type="button" className="secondary" onClick={() => setMode('refund')}>{t('Refund')}</button>}
          </div>
          {printable && till.can('documents.send') && (
            <form className="row" onSubmit={(e) => void send(e)}>
              <input type="email" className="grow" aria-label={t('Email the receipt to')} placeholder={t('customer@example.com')} value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button className="secondary" disabled={busy}>{t('Email it')}</button>
            </form>
          )}
          <ErrorText error={error} />
        </div>
      )}
    </Modal>
  );
}

/** A credit note against a receipt: all of it or some lines, paid back in cash or to the card. */
function Refund({ doc, onClose, onDone }: { doc: DocumentDetailInfo; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(doc.lines.map((l) => [l.lineNumber, l.quantity])));
  const [exemption, setExemption] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [meansCode, setMeansCode] = useState('10');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const chosen = doc.lines.filter((l) => Number(qty[l.lineNumber] || 0) > 0);
  const estimate = chosen.reduce((a, l) => a + (toCents(l.total) * BigInt(Math.round(Number(qty[l.lineNumber]) * 1000))) / BigInt(Math.round(Number(l.quantity) * 1000)), 0n);
  const valid = chosen.length > 0 && reason.trim().length >= 3 && chosen.every((l) => Number(qty[l.lineNumber]) <= Number(l.quantity) && (l.gstCategory !== 'E' || exemption[l.lineNumber]?.trim()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const means = PAYMENT_MEANS.find(([c]) => c === meansCode)?.[1] ?? 'cash';
      const credit = await api<DocumentInfo>('/v1/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': `refund-${doc.id}-${chosen.map((l) => `${l.lineNumber}x${qty[l.lineNumber]}`).join(',')}-${reason.trim()}` },
        body: {
          type: '04',
          reference: { documentId: doc.id, reason: reason.trim() },
          lines: chosen.map((l) => ({
            description: l.description, quantity: qty[l.lineNumber], unitCode: l.unitCode, unitPrice: l.unitPrice, gstCategory: l.gstCategory,
            ...(l.gstCategory === 'E' && { exemptionReasonCode: exemption[l.lineNumber]!.trim() }),
          })),
          payment: { meansCode, terms: `Refunded by ${means.toLowerCase()}` },
        },
      });
      if (credit.status === 'rejected') throw new Error(t('Rejected by BTS'));
      toast(t('Refund issued: {amount}', { amount: money(credit.totals.payable) }));
      const kick = meansCode === '10' && till.hardware.openDrawerOnCash;
      void till.printDocument(credit.id, { openDrawer: kick }).catch((err) => toast(err instanceof Error ? err.message : String(err), 'bad'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Refund {number}', { number: `${doc.series}-${doc.number}` })} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small muted">{t('A credit note goes to BTS for what you give back. Set a quantity to 0 to keep that item out.')}</p>
        <table>
          <thead><tr><th>{t('Item')}</th><th className="right">{t('Sold')}</th><th className="right">{t('Refund')}</th></tr></thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.lineNumber}>
                <td>{l.description}<span className="muted small"> · {money(l.unitPrice)}</span>
                  {l.gstCategory === 'E' && Number(qty[l.lineNumber] || 0) > 0 && (
                    <input className="small-input" aria-label={t('Exemption reason code for {name}', { name: l.description })} placeholder={t('Exemption reason code')} value={exemption[l.lineNumber] ?? ''} onChange={(e) => setExemption({ ...exemption, [l.lineNumber]: e.target.value })} />
                  )}
                </td>
                <td className="right mono">{l.quantity}</td>
                <td className="right"><input className="qty-input" inputMode="decimal" aria-label={t('Quantity to refund of {name}', { name: l.description })} value={qty[l.lineNumber] ?? ''} onChange={(e) => setQty({ ...qty, [l.lineNumber]: e.target.value.replace(/[^\d.]/g, '') })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-grid">
          <Field label={t('Reason')}><input required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Returned, wrong size')} autoFocus /></Field>
          <Field label={t('Paid back by')}>
            <Select value={meansCode} onChange={(e) => setMeansCode(e.target.value)}>
              {PAYMENT_MEANS.slice(0, 3).map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}
            </Select>
          </Field>
        </div>
        <p className="strong">{t('About {amount} back to the customer', { amount: money(fromCents(estimate)) })}</p>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Back')}</button><span className="spacer" /><button disabled={busy || !valid}>{busy ? t('Signing and sending…') : t('Issue the refund')}</button></div>
      </form>
    </Modal>
  );
}
