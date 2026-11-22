/** Inventory: stock levels, each item's history, counts, adjustments, and receiving stock from suppliers. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type Item, link, type Page } from '../api';
import { type T, useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeDate, belizeToday, Combobox, ErrorText, Field, fromCents, Modal, money, PAYMENT_METHOD_TEXT, Segmented, toCents, unitName, useDebounced, usePageTitle } from '../ui';

interface StockItem {
  itemId: string;
  name: string;
  sellerCode: string | null;
  barcode: string | null;
  unitCode: string;
  price: string;
  tracked: boolean;
  stock: number | null;
  lowStock: number | null;
  state: 'ok' | 'low' | 'out' | 'untracked';
  averageCost: string | null;
  value: string;
  lastMovement: string | null;
}

interface StockTotals { tracked: number; untracked: number; low: number; out: number; value: string }

interface MovementInfo {
  id: string;
  change: number;
  balance: number;
  reason: string;
  note: string | null;
  unitCost: string | null;
  at: string;
  by: string | null;
  document: { id: string; type: string; number: string } | null;
  order: { id: string; number: number } | null;
  receipt: { id: string; reference: string | null; supplier: string | null } | null;
}

const REASON: Record<string, string> = {
  initial: 'Opening stock', sale: 'Sold', sale_reversed: 'Sale undone', order: 'Online order', order_cancelled: 'Order cancelled', refund: 'Refund, back in stock',
  receive: 'Received', count: 'Counted', damaged: 'Damaged', lost: 'Lost or stolen', returned: 'Returned by a customer', other: 'Other',
};
const ADJUST: Array<[string, string]> = [['count', 'Counted'], ['damaged', 'Damaged'], ['lost', 'Lost or stolen'], ['returned', 'Returned by a customer'], ['other', 'Other']];
const qtyText = (n: number | null) => (n === null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ''));
const STATE: Record<StockItem['state'], [string, string]> = { ok: ['In stock', 'pay-paid'], low: ['Low', 'pay-credit'], out: ['Out', 'pay-overdue'], untracked: ['Not tracked', 'pay-unpaid'] };

export function StockBadge({ state }: { state: StockItem['state'] }) {
  const t = useT();
  return <span className={`badge ${STATE[state][1]}`}>{t(STATE[state][0])}</span>;
}

// ---------- the page ----------

export function Inventory() {
  const t = useT();
  usePageTitle(t('Inventory'));
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as 'tracked' | 'low' | 'untracked' | 'deliveries' | null) ?? 'tracked';
  const [q, setQ] = useState('');
  const search = useDebounced(q, 250);
  const [data, setData] = useState<{ data: StockItem[]; totals: StockTotals } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const load = useCallback(() => {
    if (filter === 'deliveries') return;
    api<{ data: StockItem[]; totals: StockTotals }>(`/v1/inventory?filter=${filter}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`).then(setData).catch(setError);
  }, [filter, search]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  const manage = can('catalog.manage');
  const tt = data?.totals;
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Records')}</span><h1>{t('Inventory')}</h1></div>
        <span className="spacer" />
        {manage && <button className="secondary" onClick={() => setCounting(true)}>{t('Stock count')}</button>}
        <a className="button secondary" href={link('/v1/inventory.csv')} download>CSV</a>
        {manage && <Link className="button" to="/inventory/receive" viewTransition>{t('Receive stock')}<span className="chip" aria-hidden="true">+</span></Link>}
      </div>
      <div className="kpis">
        <div className="card kpi"><span className="kpi-head">{t('Stock value')}</span><span className="kpi-value">{tt ? money(tt.value) : '—'}</span><span className="kpi-note">{t('At average cost, before GST')}</span></div>
        <button type="button" className={`card kpi kpi-button ${tt && tt.low ? 'alert' : ''}`} onClick={() => setParams({ filter: 'low' }, { replace: true })}><span className="kpi-head">{t('Running low')}</span><span className="kpi-value">{tt ? tt.low : '—'}</span><span className="kpi-note">{t('At or below their low-stock level')}</span></button>
        <button type="button" className={`card kpi kpi-button ${tt && tt.out ? 'alert' : ''}`} onClick={() => setParams({ filter: 'low' }, { replace: true })}><span className="kpi-head">{t('Out of stock')}</span><span className="kpi-value">{tt ? tt.out : '—'}</span><span className="kpi-note">{t('Zero or below: count them')}</span></button>
        <div className="card kpi"><span className="kpi-head">{t('Items tracked')}</span><span className="kpi-value">{tt ? tt.tracked : '—'}</span><span className="kpi-note">{tt ? t('{n} not tracked', { n: tt.untracked }) : ' '}</span></div>
      </div>
      <div className="row">
        <Segmented label={t('Show')} value={filter} onChange={(v) => setParams({ filter: v }, { replace: true })} options={[['tracked', t('Tracked')], ['low', t('Low or out')], ['untracked', t('Not tracked')], ['deliveries', t('Deliveries')]]} />
        <span className="spacer" />
        {filter !== 'deliveries' && <input type="search" className="search-input" placeholder={t('Name, code or barcode')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search items')} />}
      </div>
      <ErrorText error={error} />
      {filter === 'deliveries' ? <Deliveries /> : (
        <section className="card">
          {!data ? <div className="skeleton" style={{ height: '10rem' }} /> : data.data.length === 0 ? (
            <div className="empty">{filter === 'tracked' ? t('No stock tracked yet. Receive a delivery, or open an item and track its stock: every sale then takes it off.') : filter === 'low' ? t('Nothing is running low.') : t('Every item is tracked.')}</div>
          ) : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('In stock')}</th><th scope="col" className="right">{t('Low at')}</th><th scope="col" className="right">{t('Average cost')}</th><th scope="col" className="right">{t('Value')}</th><th scope="col">{t('Status')}</th></tr></thead>
                <tbody>
                  {data.data.map((s) => (
                    <tr key={s.itemId} className="clickable" onClick={() => setOpen(s.itemId)}>
                      <td data-label={t('Item')}><strong>{s.name}</strong>{s.sellerCode && <span className="small muted mono"> · {s.sellerCode}</span>}</td>
                      <td data-label={t('In stock')} className={`right strong ${s.state === 'out' ? 'late' : ''}`}>{qtyText(s.stock)} <span className="small muted">{s.tracked ? unitName(t, s.unitCode).toLowerCase() : ''}</span></td>
                      <td data-label={t('Low at')} className="right">{qtyText(s.lowStock)}</td>
                      <td data-label={t('Average cost')} className="right">{s.averageCost ? money(s.averageCost) : '—'}</td>
                      <td data-label={t('Value')} className="right">{toCents(s.value) > 0n ? money(s.value) : '—'}</td>
                      <td data-label={t('Status')}><StockBadge state={s.state} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {open && <ItemStockModal itemId={open} onClose={() => setOpen(null)} onChange={load} />}
      {counting && <StockCountModal onClose={() => setCounting(false)} onDone={() => { setCounting(false); load(); }} />}
      {!manage && <p className="small muted">{t('Ask a manager to change stock.')}</p>}
    </div>
  );
}

function movementSource(t: T, m: MovementInfo) {
  if (m.document) return <Link to={`/documents/${m.document.id}`} className="mono">{m.document.number}</Link>;
  if (m.order) return <Link to={`/orders/${m.order.id}`}>#{m.order.number}</Link>;
  if (m.receipt) return <span>{[m.receipt.supplier, m.receipt.reference].filter(Boolean).join(' · ') || t('Delivery')}</span>;
  return null;
}

function ItemStockModal({ itemId, onClose, onChange }: { itemId: string; onClose: () => void; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const [s, setS] = useState<(StockItem & { movements: MovementInfo[] }) | null>(null);
  const [mode, setMode] = useState<'change' | 'set'>('change');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('count');
  const [note, setNote] = useState('');
  const [low, setLow] = useState('');
  const [start, setStart] = useState('0');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<StockItem & { movements: MovementInfo[] }>(`/v1/inventory/${itemId}`).then((r) => {
    setS(r);
    setLow(r.lowStock === null ? '' : String(r.lowStock));
  }).catch(setError), [itemId]);
  useEffect(() => void load(), [load]);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      setQuantity('');
      setNote('');
      await load();
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const adjust = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(`/v1/inventory/${itemId}/adjust`, { method: 'POST', body: { mode, quantity: quantity.trim(), reason, ...(note.trim() && { note: note.trim() }) } }), t('Stock updated'));
  };
  const manage = can('catalog.manage');
  return (
    <Modal title={s?.name ?? t('Item')} onClose={onClose} wide>
      {!s ? <div className="skeleton" style={{ height: '10rem' }} /> : (
        <div className="stack">
          <div className="row stock-head">
            <div><span className="kicker">{t('In stock')}</span><div className="stock-big">{s.tracked ? qtyText(s.stock) : '—'} <span className="small muted">{s.tracked ? unitName(t, s.unitCode).toLowerCase() : ''}</span></div></div>
            <StockBadge state={s.state} />
            <span className="spacer" />
            {s.averageCost && <div className="right"><span className="kicker">{t('Average cost')}</span><div>{money(s.averageCost)} · {t('value')} {money(s.value)}</div></div>}
          </div>
          <ErrorText error={error} />
          {!s.tracked && manage && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/inventory/${itemId}/settings`, { method: 'PUT', body: { track: true, quantity: start.trim() || '0', ...(low.trim() && { lowStock: low.trim() }) } }), t('Tracking stock')); }}>
              <Field label={t('How many do you have now?')}><input inputMode="decimal" required value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label={t('Warn me at')} hint={t('Optional.')}><input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /></Field>
              <button disabled={busy}>{t('Track stock')}</button>
            </form>
          )}
          {s.tracked && manage && (
            <>
              <form className="adjust-form" onSubmit={adjust}>
                <Segmented label={t('Adjust')} value={mode} onChange={setMode} options={[['change', t('Add or take off')], ['set', t('Set to a count')]]} />
                <div className="form-grid">
                  <Field label={mode === 'change' ? t('Change (e.g. -2 or 5)') : t('Counted')}><input inputMode="decimal" required value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
                  <Field label={t('Reason')}><select value={reason} onChange={(e) => setReason(e.target.value)}>{ADJUST.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select></Field>
                  <Field label={t('Note')} hint={t('Optional.')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                </div>
                <button disabled={busy || !quantity.trim()}>{t('Save')}</button>
              </form>
              <div className="row">
                <Field label={t('Warn me when stock is at or below')}><input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} placeholder={t('No warning')} /></Field>
                <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api(`/v1/inventory/${itemId}/settings`, { method: 'PUT', body: { track: true, lowStock: low.trim() || null } }), t('Saved'))}>{t('Save level')}</button>
                <span className="spacer" />
                <button type="button" className="link danger-link" onClick={() => void run(() => api(`/v1/inventory/${itemId}/settings`, { method: 'PUT', body: { track: false } }), t('Stock no longer tracked'))}>{t('Stop tracking')}</button>
              </div>
            </>
          )}
          <h3>{t('History')}</h3>
          {s.movements.length === 0 ? <p className="small muted">{t('No movements yet.')}</p> : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('When')}</th><th scope="col">{t('What')}</th><th scope="col" className="right">{t('Change')}</th><th scope="col" className="right">{t('Balance')}</th><th scope="col">{t('From')}</th></tr></thead>
                <tbody>
                  {s.movements.map((m) => (
                    <tr key={m.id}>
                      <td data-label={t('When')} className="small">{new Date(m.at).toLocaleString()}</td>
                      <td data-label={t('What')}>{t(REASON[m.reason] ?? m.reason)}{m.note && <span className="small muted"> · {m.note}</span>}{m.by && <span className="small muted"> · {m.by}</span>}</td>
                      <td data-label={t('Change')} className={`right mono ${m.change < 0 ? 'late' : 'gain-text'}`}>{m.change > 0 ? '+' : ''}{qtyText(m.change)}</td>
                      <td data-label={t('Balance')} className="right mono">{qtyText(m.balance)}</td>
                      <td data-label={t('From')} className="small">{movementSource(t, m)}{m.unitCost && <span className="muted"> @ {money(m.unitCost)}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function StockCountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState(t('Stock count'));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<{ data: StockItem[] }>('/v1/inventory?filter=tracked&limit=500').then((r) => setItems(r.data)).catch(setError), []);
  const filled = Object.entries(counts).filter(([, v]) => /^-?\d{1,12}(\.\d{1,3})?$/.test(v.trim()));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ changed: number }>('/v1/inventory/count', { method: 'POST', body: { counts: filled.map(([itemId, quantity]) => ({ itemId, quantity: quantity.trim() })), note } });
      toast(t('{n} counts saved, {c} changed', { n: filled.length, c: r.changed }));
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Stock count')} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted">{t('Type what you counted on the shelf; leave the rest empty. Only what differs is recorded, as a count in each item’s history.')}</p>
        {!items ? <div className="skeleton" style={{ height: '8rem' }} /> : items.length === 0 ? <p>{t('No stock tracked yet.')}</p> : (
          <div className="table-wrap count-table">
            <table>
              <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Expected')}</th><th scope="col" className="right">{t('Counted')}</th></tr></thead>
              <tbody>
                {items.map((s) => {
                  const v = counts[s.itemId] ?? '';
                  const diff = v.trim() && s.stock !== null ? Number(v) - s.stock : null;
                  return (
                    <tr key={s.itemId}>
                      <td>{s.name}</td>
                      <td className="right mono">{qtyText(s.stock)}</td>
                      <td className="right">
                        <input className="count-input" inputMode="decimal" value={v} onChange={(e) => setCounts({ ...counts, [s.itemId]: e.target.value })} aria-label={t('Counted for {item}', { item: s.name })} />
                        {diff !== null && !Number.isNaN(diff) && diff !== 0 && <span className={`small ${diff < 0 ? 'late' : 'gain-text'}`}> {diff > 0 ? '+' : ''}{qtyText(diff)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Field label={t('Note')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || filled.length === 0} onClick={() => void submit()}>{t('Save {n} counts', { n: filled.length })}</button></div>
      </div>
    </Modal>
  );
}

function Deliveries() {
  const t = useT();
  const [rows, setRows] = useState<Array<{ id: string; supplier: string | null; reference: string | null; receivedOn: string; totalCost: string; expenseId: string | null; lines: number; receivedBy: string | null }> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<{ data: NonNullable<typeof rows> }>('/v1/inventory/receipts').then((r) => setRows(r.data)).catch(setError), []);
  return (
    <section className="card">
      <ErrorText error={error} />
      {!rows ? <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? <div className="empty">{t('No deliveries yet.')} <Link to="/inventory/receive">{t('Receive stock')}</Link></div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('Supplier')}</th><th scope="col">{t('Reference')}</th><th scope="col" className="right">{t('Items')}</th><th scope="col" className="right">{t('Cost')}</th><th scope="col">{t('Bill')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('Date')}>{r.receivedOn}</td>
                  <td data-label={t('Supplier')}>{r.supplier ?? '—'}</td>
                  <td data-label={t('Reference')}>{r.reference ?? '—'}</td>
                  <td data-label={t('Items')} className="right">{r.lines}</td>
                  <td data-label={t('Cost')} className="right">{money(r.totalCost)}</td>
                  <td data-label={t('Bill')}>{r.expenseId ? <Link to={`/expenses/${r.expenseId}`}>{t('Open')}</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- receiving stock ----------

interface SupplierLite { id: string; name: string; tin: string | null }
interface ReceiveLine { key: number; item: Item | null; quantity: string; unitCost: string }
let lineKey = 0;
const DEC = /^\d{1,12}(\.\d{1,6})?$/;

export function ReceiveStock() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useSession();
  usePageTitle(t('Receive stock'));
  const [supplier, setSupplier] = useState<SupplierLite | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(belizeToday());
  const [lines, setLines] = useState<ReceiveLine[]>(() => [{ key: ++lineKey, item: null, quantity: '', unitCost: '' }]);
  const [recordBill, setRecordBill] = useState(can('expenses.manage'));
  const [treatment, setTreatment] = useState<'standard' | 'zero' | 'exempt' | 'none'>('standard');
  const [paidNow, setPaidNow] = useState(false);
  const [method, setMethod] = useState<'bank_transfer' | 'cash' | 'cheque' | 'card' | 'online' | 'other'>('bank_transfer');
  const [dueDate, setDueDate] = useState(belizeDate(30));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const ready = lines.filter((l) => l.item && DEC.test(l.quantity) && Number(l.quantity) > 0 && DEC.test(l.unitCost));
  const lineCents = (l: ReceiveLine) => (l.item && DEC.test(l.quantity) && DEC.test(l.unitCost) ? BigInt(Math.round(Number(l.quantity) * Number(l.unitCost) * 100)) : 0n);
  const net = lines.reduce((a, l) => a + lineCents(l), 0n);
  const gst = recordBill && treatment === 'standard' ? (net * 125n * 2n + 1000n) / 2000n : 0n;
  const update = (key: number, patch: Partial<ReceiveLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/inventory/receipts', {
        method: 'POST',
        body: {
          ...(supplier ? { supplierId: supplier.id } : supplierName.trim() ? { supplierName: supplierName.trim() } : {}),
          ...(reference.trim() && { reference: reference.trim() }),
          receivedOn,
          lines: ready.map((l) => ({ itemId: l.item!.id, quantity: l.quantity, unitCost: l.unitCost })),
          ...(recordBill && { expense: { gstTreatment: treatment, ...(paidNow ? { paid: { on: receivedOn, method } } : { paid: null, dueDate }) } }),
        },
      });
      toast(t('Stock received'));
      navigate('/inventory?filter=deliveries', { viewTransition: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="row"><div><span className="kicker"><Link to="/inventory" viewTransition>{t('Inventory')}</Link></span><h1>{t('Receive stock')}</h1></div></div>
      <div className="doc-layout">
        <div className="stack">
          <fieldset className="stack">
            <legend>{t('Delivery')}</legend>
            <Combobox<SupplierLite>
              label={t('Supplier')}
              placeholder={t('Search your suppliers, or type a name')}
              search={(q) => api<{ data: SupplierLite[] }>(`/v1/suppliers?q=${encodeURIComponent(q)}`).then((r) => r.data)}
              render={(s) => <><strong>{s.name}</strong>{s.tin && <span className="muted"> · TIN {s.tin}</span>}</>}
              value={supplier?.name ?? supplierName}
              onText={(v) => { setSupplier(null); setSupplierName(v); }}
              onPick={(s) => { setSupplier(s); setSupplierName(s.name); }}
            />
            <div className="form-grid">
              <Field label={t('Their delivery note or invoice number')}><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
              <Field label={t('Received on')}><input type="date" required max={belizeToday()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>{t('Items received')}</legend>
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
                <Field label={t('Unit cost before GST (BZ$)')}><input inputMode="decimal" placeholder="0.00" value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value.trim() })} /></Field>
                <span className="line-total">{lineCents(l) > 0n ? money(fromCents(lineCents(l))) : ''}</span>
                {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>{t('Remove')}</button>}
              </div>
            ))}
            <button type="button" className="secondary" style={{ marginTop: '0.75rem' }} onClick={() => setLines([...lines, { key: ++lineKey, item: null, quantity: '', unitCost: '' }])}>+ {t('Add item')}</button>
          </fieldset>
          {can('expenses.manage') && (
            <fieldset className="stack">
              <legend>{t('The bill')}</legend>
              <label className="row small"><input type="checkbox" checked={recordBill} onChange={(e) => setRecordBill(e.target.checked)} /> {t('Record the supplier’s bill as an expense (stock for resale)')}</label>
              {recordBill && (
                <div className="form-grid">
                  <Field label="GST">
                    <select value={treatment} onChange={(e) => setTreatment(e.target.value as typeof treatment)}>
                      <option value="standard">{t('Standard rate: 12.5% on top of the cost')}</option>
                      <option value="zero">{t('Zero-rated')}</option>
                      <option value="exempt">{t('Exempt')}</option>
                      <option value="none">{t('No GST (supplier not registered)')}</option>
                    </select>
                  </Field>
                  <Field label={t('Payment')}>
                    <select value={paidNow ? 'paid' : 'bill'} onChange={(e) => setPaidNow(e.target.value === 'paid')}>
                      <option value="bill">{t('A bill to pay later')}</option>
                      <option value="paid">{t('Paid on delivery')}</option>
                    </select>
                  </Field>
                  {paidNow
                    ? <Field label={t('Method')}><select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{(['bank_transfer', 'cash', 'cheque', 'card', 'online', 'other'] as const).map((m) => <option key={m} value={m}>{t(PAYMENT_METHOD_TEXT[m])}</option>)}</select></Field>
                    : <Field label={t('Due on')}><input type="date" min={receivedOn} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>}
                </div>
              )}
            </fieldset>
          )}
        </div>
        <aside className="doc-aside">
          <section className="card totals ticket stack">
            <span className="kicker" style={{ color: 'var(--lime)' }}>{t('Delivery')} · BZD</span>
            <div><span>{t('Cost before GST')}</span><span>{money(fromCents(net))}</span></div>
            {recordBill && <div><span>GST</span><span>{money(fromCents(gst))}</span></div>}
            {recordBill && <div className="grand"><span>{t('Bill total')}</span><span>{money(fromCents(net + gst))}</span></div>}
            <ErrorText error={error} />
            <button type="submit" className="big lime" disabled={busy || ready.length === 0 || ready.length !== lines.filter((l) => l.item || l.quantity || l.unitCost).length || (recordBill && !supplier && !supplierName.trim())}>{busy ? t('Saving…') : t('Receive {n} items', { n: ready.length })}<span className="chip" aria-hidden="true">→</span></button>
            <p className="small muted">{t('The stock goes up now and each item’s average cost is updated.')}</p>
          </section>
        </aside>
      </div>
    </form>
  );
}
