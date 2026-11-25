/** Recent sales on the till: print a copy, email it, refund it (a credit note), with the drawer opening for cash. */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DocumentDetailInfo, type DocumentInfo, type Page } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, fromCents, money, PAYMENT_MEANS, StatusBadge, toCents } from '../ui';
import { Button, Chip, EmptyState, Icon, ListRow, SearchField, Sheet, Skeleton, Stepper, dmy } from './design/components';
import { useTill } from './TillApp';

const SALE_TYPES = new Set(['02', '04', '01']);
type Filter = 'all' | 'sales' | 'refunds' | 'attention';
const SETTLED = new Set(['authorized', 'authorized_with_alert']);

/** "Today", "Yesterday" or the day, month and year. */
function dayLabel(iso: string, t: ReturnType<typeof useT>): string {
  const day = new Date(`${iso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return diff === 0 ? t('Today') : diff === 1 ? t('Yesterday') : dmy(day);
}

export function Sales() {
  const t = useT();
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
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

  // What the chips show: all, sales, refunds, or what is not settled with BTS yet.
  const shown = useMemo(() => docs?.filter((d) => filter === 'all' || (filter === 'sales' ? d.type !== '04' : filter === 'refunds' ? d.type === '04' : !SETTLED.has(d.status))) ?? null, [docs, filter]);
  const days = useMemo(() => {
    const out: Array<[string, DocumentInfo[]]> = [];
    for (const d of shown ?? []) {
      const last = out.at(-1);
      if (last && last[0] === d.issueDate) last[1].push(d);
      else out.push([d.issueDate, [d]]);
    }
    return out;
  }, [shown]);
  const waiting = docs?.filter((d) => !SETTLED.has(d.status)).length ?? 0;

  return (
    <div className="stack till-list-screen">
      <div className="till-list-head">
        <div><span className="kicker">{t('Receipts and refunds')}</span><h1>{t('Recent sales')}</h1></div>
        <div className="till-search"><SearchField label={t('Search sales')} placeholder={t('Number, customer or amount')} value={q} onChange={setQ} /></div>
      </div>
      <div className="till-filters" role="group" aria-label={t('Show')}>
        <Chip pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('All')}</Chip>
        <Chip pressed={filter === 'sales'} icon="receipt" onClick={() => setFilter('sales')}>{t('Sales')}</Chip>
        <Chip pressed={filter === 'refunds'} icon="undo" onClick={() => setFilter('refunds')}>{t('Refunds')}</Chip>
        <Chip pressed={filter === 'attention'} icon="alert" onClick={() => setFilter('attention')}>{t('Not settled yet')}{waiting > 0 && <span className="count num">{waiting}</span>}</Chip>
      </div>
      <ErrorText error={error} />
      {!docs && !error && <div className="pos-list">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height="64px" />)}</div>}
      {shown && shown.length === 0 && (
        <EmptyState title={q || filter !== 'all' ? t('Nothing matches') : t('No sales yet.')}>
          {q || filter !== 'all' ? t('Try another number or name, or show all.') : t('Sales made on this till show here.')}
        </EmptyState>
      )}
      {days.map(([day, list]) => (
        <section key={day} className="till-day" aria-label={dayLabel(day, t)}>
          <h2 className="till-day-head"><span>{dayLabel(day, t)}</span><span className="num">{t('{n} sales', { n: list.length })}</span></h2>
          <ul className="sale-list pos-list">
            {list.map((d) => (
              <li key={d.id}>
                <ListRow
                  lead={<span className={`row-icon ${d.type === '04' ? 'refund' : ''}`}><Icon name={d.type === '04' ? 'undo' : 'receipt'} /></span>}
                  title={<span className="num">{d.series}-{d.number}</span>}
                  meta={<>{d.issueTime.slice(0, 5)} · {t(d.typeName)}{d.customer?.name ? ` · ${d.customer.name}` : ''}</>}
                  amount={`${d.type === '04' ? '−' : ''}${money(d.totals.payable)}`}
                  end={<StatusBadge status={d.status} />}
                  onClick={() => setOpen(d.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
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
    <Sheet
      side
      title={doc ? `${t(doc.typeName)} ${doc.series}-${doc.number}` : t('Sale')}
      onClose={onClose}
      footer={doc && (printable || refundable) ? (
        <>
          {refundable && <Button variant="secondary" size="lg" icon="undo" onClick={() => setMode('refund')}>{t('Refund')}</Button>}
          {printable && <Button variant="primary" size="lg" icon="printer" onClick={() => void till.printDocument(doc.id, { copy: true }).catch((e) => toast(e instanceof Error ? e.message : String(e), 'bad'))}>{t('Print a copy')}</Button>}
        </>
      ) : undefined}
    >
      {!doc ? (error ? <ErrorText error={error} /> : <><Skeleton height="2rem" /><Skeleton height="8rem" /></>) : (
        <>
          <div className="sale-facts">
            <StatusBadge status={doc.status} />
            <span className="muted">{dmy(`${doc.issueDate}T00:00:00`)} {doc.issueTime.slice(0, 5)}{doc.issuedBy ? ` · ${doc.issuedBy}` : ''}</span>
          </div>
          <ul className="receipt-lines">
            {doc.lines.map((l) => (
              <li key={l.lineNumber}>
                <span className="what">{l.description}<span className="muted"> · {l.quantity} × {money(l.unitPrice)}</span></span>
                <span className="num">{money(l.total)}</span>
              </li>
            ))}
            <li className="total"><span>{t('Total')}</span><span className="num">{money(doc.totals.payable)}</span></li>
            {doc.credit && doc.credit.credited !== '0.00' && <li className="credited"><span>{t('Already refunded')}</span><span className="num">−{money(doc.credit.credited)}</span></li>}
          </ul>
          {printable && till.can('documents.send') && (
            <form className="email-row" onSubmit={(e) => void send(e)}>
              <input type="email" inputMode="email" autoComplete="email" aria-label={t('Email the receipt to')} placeholder={t('customer@example.com')} value={email} onChange={(e) => setEmail(e.target.value)} required />
              <Button type="submit" variant="secondary" icon="note" loading={busy}>{t('Email it')}</Button>
            </form>
          )}
          <ErrorText error={error} />
        </>
      )}
    </Sheet>
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
  // The usual reasons, one tap each; anything else can be typed.
  const reasons = [t('Returned'), t('Wrong item'), t('Damaged'), t('Changed their mind')];

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
    <Sheet side title={t('Refund {number}', { number: `${doc.series}-${doc.number}` })} onClose={onClose}>
      <form className="refund-form" onSubmit={(e) => void submit(e)}>
        <p className="muted">{t('A credit note goes to BTS for what you give back. Set a quantity to 0 to keep that item out.')}</p>
        <ul className="refund-lines">
          {doc.lines.map((l) => {
            const whole = Number.isInteger(Number(l.quantity));
            const n = qty[l.lineNumber] ?? '';
            return (
              <li key={l.lineNumber} className={Number(n || 0) > 0 ? '' : 'is-kept'}>
                <span className="what">{l.description}<span className="muted">{t('{n} sold', { n: l.quantity })} · {money(l.unitPrice)}</span></span>
                {whole
                  ? <Stepper label={t('Quantity to refund of {name}', { name: l.description })} value={Number(n || 0)} min={0} max={Number(l.quantity)} onChange={(v) => setQty({ ...qty, [l.lineNumber]: String(v) })} />
                  : <input className="qty-input" inputMode="decimal" aria-label={t('Quantity to refund of {name}', { name: l.description })} value={n} onChange={(e) => setQty({ ...qty, [l.lineNumber]: e.target.value.replace(/[^\d.]/g, '') })} />}
                {l.gstCategory === 'E' && Number(n || 0) > 0 && (
                  <input className="exemption" aria-label={t('Exemption reason code for {name}', { name: l.description })} placeholder={t('Exemption reason code')} value={exemption[l.lineNumber] ?? ''} onChange={(e) => setExemption({ ...exemption, [l.lineNumber]: e.target.value })} />
                )}
              </li>
            );
          })}
        </ul>
        <fieldset className="pos-field">
          <legend>{t('Reason')}</legend>
          <div className="chip-row">{reasons.map((r) => <Chip key={r} pressed={reason === r} onClick={() => setReason(r)}>{r}</Chip>)}</div>
          <input aria-label={t('Reason')} required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('Or type the reason')} />
        </fieldset>
        <fieldset className="pos-field">
          <legend>{t('Paid back by')}</legend>
          <div className="chip-row" role="group" aria-label={t('Paid back by')}>
            {PAYMENT_MEANS.slice(0, 3).map(([c, n]) => <Chip key={c} icon={c === '10' ? 'cash' : c === '48' ? 'card' : 'transfer'} pressed={meansCode === c} onClick={() => setMeansCode(c)}>{t(n)}</Chip>)}
          </div>
        </fieldset>
        <div className="refund-amount"><span>{t('Back to the customer')}</span><strong className="num">{t('About {amount}', { amount: money(fromCents(estimate)) })}</strong></div>
        <ErrorText error={error} />
        <div className="pos-sheet-foot">
          <Button variant="quiet" size="lg" onClick={onClose}>{t('Back')}</Button>
          <Button type="submit" variant="primary" size="lg" icon="undo" loading={busy} disabled={!valid}>{busy ? t('Signing and sending…') : t('Issue the refund')}</Button>
        </div>
      </form>
    </Sheet>
  );
}
