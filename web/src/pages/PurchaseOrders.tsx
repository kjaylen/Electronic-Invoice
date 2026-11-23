/**
 * Purchase orders: the list (Inventory → Orders), writing one (with the items running low filled in),
 * and one order's page: send it to the supplier, print it, receive what arrives, close it.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Item, link, type Page } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeDate, Combobox, ErrorText, Field, fromCents, Modal, money, Segmented, unitName, useDebounced, usePageTitle } from '../ui';

type PoStatus = 'draft' | 'sent' | 'partial' | 'received' | 'cancelled';
interface PoLine { lineNumber: number; itemId: string; description: string; code: string | null; unitCode: string; quantity: string; received: string; remaining: string; unitCost: string; total: string }
export interface PurchaseOrder {
  id: string;
  number: string;
  status: PoStatus;
  supplier: { id: string | null; name: string; email: string | null };
  expectedOn: string | null;
  late: boolean;
  note: string | null;
  total: string;
  sentAt: string | null;
  createdAt: string;
  createdBy: string | null;
  lines: PoLine[];
  receipts?: Array<{ id: string; receivedOn: string; reference: string | null; totalCost: string; expenseId: string | null }>;
}
type PoSummary = Omit<PurchaseOrder, 'lines'> & { lineCount: number; progress: number };
interface Suggestion { itemId: string; name: string; code: string | null; unitCode: string; stock: string; lowStock: string | null; soldLast30Days: string; onOrder: string; quantity: string; unitCost: string | null; supplier: { id: string | null; name: string; email: string | null } | null }
interface SupplierLite { id: string; name: string; tin: string | null; email?: string | null }

/** The day in Belize (UTC−6) of a moment. */
const belizeDay = (iso: string) => new Date(Date.parse(iso) - 6 * 3600_000).toISOString().slice(0, 10);
const PO_STATUS: Record<PoStatus, string> = { draft: 'Draft', sent: 'Sent', partial: 'Part received', received: 'Received', cancelled: 'Cancelled' };
const OPEN: PoStatus[] = ['draft', 'sent', 'partial'];

export function PoBadge(props: { po: { status: PoStatus; late?: boolean } }) {
  const t = useT();
  return (
    <span className="badges row">
      <span className={`badge po-${props.po.status}`}>{t(PO_STATUS[props.po.status])}</span>
      {props.po.late && <span className="badge po-late">{t('Late')}</span>}
    </span>
  );
}

/** Inventory → Orders. */
export function PurchaseOrderList() {
  const t = useT();
  const [status, setStatus] = useState<'open' | 'received' | 'cancelled' | ''>('open');
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const [rows, setRows] = useState<PoSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setRows(null);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (search.trim()) qs.set('q', search.trim());
    api<{ data: PoSummary[] }>(`/v1/purchase-orders?${qs}`).then((r) => setRows(r.data)).catch(setError);
  }, [status, search]);
  return (
    <section className="card stack">
      <div className="row">
        <Segmented label={t('Show')} value={status} onChange={(v) => setStatus(v)} options={[['open', t('Open')], ['received', t('Received')], ['cancelled', t('Cancelled')], ['', t('All')]]} />
        <span className="spacer" />
        <input type="search" className="search-input" placeholder={t('Supplier or PO number')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search orders')} />
      </div>
      <ErrorText error={error} />
      {!rows ? <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? (
        <div className="empty">{status === 'open' ? t('No open orders.') : t('No orders.')} <Link to="/inventory/orders/new?suggest=1">{t('Order what is running low')}</Link></div>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Order')}</th><th scope="col">{t('Supplier')}</th><th scope="col">{t('Wanted by')}</th><th scope="col">{t('Received')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Status')}</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td data-label={t('Order')}><Link className="strong mono" to={`/inventory/orders/${p.id}`} viewTransition>{p.number}</Link><div className="small muted">{p.lineCount === 1 ? t('1 item') : t('{n} items', { n: p.lineCount })}</div></td>
                  <td data-label={t('Supplier')}>{p.supplier.name}</td>
                  <td data-label={t('Wanted by')}>{p.expectedOn ?? '—'}</td>
                  <td data-label={t('Received')}><span className="share"><span className="share-bar" style={{ width: `${Math.round(p.progress * 100)}%` }} /><span className="small muted num">{Math.round(p.progress * 100)}%</span></span></td>
                  <td data-label={t('Total')} className="right">{money(p.total)}</td>
                  <td data-label={t('Status')}><PoBadge po={p} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- writing an order ----------

interface EditLine { key: number; item: Pick<Item, 'id' | 'name'> | null; quantity: string; unitCost: string; hint?: string }
let lineKey = 0;
const QTY = /^\d{1,12}(\.\d{1,3})?$/;
const COST = /^\d{1,15}(\.\d{1,6})?$/;
const blank = (): EditLine => ({ key: ++lineKey, item: null, quantity: '', unitCost: '' });

export function PurchaseOrderEditor() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  usePageTitle(id ? t('Edit order') : t('New purchase order'));
  const [loaded, setLoaded] = useState(!id);
  const [supplier, setSupplier] = useState<SupplierLite | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [email, setEmail] = useState('');
  const [expectedOn, setExpectedOn] = useState(belizeDate(7));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<EditLine[]>(() => [blank()]);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [number, setNumber] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<PurchaseOrder>(`/v1/purchase-orders/${id}`).then((po) => {
      setNumber(po.number);
      if (po.supplier.id) setSupplier({ id: po.supplier.id, name: po.supplier.name, tin: null, email: po.supplier.email });
      setSupplierName(po.supplier.name);
      setEmail(po.supplier.email ?? '');
      setExpectedOn(po.expectedOn ?? '');
      setNote(po.note ?? '');
      setLines(po.lines.map((l) => ({ key: ++lineKey, item: { id: l.itemId, name: l.description }, quantity: l.quantity, unitCost: l.unitCost })));
      setLoaded(true);
    }).catch(setError);
  }, [id]);

  const update = (key: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const lineCents = (l: EditLine) => (QTY.test(l.quantity) && COST.test(l.unitCost) ? BigInt(Math.round(Number(l.quantity) * Number(l.unitCost) * 100)) : 0n);
  const total = lines.reduce((a, l) => a + lineCents(l), 0n);
  const filled = lines.filter((l) => l.item || l.quantity || l.unitCost);
  const ready = filled.length > 0 && filled.every((l) => l.item && QTY.test(l.quantity) && Number(l.quantity) > 0 && (l.unitCost === '' || COST.test(l.unitCost)));

  const suggest = useCallback(async (supplierId?: string | null) => {
    setSuggesting(true);
    try {
      const r = await api<{ data: Suggestion[] }>(`/v1/purchase-orders/suggestions${supplierId ? `?supplierId=${supplierId}` : ''}`);
      setLines((ls) => {
        const have = new Set(ls.map((l) => l.item?.id).filter(Boolean));
        const add = r.data.filter((s) => !have.has(s.itemId)).map((s) => ({
          key: ++lineKey, item: { id: s.itemId, name: s.name }, quantity: s.quantity, unitCost: s.unitCost ?? '',
          hint: t('{stock} in stock · {sold} sold in 30 days', { stock: s.stock, sold: s.soldLast30Days }),
        }));
        if (!add.length) toast(t('Nothing else is running low'));
        return [...ls.filter((l) => l.item || l.quantity || l.unitCost), ...add].concat(add.length || ls.some((l) => l.item) ? [] : [blank()]);
      });
      // One supplier for everything suggested: choose it.
      const names = [...new Set(r.data.map((s) => s.supplier?.id).filter(Boolean))];
      if (!supplierId && names.length === 1) {
        const s = r.data.find((x) => x.supplier?.id === names[0])!.supplier!;
        setSupplier((cur) => cur ?? { id: s.id!, name: s.name, tin: null, email: s.email });
        setSupplierName((cur) => cur || s.name);
        if (s.email) setEmail((cur) => cur || s.email!);
      }
    } catch (e) {
      setError(e);
    } finally {
      setSuggesting(false);
    }
  }, [t, toast]);
  useEffect(() => {
    // From a supplier's page: that supplier, with what is low from them.
    const from = params.get('supplier');
    if (!id && from) {
      void api<{ supplier: SupplierLite & { email: string | null } }>(`/v1/suppliers/${from}/summary`).then((r) => {
        setSupplier(r.supplier);
        setSupplierName(r.supplier.name);
        if (r.supplier.email) setEmail(r.supplier.email);
        void suggest(r.supplier.id);
      }).catch(setError);
    } else if (!id && params.get('suggest')) void suggest(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(supplier ? { supplierId: supplier.id } : { supplierName: supplierName.trim() }),
        supplierEmail: email.trim() || null,
        expectedOn: expectedOn || null,
        note: note.trim() || null,
        lines: filled.map((l) => ({ itemId: l.item!.id, quantity: l.quantity, ...(l.unitCost !== '' && { unitCost: l.unitCost }) })),
      };
      const po = id
        ? await api<PurchaseOrder>(`/v1/purchase-orders/${id}`, { method: 'PUT', body })
        : await api<PurchaseOrder>('/v1/purchase-orders', { method: 'POST', body });
      toast(id ? t('{n} saved', { n: po.number }) : t('{n} created', { n: po.number }));
      navigate(`/inventory/orders/${po.id}`, { viewTransition: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!loaded) return <div className="stack"><ErrorText error={error} /><div className="skeleton" style={{ height: '18rem' }} /></div>;
  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <div><span className="kicker"><Link to="/inventory?filter=orders" viewTransition>{t('Inventory')}</Link></span><h1>{number ? t('Edit {n}', { n: number }) : t('New purchase order')}</h1></div>
      </div>
      <div className="doc-layout">
        <div className="stack">
          <fieldset className="stack">
            <legend>{t('Supplier')}</legend>
            <Combobox<SupplierLite>
              label={t('Supplier')}
              placeholder={t('Search your suppliers, or type a name')}
              search={(q) => api<{ data: SupplierLite[] }>(`/v1/suppliers?q=${encodeURIComponent(q)}`).then((r) => r.data)}
              render={(s) => <><strong>{s.name}</strong>{s.email && <span className="muted"> · {s.email}</span>}</>}
              value={supplier?.name ?? supplierName}
              onText={(v) => { setSupplier(null); setSupplierName(v); }}
              onPick={(s) => { setSupplier(s); setSupplierName(s.name); if (s.email) setEmail(s.email); }}
            />
            <div className="form-grid">
              <Field label={t('Their email')} hint={t('Where the order is sent. Optional.')}><input type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label={t('Wanted by')}><input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} /></Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>{t('Items')}</legend>
            {lines.map((l, i) => (
              <div key={l.key} className="receive-line">
                <Field label={t('Item {n}', { n: i + 1 })} className="grow">
                  <Combobox<Item>
                    placeholder={t('Search your items or scan a barcode')}
                    search={(q) => api<Page<Item>>(`/v1/items?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data)}
                    render={(it) => <><strong>{it.name}</strong>{it.stock !== null && it.stock !== undefined && <span className="muted"> · {t('{n} in stock', { n: it.stock })}</span>}</>}
                    value={l.item?.name ?? ''}
                    onText={() => update(l.key, { item: null })}
                    onPick={(it) => update(l.key, { item: it })}
                  />
                </Field>
                <Field label={t('Quantity')}><input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value.trim() })} /></Field>
                <Field label={t('Unit cost before GST (BZ$)')}><input inputMode="decimal" placeholder={t('Last cost')} value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value.trim() })} /></Field>
                <span className="line-total">{lineCents(l) > 0n ? money(fromCents(lineCents(l))) : ''}</span>
                {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>{t('Remove')}</button>}
                {l.hint && <span className="line-hint small muted">{l.hint}</span>}
              </div>
            ))}
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button type="button" className="secondary" onClick={() => setLines([...lines, blank()])}>+ {t('Add item')}</button>
              <button type="button" className="secondary" disabled={suggesting} onClick={() => void suggest(supplier?.id ?? null)}>{suggesting ? t('Looking…') : supplier ? t('Add what is low from {name}', { name: supplier.name }) : t('Add what is running low')}</button>
            </div>
          </fieldset>
          <Field label={t('Note for the supplier')}><textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <aside className="doc-aside">
          <section className="card totals ticket stack">
            <span className="kicker" style={{ color: 'var(--lime)' }}>{t('Order')} · BZD</span>
            <div className="grand"><span>{t('Cost before GST')}</span><span>{money(fromCents(total))}</span></div>
            <p className="small" style={{ opacity: 0.75 }}>{t('Lines without a cost use what the item cost last time.')}</p>
            <ErrorText error={error} />
            <button type="submit" className="big lime" disabled={busy || !ready || (!supplier && !supplierName.trim())}>{busy ? t('Saving…') : id ? t('Save order') : t('Create order')}<span className="chip" aria-hidden="true">→</span></button>
          </section>
        </aside>
      </div>
    </form>
  );
}

// ---------- one order ----------

export function PurchaseOrderDetail() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const { can } = useSession();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<null | 'send' | 'cancel'>(null);
  usePageTitle(po ? po.number : t('Purchase order'));
  const load = useCallback(() => api<PurchaseOrder>(`/v1/purchase-orders/${id}`).then(setPo).catch(setError), [id]);
  useEffect(() => void load(), [load]);
  if (error && !po) return <div className="stack"><ErrorText error={error} /></div>;
  if (!po) return <div className="stack"><div className="skeleton" style={{ height: '2.4rem', width: '30%' }} /><div className="skeleton" style={{ height: '18rem' }} /></div>;

  const manage = can('catalog.manage');
  const editable = po.status === 'draft' || po.status === 'sent';
  const open = OPEN.includes(po.status);
  const cancel = async () => {
    try {
      await api(`/v1/purchase-orders/${po.id}/cancel`, { method: 'POST' });
      toast(po.status === 'partial' ? t('{n} closed', { n: po.number }) : t('{n} cancelled', { n: po.number }));
      setDialog(null);
      void load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/inventory?filter=orders" viewTransition>{t('Inventory')}</Link></span>
          <h1>{t('Purchase order')} <span className="mono">{po.number}</span></h1>
        </div>
        <PoBadge po={po} />
        <span className="spacer" />
        {manage && editable && <Link className="button secondary" to={`/inventory/orders/${po.id}/edit`} viewTransition>{t('Edit')}</Link>}
        <a className="button secondary" href={link(`/v1/purchase-orders/${po.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>
        {manage && editable && <button type="button" className="secondary" onClick={() => setDialog('send')}>{po.status === 'sent' ? t('Send again') : t('Send')}</button>}
        {manage && open && <button type="button" onClick={() => navigate(`/inventory/receive?order=${po.id}`, { viewTransition: true })}>{t('Receive delivery')}<span className="chip" aria-hidden="true">+</span></button>}
      </div>
      <ErrorText error={error} />
      {po.late && <div className="banner warn"><div><strong>{t('This order was wanted by {date}.', { date: po.expectedOn ?? '' })}</strong>{t('Check with the supplier, or close it if the rest is not coming.')}</div></div>}

      <div className="doc-layout">
        <section className="card stack">
          <div className="row">
            <div>
              <span className="kicker">{t('Supplier')}</span>
              <div className="strong">{po.supplier.name}</div>
              {po.supplier.email && <p className="small muted">{po.supplier.email}</p>}
            </div>
            <span className="spacer" />
            <div className="right">
              <span className="kicker">{t('Wanted by')}</span>
              <div className="strong">{po.expectedOn ?? '—'}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Ordered')}</th><th scope="col" className="right">{t('Received')}</th><th scope="col" className="right">{t('Unit cost')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.lineNumber}>
                    <td data-label={t('Item')}><strong>{l.description}</strong>{l.code && <span className="small muted mono"> · {l.code}</span>}</td>
                    <td data-label={t('Ordered')} className="right">{l.quantity} <span className="small muted">{unitName(t, l.unitCode).toLowerCase()}</span></td>
                    <td data-label={t('Received')} className={`right ${Number(l.remaining) === 0 ? 'strong' : ''}`}>{l.received}{Number(l.remaining) > 0 && Number(l.received) > 0 && <span className="small muted"> · {t('{n} to come', { n: l.remaining })}</span>}</td>
                    <td data-label={t('Unit cost')} className="right">{money(l.unitCost)}</td>
                    <td data-label={t('Total')} className="right">{money(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {po.note && <p className="small"><span className="muted">{t('Note')}:</span> {po.note}</p>}
        </section>
        <aside className="doc-aside stack">
          <section className="card totals stack">
            <div className="grand"><span>{t('Cost before GST')}</span><span>{money(po.total)}</span></div>
            <p className="small muted">{po.sentAt ? t('Sent {date}', { date: belizeDay(po.sentAt) }) : t('Not sent yet')}{po.createdBy && ` · ${t('by {name}', { name: po.createdBy })}`}</p>
            {manage && open && <button type="button" className="link danger-link" onClick={() => setDialog('cancel')}>{po.status === 'partial' ? t('Close: the rest is not coming') : t('Cancel order')}</button>}
          </section>
          <section className="card stack">
            <h2>{t('Deliveries')}</h2>
            {!po.receipts?.length ? <p className="small muted">{t('Nothing received yet.')}</p> : (
              <ul className="plain-list">
                {po.receipts.map((r) => (
                  <li key={r.id} className="row small">
                    <span>{r.receivedOn}{r.reference && <span className="muted"> · {r.reference}</span>}</span>
                    <span className="spacer" />
                    <span className="num">{money(r.totalCost)}</span>
                    {r.expenseId && <Link to={`/expenses/${r.expenseId}`}>{t('Bill')}</Link>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {dialog === 'send' && <SendDialog po={po} onClose={() => setDialog(null)} onSent={(to) => { toast(to ? t('Sent to {email}', { email: to }) : t('Marked as sent')); setDialog(null); void load(); }} />}
      {dialog === 'cancel' && (
        <Modal title={po.status === 'partial' ? t('Close {n}?', { n: po.number }) : t('Cancel {n}?', { n: po.number })} onClose={() => setDialog(null)}>
          <p>{po.status === 'partial' ? t('What has arrived stays in stock; nothing more is received against this order.') : t('The order stays on record as cancelled. Tell the supplier if you already sent it.')}</p>
          <div className="row">
            <span className="spacer" />
            <button type="button" className="secondary" onClick={() => setDialog(null)}>{t('Keep')}</button>
            <button type="button" className="danger" onClick={() => void cancel()}>{po.status === 'partial' ? t('Close order') : t('Cancel order')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SendDialog(props: { po: PurchaseOrder; onClose: () => void; onSent: (to: string | null) => void }) {
  const t = useT();
  const [to, setTo] = useState(props.po.supplier.email ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (email: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ to: string | null }>(`/v1/purchase-orders/${props.po.id}/send`, { method: 'POST', body: email ? { to: to.trim(), ...(message.trim() && { message: message.trim() }) } : { email: false } });
      props.onSent(r.to);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Send {n}', { n: props.po.number })} onClose={props.onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(true); }}>
        <Field label={t('To')}><input type="email" required autoFocus value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('Message')} hint={t('Optional. The PDF is attached.')}><textarea rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row">
          <button type="button" className="link" disabled={busy} onClick={() => void send(false)}>{t('Sent another way (phone, WhatsApp)')}</button>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={props.onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || !to.trim()}>{busy ? t('Sending…') : t('Send')}</button>
        </div>
      </form>
    </Modal>
  );
}
