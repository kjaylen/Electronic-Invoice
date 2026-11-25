/** More than one shop: the business's locations (Settings → Tills), and stock sent between them (Inventory → Transfers). */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Item, type Page } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { Combobox, ErrorText, Field, Modal, Select, unitName } from '../ui';

export interface Place { id: string; name: string; main: boolean; registers?: number; itemsInStock?: number }

/** The business's locations: empty for a business with one shop. */
export function useLocations(): [Place[], () => void] {
  const [places, setPlaces] = useState<Place[]>([]);
  const load = useCallback(() => void api<{ data: Place[] }>('/v1/locations').then((r) => setPlaces(r.data)).catch(() => {}), []);
  useEffect(load, [load]);
  return [places, load];
}

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ''));

// ---------- Settings: the locations ----------

export function LocationsCard() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [name, setName] = useState('');
  const [mainName, setMainName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<{ data: Place[] }>('/v1/locations').then((r) => setPlaces(r.data)).catch(setError), []);
  const first = places !== null && places.length === 0;
  const run = async (fn: () => Promise<{ data: Place[] }>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      setPlaces((await fn()).data);
      toast(done);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api('/v1/locations', { method: 'POST', body: { name: name.trim(), ...(first && mainName.trim() && { mainName: mainName.trim() }) } }), t('Location added. Stock, deliveries and counts can now be kept for each one.'))) {
      setName('');
      setMainName('');
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (renaming && await run(() => api(`/v1/locations/${renaming.id}`, { method: 'PUT', body: { name: renaming.name.trim() } }), t('Saved'))) setRenaming(null);
  };
  const close = async (p: Place) => {
    if (!(await confirm({ title: t('Close {name}?', { name: p.name }), body: t('Its history stays. It must have no stock, no register and nothing on the way.'), confirm: t('Close the location'), danger: true }))) return;
    await run(() => api(`/v1/locations/${p.id}`, { method: 'DELETE' }), t('Location closed'));
  };
  return (
    <section className="card stack">
      <div>
        <h2>{t('Locations')}</h2>
        <p className="small muted">{t('For a business with more than one shop or a warehouse. Stock is kept for each location, each register sells from its own, and stock is moved between them with a transfer. With one shop, leave this empty.')}</p>
      </div>
      {places && places.length > 0 && (
        <ul className="plain locations-list">
          {places.map((p) => (
            <li key={p.id} className="row">
              {renaming?.id === p.id ? (
                <form className="row grow" onSubmit={(e) => void rename(e)}>
                  <input className="grow" required maxLength={60} value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} aria-label={t('Name of the location')} autoFocus />
                  <button className="secondary small-button" disabled={busy || !renaming.name.trim()}>{t('Save')}</button>
                  <button type="button" className="link" onClick={() => setRenaming(null)}>{t('Cancel')}</button>
                </form>
              ) : (
                <>
                  <strong>{p.name}</strong>
                  {p.main && <span className="badge pay-paid">{t('Main')}</span>}
                  <span className="small muted">{p.registers === 1 ? t('1 register') : t('{n} registers', { n: p.registers ?? 0 })}{!p.main && (p.itemsInStock ?? 0) > 0 ? ` · ${t('{n} items in stock', { n: p.itemsInStock ?? 0 })}` : ''}</span>
                  <span className="spacer" />
                  <button type="button" className="link small" onClick={() => setRenaming({ id: p.id, name: p.name })}>{t('Rename')}</button>
                  {!p.main && <button type="button" className="link danger-link small" disabled={busy} onClick={() => void close(p)}>{t('Close')}</button>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="row locations-add" onSubmit={(e) => void add(e)}>
        {first && <Field label={t('The shop you have now')} hint={t('It keeps all the stock you have today.')}><input maxLength={60} value={mainName} onChange={(e) => setMainName(e.target.value)} placeholder={t('Main shop')} /></Field>}
        <Field label={first ? t('The second location') : t('New location')}><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. San Pedro shop, Warehouse')} /></Field>
        <button className="secondary" disabled={busy || !name.trim()}>{t('Add location')}</button>
      </form>
      {places && places.length > 1 && <p className="small muted">{t('Say which location each register is at under Cash register, in Registers. Move stock under Inventory, in Transfers.')}</p>}
      <ErrorText error={error} />
    </section>
  );
}

// ---------- Inventory: transfers ----------

export interface Transfer {
  id: string;
  number: string;
  status: 'sent' | 'received' | 'cancelled';
  note: string | null;
  from: { id: string; name: string };
  to: { id: string; name: string };
  sentAt: string;
  sentBy: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
  cancelledAt: string | null;
  lines: Array<{ itemId: string; name: string; unitCode: string; quantity: number }>;
}

const STATUS: Record<Transfer['status'], [string, string]> = { sent: ['On the way', 'pay-credit'], received: ['Received', 'pay-paid'], cancelled: ['Cancelled', 'pay-unpaid'] };

export function Transfers({ places, onChange }: { places: Place[]; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const manage = can('catalog.manage');
  const [rows, setRows] = useState<Transfer[] | null>(null);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: Transfer[] }>('/v1/transfers').then((r) => setRows(r.data)).catch(setError), []);
  useEffect(() => void load(), [load]);
  const finish = async (tr: Transfer, how: 'receive' | 'cancel') => {
    if (how === 'cancel' && !(await confirm({ title: t('Cancel {n}?', { n: tr.number }), body: t('The stock goes back to {name}, as if it never left.', { name: tr.from.name }), confirm: t('Cancel the transfer'), cancel: t('Keep it'), danger: true }))) return;
    setBusy(tr.id);
    setError(null);
    try {
      await api(`/v1/transfers/${tr.id}/${how}`, { method: 'POST' });
      toast(how === 'receive' ? t('{n} received at {name}', { n: tr.number, name: tr.to.name }) : t('{n} cancelled', { n: tr.number }));
      await load();
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="card stack">
      <div className="row">
        <p className="small muted grow" style={{ margin: 0 }}>{t('Stock sent from one location to another. It leaves the first when sent and counts at the second once received; in between it is on the way.')}</p>
        {manage && <button type="button" onClick={() => setMoving(true)}>{t('Move stock')}</button>}
      </div>
      <ErrorText error={error} />
      {!rows ? <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? <div className="empty">{t('No transfers yet.')}</div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Transfer')}</th><th scope="col">{t('From')}</th><th scope="col">{t('To')}</th><th scope="col">{t('Items')}</th><th scope="col">{t('Status')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {rows.map((tr) => (
                <tr key={tr.id}>
                  <td data-label={t('Transfer')}><strong className="mono">{tr.number}</strong><div className="small muted">{new Date(tr.sentAt).toLocaleDateString()}{tr.sentBy ? ` · ${tr.sentBy}` : ''}</div></td>
                  <td data-label={t('From')}>{tr.from.name}</td>
                  <td data-label={t('To')}>{tr.to.name}</td>
                  <td data-label={t('Items')} className="small">{tr.lines.map((l) => `${qtyText(l.quantity)} × ${l.name}`).join(', ')}{tr.note && <div className="muted">{tr.note}</div>}</td>
                  <td data-label={t('Status')}><span className={`badge ${STATUS[tr.status][1]}`}>{t(STATUS[tr.status][0])}</span>{tr.receivedBy && <div className="small muted">{tr.receivedBy}</div>}</td>
                  <td className="right">
                    {tr.status === 'sent' && manage && (
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <button type="button" className="secondary small-button" disabled={busy === tr.id} onClick={() => void finish(tr, 'receive')}>{t('Receive')}</button>
                        <button type="button" className="link danger-link small" disabled={busy === tr.id} onClick={() => void finish(tr, 'cancel')}>{t('Cancel')}</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {moving && <MoveStockModal places={places} onClose={() => setMoving(false)} onSent={(tr) => { setMoving(false); toast(t('{n} is on the way to {name}', { n: tr.number, name: tr.to.name })); void load(); onChange(); }} />}
    </section>
  );
}

interface MoveLine { key: number; item: (Item & { at?: Record<string, number> }) | null; quantity: string }
let moveKey = 0;
const QTY = /^\d{1,12}(\.\d{1,3})?$/;

function MoveStockModal({ places, onClose, onSent }: { places: Place[]; onClose: () => void; onSent: (t: Transfer) => void }) {
  const t = useT();
  const [from, setFrom] = useState(places.find((p) => p.main)?.id ?? places[0]?.id ?? '');
  const [to, setTo] = useState(places.find((p) => !p.main)?.id ?? '');
  const [lines, setLines] = useState<MoveLine[]>(() => [{ key: ++moveKey, item: null, quantity: '' }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What is at the location it leaves, to show beside each item.
  const [here, setHere] = useState<Record<string, number>>({});
  const update = (key: number, patch: Partial<MoveLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pick = async (key: number, it: Item) => {
    update(key, { item: it });
    try {
      const s = await api<{ at?: Record<string, number> }>(`/v1/inventory/${it.id}`);
      setHere((h) => ({ ...h, [it.id]: s.at?.[from] ?? 0 }));
    } catch { /* the server says so when it is sent */ }
  };
  useEffect(() => setHere({}), [from]);
  const ready = lines.filter((l) => l.item && QTY.test(l.quantity) && Number(l.quantity) > 0);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSent(await api<Transfer>('/v1/transfers', { method: 'POST', body: { fromLocationId: from, toLocationId: to, lines: ready.map((l) => ({ itemId: l.item!.id, quantity: l.quantity })), ...(note.trim() && { note: note.trim() }) } }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Move stock')} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void send(e)}>
        <div className="form-grid">
          <Field label={t('From')}><Select value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value === to) setTo(places.find((p) => p.id !== e.target.value)?.id ?? ''); }}>{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label={t('To')}><Select value={to} onChange={(e) => setTo(e.target.value)}>{places.filter((p) => p.id !== from).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        </div>
        {lines.map((l, i) => {
          const have = l.item ? here[l.item.id] : undefined;
          const over = have !== undefined && QTY.test(l.quantity) && Number(l.quantity) > have;
          return (
            <div key={l.key} className="receive-line">
              <Field label={t('Item {n}', { n: i + 1 })} className="grow" hint={l.item && have !== undefined ? t('{n} at {name}', { n: qtyText(have), name: places.find((p) => p.id === from)?.name ?? '' }) : undefined}>
                <Combobox<Item>
                  placeholder={t('Search your items or scan a barcode')}
                  search={(q) => api<Page<Item>>(`/v1/items?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data.filter((it) => it.stock !== null && it.stock !== undefined))}
                  render={(it) => <><strong>{it.name}</strong><span className="muted"> · {t('{n} in stock', { n: it.stock ?? 0 })}</span></>}
                  value={l.item?.name ?? ''}
                  onText={() => update(l.key, { item: null })}
                  onPick={(it) => void pick(l.key, it)}
                />
              </Field>
              <Field label={l.item ? t('Quantity ({unit})', { unit: unitName(t, l.item.unitCode).toLowerCase() }) : t('Quantity')}><input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value.trim() })} aria-invalid={over || undefined} /></Field>
              {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>{t('Remove')}</button>}
            </div>
          );
        })}
        <div><button type="button" className="secondary small-button" onClick={() => setLines([...lines, { key: ++moveKey, item: null, quantity: '' }])}>+ {t('Add item')}</button></div>
        <Field label={t('Note')} hint={t('Optional: who carries it, the boat or bus.')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !to || ready.length === 0 || ready.length !== lines.filter((l) => l.item || l.quantity).length}>{busy ? t('Sending…') : t('Send {n} items', { n: ready.length })}</button></div>
      </form>
    </Modal>
  );
}
