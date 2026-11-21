import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, type Customer, type DocumentInfo, type Item, type Page } from '../api';
import { useSession } from '../session';
import { DISTRICTS, ErrorText, Field, GST_CATEGORIES, money, PAYMENT_MEANS, UNITS, useDebounced } from '../ui';

type DocType = '01' | '02' | '03' | '04';
const TYPE_NAMES: Record<DocType, string> = { '01': 'Tax invoice', '02': 'Tax receipt', '03': 'Debit note', '04': 'Credit note' };

interface Line {
  key: number;
  itemId?: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode: string;
  discountPercent: string;
}

let lineKey = 0;
const emptyLine = (): Line => ({ key: ++lineKey, description: '', quantity: '1', unitCode: 'H87', unitPrice: '', gstCategory: 'S', exemptionReasonCode: '', discountPercent: '' });
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const lineReady = (l: Line) => l.description.trim() && DECIMAL.test(l.quantity) && Number(l.quantity) > 0 && DECIMAL.test(l.unitPrice) && (l.gstCategory !== 'E' || l.exemptionReasonCode.trim());

function addDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000 - 6 * 3_600_000); // Belize time
  return d.toISOString().slice(0, 10);
}

/** Type-ahead over saved customers or catalog items. */
function Search<T extends { id: string }>(props: { placeholder: string; search: (q: string) => Promise<T[]>; label: (t: T) => string; onPick: (t: T) => void; value?: string; onText?: (v: string) => void }) {
  const [text, setText] = useState(props.value ?? '');
  const [results, setResults] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const q = useDebounced(text, 250);
  useEffect(() => setText(props.value ?? ''), [props.value]);
  useEffect(() => {
    if (!open || q.trim().length < 1) return setResults([]);
    let live = true;
    void props.search(q).then((r) => live && setResults(r));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  return (
    <div className="relative">
      <input
        placeholder={props.placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          props.onText?.(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className="suggestions">
          {results.map((r) => (
            <button type="button" key={r.id} onMouseDown={() => { props.onPick(r); setOpen(false); }}>{props.label(r)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewDocument() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialType = (['01', '02', '03', '04'].includes(params.get('type') ?? '') ? params.get('type') : '01') as DocType;
  const refId = params.get('ref');

  const [type, setType] = useState<DocType>(initialType);
  const [reference, setReference] = useState<DocumentInfo | null>(null);
  const [reason, setReason] = useState('');
  const [customerMode, setCustomerMode] = useState<'saved' | 'new' | 'walkin'>(initialType === '02' ? 'walkin' : 'saved');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState({ name: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '', save: true });
  const [receiptTin, setReceiptTin] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [meansCode, setMeansCode] = useState(initialType === '02' ? '10' : '30');
  const [dueDate, setDueDate] = useState(addDays(30));
  const [terms, setTerms] = useState(initialType === '02' ? '' : 'Net 30');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ totals: DocumentInfo['totals']; lines: Array<{ total: string }> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // One key per form: a retry after a timeout or a double click never issues twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => setType(initialType), [initialType]);

  // A credit or debit note starts from the original document.
  useEffect(() => {
    if (!refId) return;
    void api<DocumentInfo>(`/v1/documents/${refId}`).then((d) => {
      setReference(d);
      if (d.customerId) {
        void api<Customer>(`/v1/customers/${d.customerId}`).then(setCustomer);
        setCustomerMode('saved');
      } else if (d.customer?.name) {
        setCustomerMode('new');
        setNewCustomer((c) => ({ ...c, name: d.customer?.name ?? '', tin: d.customer?.tin ?? '', save: false }));
      }
    });
  }, [refId]);

  const isNote = type === '03' || type === '04';
  const needsCustomer = type !== '02';
  const updateLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const linesBody = lines.filter(lineReady).map((l) => ({
    ...(l.itemId && { itemId: l.itemId }),
    description: l.description.trim(),
    quantity: l.quantity,
    unitCode: l.unitCode,
    unitPrice: l.unitPrice,
    gstCategory: l.gstCategory,
    ...(l.gstCategory === 'E' && { exemptionReasonCode: l.exemptionReasonCode.trim() }),
    ...(DECIMAL.test(l.discountPercent) && Number(l.discountPercent) > 0 && { allowanceCharges: [{ isCharge: false, reason: `Discount ${l.discountPercent}%`, percent: l.discountPercent }] }),
  }));

  // Live totals from the server's own calculation.
  const previewKey = useDebounced(JSON.stringify(linesBody), 350);
  useEffect(() => {
    const body = JSON.parse(previewKey) as typeof linesBody;
    if (body.length === 0) return setPreview(null);
    let live = true;
    void api<typeof preview>('/v1/documents/preview', { method: 'POST', body: { type, lines: body } })
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [previewKey, type]);

  const readyCount = linesBody.length;
  const canIssue = useMemo(() => {
    if (readyCount === 0 || readyCount !== lines.length) return false;
    if (needsCustomer && customerMode === 'saved' && !customer) return false;
    if (needsCustomer && customerMode === 'walkin') return false;
    if (customerMode === 'new' && (!newCustomer.name.trim() || (needsCustomer && (!newCustomer.street || !newCustomer.city)))) return false;
    if (isNote && (!reference || !reason.trim())) return false;
    return Boolean(me?.certificate);
  }, [readyCount, lines.length, needsCustomer, customerMode, customer, newCustomer, isNote, reference, reason, me]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let customerPart: Record<string, unknown> = {};
      if (customerMode === 'saved' && customer) customerPart = { customerId: customer.id };
      if (customerMode === 'walkin' && receiptTin.trim()) customerPart = { customer: { tin: receiptTin.trim() } };
      if (customerMode === 'new') {
        const c = newCustomer;
        const inline = {
          name: c.name.trim(),
          ...(c.tin && { tin: c.tin }),
          ...(c.street && c.city && { address: { street: c.street, city: c.city, districtCode: c.districtCode } }),
          ...((c.telephone || c.email) && { contact: { ...(c.telephone && { telephone: c.telephone }), ...(c.email && { email: c.email }) } }),
        };
        if (c.save) {
          const saved = await api<Customer>('/v1/customers', { method: 'POST', body: inline });
          customerPart = { customerId: saved.id };
        } else {
          customerPart = { customer: inline };
        }
      }
      const payment = type === '02'
        ? { meansCode, terms: terms || `Paid by ${PAYMENT_MEANS.find(([c]) => c === meansCode)?.[1].toLowerCase()}` }
        : { meansCode, dueDate, ...(terms && { terms }) };
      const doc = await api<DocumentInfo>('/v1/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          type,
          ...customerPart,
          lines: linesBody,
          payment,
          ...(note.trim() && { note: note.trim() }),
          ...(isNote && reference && { reference: { documentId: reference.id, reason: reason.trim() } }),
        },
      });
      setIdempotencyKey(crypto.randomUUID());
      navigate(`/documents/${doc.id}`, { state: { justIssued: true }, viewTransition: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row">
        <div><span className="kicker">Issue</span><h1>New {TYPE_NAMES[type].toLowerCase()}</h1></div>
        <span className="spacer" />
        {!isNote && (
          <div className="tabs" role="tablist" aria-label="Document type">
            {(['01', '02'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={type === t} className={type === t ? 'active' : ''} onClick={() => {
                setType(t);
                setCustomerMode(t === '02' ? 'walkin' : 'saved');
                setMeansCode(t === '02' ? '10' : '30');
                setTerms(t === '02' ? '' : 'Net 30');
              }}>{TYPE_NAMES[t]}</button>
            ))}
          </div>
        )}
      </div>

      {!me?.certificate && <div className="banner bad"><div><strong>Install your BTS certificate in Settings before issuing.</strong></div></div>}
      {me?.contingency.active && <div className="banner warn"><div><strong>BTS is unreachable.</strong>This document will be issued as "Pending of BTS authorization" and sent automatically when BTS is back.</div></div>}

      {isNote && (
        <fieldset className="stack">
          <legend>{type === '04' ? 'Credit' : 'Debit'} note for</legend>
          {reference ? <p><strong>{reference.typeName} {reference.series}-{reference.number}</strong> of {reference.issueDate}, {money(reference.totals.payable)}</p> : <p className="muted">Loading the original document…</p>}
          <Field label="Reason" hint="Shown on the document, e.g. 'Returned 1 item' or 'Price correction'."><input required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </fieldset>
      )}

      <fieldset className="stack">
        <legend>Customer</legend>
        <div className="tabs" role="tablist">
          <button type="button" className={customerMode === 'saved' ? 'active' : ''} onClick={() => setCustomerMode('saved')}>Saved customer</button>
          <button type="button" className={customerMode === 'new' ? 'active' : ''} onClick={() => setCustomerMode('new')}>New customer</button>
          {type === '02' && <button type="button" className={customerMode === 'walkin' ? 'active' : ''} onClick={() => setCustomerMode('walkin')}>Walk-in</button>}
        </div>
        {customerMode === 'saved' && (
          <>
            <Search<Customer>
              placeholder="Search by name or TIN"
              search={(q) => api<Page<Customer>>(`/v1/customers?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data)}
              label={(c) => `${c.name}${c.tin ? ` · TIN ${c.tin}` : ''}`}
              onPick={setCustomer}
              value={customer?.name ?? ''}
            />
            {customer && <p className="small muted">{[customer.tin && `TIN ${customer.tin}`, customer.address && `${customer.address.street}, ${customer.address.city}`].filter(Boolean).join(' · ')}</p>}
            {needsCustomer && !customer && <p className="small muted">A tax invoice must name the customer. No saved customer? Choose "New customer".</p>}
          </>
        )}
        {customerMode === 'new' && (
          <div className="stack">
            <div className="form-grid">
              <Field label="Name"><input required value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} /></Field>
              <Field label="TIN" hint="If they are GST-registered."><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={newCustomer.tin} onChange={(e) => setNewCustomer({ ...newCustomer, tin: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Street"><input required={needsCustomer} value={newCustomer.street} onChange={(e) => setNewCustomer({ ...newCustomer, street: e.target.value })} /></Field>
              <Field label="City or town"><input required={needsCustomer} value={newCustomer.city} onChange={(e) => setNewCustomer({ ...newCustomer, city: e.target.value })} /></Field>
              <Field label="District">
                <select value={newCustomer.districtCode} onChange={(e) => setNewCustomer({ ...newCustomer, districtCode: e.target.value })}>
                  {DISTRICTS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Telephone"><input type="tel" value={newCustomer.telephone} onChange={(e) => setNewCustomer({ ...newCustomer, telephone: e.target.value })} /></Field>
              <Field label="Email"><input type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} /></Field>
            </div>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={newCustomer.save} onChange={(e) => setNewCustomer({ ...newCustomer, save: e.target.checked })} /> Save to my customers</label>
          </div>
        )}
        {customerMode === 'walkin' && (
          <Field label="Customer TIN (optional)" hint="Only if the customer asks for their TIN on the receipt.">
            <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={receiptTin} onChange={(e) => setReceiptTin(e.target.value)} style={{ maxWidth: 200 }} />
          </Field>
        )}
      </fieldset>

      <fieldset>
        <legend>Items</legend>
        {lines.map((l, i) => (
          <div className="line-editor" key={l.key}>
            <div className="desc">
              <Field label={`Item ${i + 1}`}>
                <Search<Item>
                  placeholder="Type to search your items, or describe it"
                  search={(q) => api<Page<Item>>('/v1/items?limit=50').then((r) => r.data.filter((it) => `${it.name} ${it.description} ${it.sellerCode ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8))}
                  label={(it) => `${it.name} · ${money(it.unitPrice)}`}
                  value={l.description}
                  onText={(v) => updateLine(l.key, { description: v, itemId: undefined })}
                  onPick={(it) => updateLine(l.key, { itemId: it.id, description: it.description, unitCode: it.unitCode, unitPrice: it.unitPrice, gstCategory: it.gstCategory, exemptionReasonCode: it.exemptionReasonCode ?? '' })}
                />
              </Field>
            </div>
            <Field label="Qty"><input inputMode="decimal" value={l.quantity} aria-invalid={l.quantity !== '' && !DECIMAL.test(l.quantity)} onChange={(e) => updateLine(l.key, { quantity: e.target.value })} /></Field>
            <Field label="Unit">
              <select value={l.unitCode} onChange={(e) => updateLine(l.key, { unitCode: e.target.value })}>
                {UNITS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                {!UNITS.some(([c]) => c === l.unitCode) && <option value={l.unitCode}>{l.unitCode}</option>}
              </select>
            </Field>
            <Field label="Price (BZ$)"><input inputMode="decimal" placeholder="0.00" value={l.unitPrice} aria-invalid={l.unitPrice !== '' && !DECIMAL.test(l.unitPrice)} onChange={(e) => updateLine(l.key, { unitPrice: e.target.value, itemId: undefined })} /></Field>
            <Field label="GST">
              <select value={l.gstCategory} onChange={(e) => updateLine(l.key, { gstCategory: e.target.value as Line['gstCategory'] })}>
                {GST_CATEGORIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </Field>
            <Field label="Disc. %"><input inputMode="decimal" placeholder="0" value={l.discountPercent} onChange={(e) => updateLine(l.key, { discountPercent: e.target.value })} /></Field>
            <div className="row" style={{ alignSelf: 'end', paddingBottom: '0.3rem' }}>
              <span className="line-total">{preview?.lines[linesBody.findIndex((b) => b.description === l.description.trim())]?.total ? money(preview.lines[linesBody.findIndex((b) => b.description === l.description.trim())]!.total) : ''}</span>
              {lines.length > 1 && <button type="button" className="link" aria-label={`Remove item ${i + 1}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>Remove</button>}
            </div>
            {l.gstCategory === 'E' && (
              <div className="desc"><Field label="Exemption reason code" hint="Required for exempt items."><input value={l.exemptionReasonCode} onChange={(e) => updateLine(l.key, { exemptionReasonCode: e.target.value })} /></Field></div>
            )}
          </div>
        ))}
        <button type="button" className="secondary" style={{ marginTop: '0.75rem' }} onClick={() => setLines([...lines, emptyLine()])}>+ Add item</button>
      </fieldset>

      <div className="grid">
        <fieldset className="stack">
          <legend>Payment</legend>
          <Field label="Method">
            <select value={meansCode} onChange={(e) => setMeansCode(e.target.value)}>
              {PAYMENT_MEANS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </Field>
          {type !== '02' && <Field label="Due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>}
          <Field label="Terms" hint={type === '02' ? 'Optional.' : undefined}><input value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
          <Field label="Note" hint="Optional; printed on the document."><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </fieldset>
        <div className="card totals ticket stack">
          <span className="kicker" style={{ color: 'var(--lime)' }}>{TYPE_NAMES[type]} · BZD</span>
          <div><span>Subtotal</span><span>{money(preview?.totals.lineExtension ?? '0.00')}</span></div>
          <div><span>GST</span><span>{money(preview?.totals.gst ?? '0.00')}</span></div>
          {preview && preview.totals.tax !== preview.totals.gst && (
            <div><span>Other taxes</span><span>{money(String((Number(preview.totals.tax) - Number(preview.totals.gst)).toFixed(2)))}</span></div>
          )}
          <div className="grand"><span>Total</span><span>{money(preview?.totals.taxInclusive ?? '0.00')}</span></div>
          <ErrorText error={error} />
          <button type="submit" className="big lime" disabled={!canIssue || busy}>{busy ? 'Signing and sending…' : `Issue ${TYPE_NAMES[type].toLowerCase()}`}<span className="chip">→</span></button>
          <p className="small muted">Issuing signs the document and sends it to BTS for authorization.</p>
        </div>
      </div>
    </form>
  );
}
