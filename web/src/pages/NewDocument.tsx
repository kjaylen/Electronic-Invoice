import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, type BusinessProfile, type Customer, type DocumentDetailInfo, type DocumentInfo, type Item, type Page } from '../api';
import { DocumentPaper, type PaperParty, type PaperView } from '../paper';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeDate, Combobox, DISTRICTS, ErrorText, Field, GST_CATEGORIES, Modal, money, PAYMENT_MEANS, Segmented, store, toCents, TYPE_NAMES, UNITS, useDebounced, usePageTitle } from '../ui';

type DocType = '01' | '02' | '03' | '04';

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

type NewCustomer = { name: string; tin: string; street: string; city: string; districtCode: string; telephone: string; email: string; save: boolean };

interface Draft {
  savedAt: string;
  customerMode: 'saved' | 'new' | 'walkin';
  customer: Customer | null;
  newCustomer: NewCustomer;
  receiptTin: string;
  lines: Line[];
  meansCode: string;
  dueDate: string;
  terms: string;
  note: string;
  reason: string;
  idempotencyKey: string;
}

let lineKey = 0;
const emptyLine = (): Line => ({ key: ++lineKey, description: '', quantity: '1', unitCode: 'H87', unitPrice: '', gstCategory: 'S', exemptionReasonCode: '', discountPercent: '' });
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const lineReady = (l: Line) => Boolean(l.description.trim() && DECIMAL.test(l.quantity) && Number(l.quantity) > 0 && DECIMAL.test(l.unitPrice) && (l.gstCategory !== 'E' || l.exemptionReasonCode.trim()));
const EMPTY_CUSTOMER: NewCustomer = { name: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '', save: true };

export const searchItems = (q: string, limit = 8) => api<Page<Item>>(`/v1/items?limit=${limit}&q=${encodeURIComponent(q)}`).then((r) => r.data);

export function NewDocument() {
  const t = useT();
  const toast = useToast();
  const { me, session, can } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialType = (['01', '02', '03', '04'].includes(params.get('type') ?? '') ? params.get('type') : '01') as DocType;
  const refId = params.get('ref');
  const fromId = params.get('from');

  const [type, setType] = useState<DocType>(initialType);
  usePageTitle(t('New {type}', { type: t(TYPE_NAMES[type]!).toLowerCase() }));
  const [reference, setReference] = useState<DocumentDetailInfo | null>(null);
  const [reason, setReason] = useState('');
  const [customerMode, setCustomerMode] = useState<'saved' | 'new' | 'walkin'>(initialType === '02' ? 'walkin' : 'saved');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState<NewCustomer>(EMPTY_CUSTOMER);
  const [receiptTin, setReceiptTin] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()]);
  const [meansCode, setMeansCode] = useState(initialType === '02' ? '10' : '30');
  const [dueDate, setDueDate] = useState(belizeDate(30));
  const [terms, setTerms] = useState(initialType === '02' ? '' : 'Net 30');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ totals: DocumentInfo['totals']; lines: Array<{ net: string; tax: string; total: string }> } | null>(null);
  const [showPaper, setShowPaper] = useState(false);
  const [business, setBusiness] = useState<BusinessProfile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // One key per form: a retry after a timeout or a double click never issues twice.
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [restored, setRestored] = useState<string | null>(null);
  const lineInputs = useRef(new Map<number, HTMLInputElement>());
  const focusLine = useRef<number | null>(null);

  const draftKey = `etd.draft.${session?.business.id}.${session?.user.id}.${type}${refId ? `.ref.${refId}` : ''}`;

  useEffect(() => {
    setType(initialType);
  }, [initialType]);

  // Restore an unfinished draft for this business and document type (kept on this device).
  useEffect(() => {
    if (fromId) return;
    const d = store.get<Draft>(draftKey);
    if (!d || !d.lines?.length) return;
    lineKey = Math.max(lineKey, ...d.lines.map((l) => l.key));
    setCustomerMode(d.customerMode);
    setCustomer(d.customer);
    setNewCustomer(d.newCustomer);
    setReceiptTin(d.receiptTin);
    setLines(d.lines);
    setMeansCode(d.meansCode);
    setDueDate(d.dueDate);
    setTerms(d.terms);
    setNote(d.note);
    setReason(d.reason);
    setIdempotencyKey(d.idempotencyKey);
    setRestored(d.savedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const dirty = lines.some((l) => l.description.trim() || l.unitPrice) || Boolean(customer) || Boolean(newCustomer.name) || Boolean(note);
  const draftState = JSON.stringify({ customerMode, customer, newCustomer, receiptTin, lines, meansCode, dueDate, terms, note, reason, idempotencyKey });
  const debouncedDraft = useDebounced(draftState, 500);
  useEffect(() => {
    if (!session || !dirty) return;
    store.set(draftKey, { ...JSON.parse(debouncedDraft), savedAt: new Date().toISOString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDraft]);

  const discardDraft = () => {
    store.remove(draftKey);
    setRestored(null);
    setCustomer(null);
    setNewCustomer(EMPTY_CUSTOMER);
    setReceiptTin('');
    setLines([emptyLine()]);
    setNote('');
    setReason('');
    setIdempotencyKey(crypto.randomUUID());
  };

  // A credit or debit note starts from the original document; a credit note also starts with its lines
  // (what was sold, at the price charged), for the merchant to trim to what is being credited.
  useEffect(() => {
    if (!refId) return;
    void api<DocumentDetailInfo>(`/v1/documents/${refId}`).then((d) => {
      setReference(d);
      if (initialType === '04' && d.lines.length) {
        const copied = d.lines.map((l) => {
          const listed = Number(l.quantity) * Number(l.unitPrice);
          // A discounted line: the price actually charged per unit, never more.
          const unitPrice = Math.abs(listed - Number(l.net)) >= 0.005 ? String(Math.floor((Number(l.net) / Number(l.quantity)) * 1e6) / 1e6) : l.unitPrice;
          return { key: ++lineKey, description: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice, gstCategory: l.gstCategory, exemptionReasonCode: '', discountPercent: '' };
        });
        setLines((ls) => (ls.every((l) => !l.description.trim()) ? copied : ls));
        if (d.lines.some((l) => l.gstCategory === 'E')) setError(new Error(t('Exempt items need their exemption reason code again.')));
      }
      if (d.customerId) {
        void api<Customer>(`/v1/customers/${d.customerId}`).then(setCustomer);
        setCustomerMode('saved');
      } else if (d.customer?.name) {
        setCustomerMode('new');
        setNewCustomer((c) => ({ ...c, name: d.customer?.name ?? '', tin: d.customer?.tin ?? '', save: false }));
      }
    });
  }, [refId, initialType, t]);

  // "Issue again": same customer and lines as an earlier document.
  useEffect(() => {
    if (!fromId) return;
    void api<DocumentDetailInfo>(`/v1/documents/${fromId}`).then((d) => {
      setLines(d.lines.map((l) => ({ key: ++lineKey, description: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice: l.unitPrice, gstCategory: l.gstCategory, exemptionReasonCode: '', discountPercent: '' })));
      if (d.customerId) {
        void api<Customer>(`/v1/customers/${d.customerId}`).then((c) => {
          setCustomer(c);
          setCustomerMode('saved');
        });
      } else if (d.customer?.name) {
        setCustomerMode('new');
        setNewCustomer((c) => ({ ...c, name: d.customer?.name ?? '', tin: d.customer?.tin ?? '', save: false }));
      } else if (d.customer?.tin) {
        setReceiptTin(d.customer.tin);
      }
      if (d.lines.some((l) => l.gstCategory === 'E')) setError(new Error(t('Exempt items need their exemption reason code again.')));
    }).catch(setError);
  }, [fromId, t]);

  useEffect(() => {
    if (focusLine.current !== null) {
      lineInputs.current.get(focusLine.current)?.focus();
      focusLine.current = null;
    }
  }, [lines]);

  const isNote = type === '03' || type === '04';
  const needsCustomer = type !== '02';
  const updateLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    const l = emptyLine();
    focusLine.current = l.key;
    setLines((ls) => [...ls, l]);
  };

  const ready = lines.filter(lineReady);
  const linesBody = ready.map((l) => ({
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
  const lineTotal = (l: Line) => {
    const i = ready.indexOf(l);
    const total = i >= 0 ? preview?.lines[i]?.total : undefined;
    return total ? money(total) : '';
  };

  // A credit note may not take off more than is left on the original (the server checks too).
  const overCredit = type === '04' && Boolean(reference?.credit && preview) && toCents(preview!.totals.taxInclusive) > toCents(reference!.credit!.remaining);

  // The paper preview of the draft: the business from its profile, the customer and lines from the form.
  const openPaper = () => {
    setShowPaper(true);
    if (!business) void api<BusinessProfile>('/v1/business').then(setBusiness).catch(() => {});
  };
  const draftView = (): PaperView => {
    const district = (code: string) => DISTRICTS.find(([c]) => c === code)?.[1] ?? '';
    const issuer: PaperParty = business
      ? { name: business.tradeName ?? business.legalName, tin: business.tin, addressLines: [business.address.street, [business.address.city, district(business.address.districtCode)].filter(Boolean).join(', ')], telephone: business.contact.telephone, email: business.contact.email }
      : { name: session?.business.tradeName ?? session?.business.legalName ?? '', addressLines: [] };
    let customerParty: PaperParty | undefined;
    if (customerMode === 'saved' && customer) {
      customerParty = { name: customer.name, ...(customer.tin && { tin: customer.tin }), addressLines: customer.address ? [customer.address.street, [customer.address.city, district(customer.address.districtCode)].join(', ')] : [], ...(customer.contact.telephone && { telephone: customer.contact.telephone }), ...(customer.contact.email && { email: customer.contact.email }) };
    } else if (customerMode === 'new' && newCustomer.name.trim()) {
      customerParty = { name: newCustomer.name, ...(newCustomer.tin && { tin: newCustomer.tin }), addressLines: [newCustomer.street, [newCustomer.city, district(newCustomer.districtCode)].filter(Boolean).join(', ')].filter(Boolean), ...(newCustomer.telephone && { telephone: newCustomer.telephone }), ...(newCustomer.email && { email: newCustomer.email }) };
    } else if (receiptTin.trim()) {
      customerParty = { tin: receiptTin.trim(), addressLines: [] };
    }
    const now = new Date(Date.now() - 6 * 3600_000).toISOString();
    return {
      etdType: type,
      typeName: TYPE_NAMES[type] ?? '',
      etdui: t('Assigned when issued'),
      series: '001',
      number: '·········',
      issueDate: now.slice(0, 10),
      issueTime: now.slice(11, 19),
      pendingAuthorization: false,
      testEnvironment: me?.environment === 'test',
      issuer,
      ...(customerParty && { customer: customerParty }),
      lines: ready.map((l, i) => ({
        number: String(i + 1), quantity: l.quantity, unitCode: l.unitCode, description: l.description.trim(), unitPrice: l.unitPrice,
        adjustments: DECIMAL.test(l.discountPercent) && Number(l.discountPercent) > 0 ? [{ reason: t('Discount {n}%', { n: l.discountPercent }), amount: '', isCharge: false }] : [],
        net: preview?.lines[i]?.net ?? '', tax: preview?.lines[i]?.tax ?? '', total: preview?.lines[i]?.total ?? '',
      })),
      totals: {
        taxExclusive: preview?.totals.lineExtension ?? '0.00', gst: preview?.totals.gst ?? '0.00', otherTaxes: [],
        taxInclusive: preview?.totals.taxInclusive ?? '0.00', payable: preview?.totals.payable ?? preview?.totals.taxInclusive ?? '0.00',
      },
      ...(isNote && reference && { reference: { etdui: reference.etdui, documentType: reference.type, reason: reason.trim() || '…' } }),
      ...(note.trim() && { note: note.trim() }),
      payment: { ...(type !== '02' && dueDate && { dueDate }), ...(terms.trim() && { terms: terms.trim() }) },
      regulatory: me?.environment === 'test' ? ['Transmitted to tests environment, no fiscal value'] : [],
    };
  };

  const canIssue = useMemo(() => {
    if (ready.length === 0 || ready.length !== lines.length) return false;
    if (needsCustomer && customerMode === 'saved' && !customer) return false;
    if (needsCustomer && customerMode === 'walkin') return false;
    if (customerMode === 'new' && (!newCustomer.name.trim() || (needsCustomer && (!newCustomer.street || !newCustomer.city)))) return false;
    if (isNote && (!reference || !reason.trim())) return false;
    if (overCredit) return false;
    return Boolean(me?.certificate);
  }, [ready.length, lines.length, needsCustomer, customerMode, customer, newCustomer, isNote, reference, reason, me, overCredit]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canIssue || busy) return;
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
          // If issuing fails, the retry uses the saved customer instead of creating a duplicate.
          setCustomer(saved);
          setCustomerMode('saved');
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
      store.remove(draftKey);
      setIdempotencyKey(crypto.randomUUID());
      navigate(`/documents/${doc.id}`, { state: { justIssued: true }, viewTransition: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const typeName = t(TYPE_NAMES[type]!);
  if (!can(isNote ? 'documents.adjust' : 'documents.issue')) return <Navigate to="/" replace />;
  return (
    <form className="stack" onSubmit={submit} onKeyDown={(e) => {
      // Ctrl+Enter (Cmd+Enter on a Mac) issues from anywhere in the form.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
    }}>
      <div className="row">
        <div><span className="kicker">{t('Issue')}</span><h1>{t('New {type}', { type: typeName.toLowerCase() })}</h1></div>
        <span className="spacer" />
        {!isNote && (
          <Segmented
            label={t('Document type')}
            value={type}
            options={[['01', t('Tax invoice')], ['02', t('Tax receipt')]]}
            onChange={(v) => {
              setType(v);
              setCustomerMode(v === '02' ? 'walkin' : 'saved');
              setMeansCode(v === '02' ? '10' : '30');
              setTerms(v === '02' ? '' : 'Net 30');
            }}
          />
        )}
      </div>

      {restored && (
        <div className="banner info" role="status">
          <div className="row" style={{ width: '100%' }}>
            <span><strong>{t('Draft restored')}</strong>{t('Saved on this device at {time}.', { time: new Date(restored).toLocaleTimeString() })}</span>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => { discardDraft(); toast(t('Draft discarded'), 'info'); }}>{t('Discard draft')}</button>
          </div>
        </div>
      )}
      {!me?.certificate && <div className="banner bad"><div><strong>{t('Install your BTS certificate in Settings before issuing.')}</strong></div></div>}
      {me?.contingency.active && <div className="banner warn"><div><strong>{t('BTS cannot be reached.')}</strong>{t('This document will be issued as "Pending of BTS authorization" and sent automatically when BTS is back.')}</div></div>}

      {isNote && (
        <fieldset className="stack">
          <legend>{type === '04' ? t('Credit note for') : t('Debit note for')}</legend>
          {reference ? <p><strong>{t(TYPE_NAMES[reference.type] ?? reference.typeName)} {reference.series}-{reference.number}</strong> · {reference.issueDate} · {money(reference.totals.payable)}</p> : <p className="muted">{t('Loading the original document…')}</p>}
          {type === '04' && reference?.credit && (
            <>
              <p className="small">
                {toCents(reference.credit.credited) > 0n
                  ? t('Already credited: {credited}. Left to credit: {left}.', { credited: money(reference.credit.credited), left: money(reference.credit.remaining) })
                  : t('Left to credit: {left}.', { left: money(reference.credit.remaining) })}
                {' '}{t('The lines below are copied from the original. Remove or reduce what is not being credited.')}
              </p>
              {overCredit && <div className="banner bad" role="alert"><div><strong>{t('This credit note is more than what is left to credit ({left}).', { left: money(reference.credit.remaining) })}</strong></div></div>}
            </>
          )}
          <Field label={t('Reason')} hint={t("Shown on the document, e.g. 'Returned 1 item' or 'Price correction'.")}><input required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </fieldset>
      )}

      <fieldset className="stack">
        <legend>{t('Customer')}</legend>
        <Segmented
          label={t('Customer')}
          value={customerMode}
          onChange={setCustomerMode}
          options={[['saved', t('Saved customer')], ['new', t('New customer')], ...(type === '02' ? [['walkin', t('Walk-in')] as ['walkin', string]] : [])]}
        />
        {customerMode === 'saved' && (
          <>
            <Combobox<Customer>
              label={t('Customer')}
              placeholder={t('Search by name or TIN')}
              search={(q) => api<Page<Customer>>(`/v1/customers?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data)}
              render={(c) => <><strong>{c.name}</strong>{c.tin && <span className="muted"> · TIN {c.tin}</span>}</>}
              onPick={setCustomer}
              value={customer?.name ?? ''}
            />
            {customer && <p className="small muted">{[customer.tin && `TIN ${customer.tin}`, customer.address && `${customer.address.street}, ${customer.address.city}`].filter(Boolean).join(' · ')}</p>}
            {needsCustomer && !customer && <p className="small muted">{t('A tax invoice must name the customer. No saved customer? Choose "New customer".')}</p>}
          </>
        )}
        {customerMode === 'new' && (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('Name')}><input required value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} /></Field>
              <Field label="TIN" hint={t('If they are GST-registered.')}><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={newCustomer.tin} onChange={(e) => setNewCustomer({ ...newCustomer, tin: e.target.value })} /></Field>
            </div>
            <div className="form-grid">
              <Field label={t('Street')}><input required={needsCustomer} value={newCustomer.street} onChange={(e) => setNewCustomer({ ...newCustomer, street: e.target.value })} /></Field>
              <Field label={t('City or town')}><input required={needsCustomer} value={newCustomer.city} onChange={(e) => setNewCustomer({ ...newCustomer, city: e.target.value })} /></Field>
              <Field label={t('District')}>
                <select value={newCustomer.districtCode} onChange={(e) => setNewCustomer({ ...newCustomer, districtCode: e.target.value })}>
                  {DISTRICTS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label={t('Telephone')}><input type="tel" value={newCustomer.telephone} onChange={(e) => setNewCustomer({ ...newCustomer, telephone: e.target.value })} /></Field>
              <Field label={t('Email')}><input type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} /></Field>
            </div>
            <label className="row small"><input type="checkbox" checked={newCustomer.save} onChange={(e) => setNewCustomer({ ...newCustomer, save: e.target.checked })} /> {t('Save to my customers')}</label>
          </div>
        )}
        {customerMode === 'walkin' && (
          <Field label={t('Customer TIN (optional)')} hint={t('Only if the customer asks for their TIN on the receipt.')}>
            <input inputMode="numeric" pattern="\d{6}" maxLength={6} value={receiptTin} onChange={(e) => setReceiptTin(e.target.value)} style={{ maxWidth: 200 }} />
          </Field>
        )}
      </fieldset>

      <fieldset>
        <legend>{t('Items')}</legend>
        {lines.map((l, i) => (
          <div className="line-editor" key={l.key}>
            <div className="desc">
              <Field label={t('Item {n}', { n: i + 1 })}>
                <Combobox<Item>
                  inputRef={(el) => {
                    if (el) lineInputs.current.set(l.key, el);
                    else lineInputs.current.delete(l.key);
                  }}
                  placeholder={t('Search your items, scan a barcode, or describe it')}
                  search={(q) => searchItems(q)}
                  render={(it) => <><strong>{it.name}</strong> <span className="muted">· {money(it.unitPrice)}{it.sellerCode && ` · ${it.sellerCode}`}</span></>}
                  value={l.description}
                  onText={(v) => updateLine(l.key, { description: v, itemId: undefined })}
                  onPick={(it) => updateLine(l.key, { itemId: it.id, description: it.description, unitCode: it.unitCode, unitPrice: it.unitPrice, gstCategory: it.gstCategory, exemptionReasonCode: it.exemptionReasonCode ?? '' })}
                  onEnter={async (code) => {
                    const [hit] = (await api<Page<Item>>(`/v1/items?limit=1&code=${encodeURIComponent(code)}`)).data;
                    if (hit) updateLine(l.key, { itemId: hit.id, description: hit.description, unitCode: hit.unitCode, unitPrice: hit.unitPrice, gstCategory: hit.gstCategory, exemptionReasonCode: hit.exemptionReasonCode ?? '' });
                  }}
                />
              </Field>
            </div>
            <Field label={t('Qty')}><input inputMode="decimal" value={l.quantity} aria-invalid={l.quantity !== '' && !DECIMAL.test(l.quantity)} onChange={(e) => updateLine(l.key, { quantity: e.target.value })} /></Field>
            <Field label={t('Unit')}>
              <select value={l.unitCode} onChange={(e) => updateLine(l.key, { unitCode: e.target.value })}>
                {UNITS.map(([code, name]) => <option key={code} value={code}>{t(name)}</option>)}
                {!UNITS.some(([c]) => c === l.unitCode) && <option value={l.unitCode}>{l.unitCode}</option>}
              </select>
            </Field>
            <Field label={t('Price (BZ$)')}><input inputMode="decimal" placeholder="0.00" value={l.unitPrice} aria-invalid={l.unitPrice !== '' && !DECIMAL.test(l.unitPrice)} onChange={(e) => updateLine(l.key, { unitPrice: e.target.value, itemId: undefined })} /></Field>
            <Field label="GST">
              <select value={l.gstCategory} onChange={(e) => updateLine(l.key, { gstCategory: e.target.value as Line['gstCategory'] })}>
                {GST_CATEGORIES.map(([code, name]) => <option key={code} value={code}>{t(name)}</option>)}
              </select>
            </Field>
            <Field label={t('Disc. %')}><input inputMode="decimal" placeholder="0" value={l.discountPercent} onChange={(e) => updateLine(l.key, { discountPercent: e.target.value })} /></Field>
            <div className="row" style={{ alignSelf: 'end', paddingBottom: '0.3rem' }}>
              <span className="line-total" aria-live="polite">{lineTotal(l)}</span>
              {lines.length > 1 && <button type="button" className="link" aria-label={t('Remove item {n}', { n: i + 1 })} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>{t('Remove')}</button>}
            </div>
            {l.gstCategory === 'E' && (
              <div className="desc"><Field label={t('Exemption reason code')} hint={t('Required for exempt items.')}><input value={l.exemptionReasonCode} onChange={(e) => updateLine(l.key, { exemptionReasonCode: e.target.value })} /></Field></div>
            )}
          </div>
        ))}
        <button type="button" className="secondary" style={{ marginTop: '0.75rem' }} onClick={addLine}>+ {t('Add item')}</button>
      </fieldset>

      <div className="grid">
        <fieldset className="stack">
          <legend>{t('Payment')}</legend>
          <Field label={t('Method')}>
            <select value={meansCode} onChange={(e) => setMeansCode(e.target.value)}>
              {PAYMENT_MEANS.map(([code, name]) => <option key={code} value={code}>{t(name)}</option>)}
            </select>
          </Field>
          {type !== '02' && <Field label={t('Due date')}><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>}
          <Field label={t('Terms')} hint={type === '02' ? t('Optional.') : undefined}><input value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
          <Field label={t('Note')} hint={t('Optional; printed on the document.')}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </fieldset>
        <div className="card totals ticket stack">
          <span className="kicker" style={{ color: 'var(--lime)' }}>{typeName} · BZD</span>
          <div><span>{t('Subtotal')}</span><span>{money(preview?.totals.lineExtension ?? '0.00')}</span></div>
          <div><span>GST</span><span>{money(preview?.totals.gst ?? '0.00')}</span></div>
          {preview && preview.totals.tax !== preview.totals.gst && (
            <div><span>{t('Other taxes')}</span><span>{money(String((Number(preview.totals.tax) - Number(preview.totals.gst)).toFixed(2)))}</span></div>
          )}
          <div className="grand"><span>{t('Total')}</span><span aria-live="polite">{money(preview?.totals.taxInclusive ?? '0.00')}</span></div>
          <ErrorText error={error} />
          <button type="button" className="secondary paper-preview-button" disabled={ready.length === 0} onClick={openPaper}>{t('Preview the document')}</button>
          <button type="submit" className="big lime" disabled={!canIssue || busy}>{busy ? t('Signing and sending…') : t('Issue {type}', { type: typeName.toLowerCase() })}<span className="chip" aria-hidden="true">→</span></button>
          <p className="small muted">{t('Issuing signs the document and sends it to BTS for authorization.')} <kbd>Ctrl</kbd>+<kbd>Enter</kbd></p>
        </div>
      </div>
      {showPaper && (
        <Modal title={t('Preview: {type}', { type: typeName })} onClose={() => setShowPaper(false)} wide>
          <div className="paper-stage paper-stage-modal">
            <DocumentPaper data={{ view: draftView(), status: 'draft', protocolNumber: null, qr: null }} />
          </div>
          <p className="small muted">{t('This is how the document will look. The number, the document ID and the BTS authorization are added when it is issued.')}</p>
        </Modal>
      )}
    </form>
  );
}
