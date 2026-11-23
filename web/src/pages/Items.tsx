import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type Item, type Page } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, GST_CATEGORIES, Modal, money, Select, unitName, UNITS, useDebounced, usePageTitle } from '../ui';
import { ImportDialog } from './ImportDialog';

type Form = { name: string; description: string; sellerCode: string; barcode: string; unitCode: string; unitPrice: string; wholesalePrice: string; gstCategory: string; exemptionReasonCode: string; favorite: boolean };
const EMPTY: Form = { name: '', description: '', sellerCode: '', barcode: '', unitCode: 'H87', unitPrice: '', wholesalePrice: '', gstCategory: 'S', exemptionReasonCode: '', favorite: false };

const toForm = (i: Item): Form => ({
  name: i.name,
  description: i.description === i.name ? '' : i.description,
  sellerCode: i.sellerCode ?? '',
  barcode: i.barcode ?? '',
  unitCode: i.unitCode,
  unitPrice: i.unitPrice,
  wholesalePrice: i.wholesalePrice ?? '',
  gstCategory: i.gstCategory,
  exemptionReasonCode: i.exemptionReasonCode ?? '',
  favorite: i.favorite,
});

const itemBody = (f: Form) => ({
  name: f.name.trim(),
  ...(f.description.trim() && { description: f.description.trim() }),
  ...(f.sellerCode.trim() && { sellerCode: f.sellerCode.trim() }),
  ...(f.barcode.trim() && { barcode: f.barcode.trim() }),
  unitCode: f.unitCode,
  unitPrice: f.unitPrice,
  wholesalePrice: f.wholesalePrice.trim() || null,
  gstCategory: f.gstCategory,
  ...(f.gstCategory === 'E' && { exemptionReasonCode: f.exemptionReasonCode.trim() }),
  favorite: f.favorite,
});

function ItemForm(props: { initial?: Item; onSaved: (i: Item) => void; onCancel: () => void }) {
  const t = useT();
  const [form, setForm] = useState<Form>(props.initial ? toForm(props.initial) : EMPTY);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = props.initial
        ? await api<Item>(`/v1/items/${props.initial.id}`, { method: 'PUT', body: itemBody(form) })
        : await api<Item>('/v1/items', { method: 'POST', body: itemBody(form) });
      props.onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label={t('Name')}><input required autoFocus value={form.name} onChange={set('name')} /></Field>
        <Field label={t('Description')} hint={t('Printed on documents. Defaults to the name.')}><input value={form.description} onChange={set('description')} /></Field>
      </div>
      <div className="form-grid">
        <Field label={t('Your code')} hint={t('SKU, optional. Type it at the counter to add the item.')}><input value={form.sellerCode} onChange={set('sellerCode')} /></Field>
        <Field label={t('Barcode')} hint={t('Scan it into this box.')}><input inputMode="numeric" pattern="[0-9A-Za-z\-]{1,64}" value={form.barcode} onChange={set('barcode')} /></Field>
      </div>
      <div className="form-grid">
        <Field label={t('Unit')}><Select value={form.unitCode} onChange={set('unitCode')}>{UNITS.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
        <Field label={t('Price (BZ$, before GST)')}><input required inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={form.unitPrice} onChange={set('unitPrice')} /></Field>
        <Field label={t('Wholesale price')} hint={t('Before GST, for wholesale customers. Optional.')}><input inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={form.wholesalePrice} onChange={set('wholesalePrice')} /></Field>
        <Field label="GST"><Select value={form.gstCategory} onChange={set('gstCategory')}>{GST_CATEGORIES.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
        {form.gstCategory === 'E' && <Field label={t('Exemption reason code')}><input required value={form.exemptionReasonCode} onChange={set('exemptionReasonCode')} /></Field>}
      </div>
      <label className="row small"><input type="checkbox" checked={form.favorite} onChange={(e) => setForm({ ...form, favorite: e.target.checked })} /> {t('Show as a quick button at the counter')}</label>
      <ErrorText error={error} />
      <div className="row">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={props.onCancel}>{t('Cancel')}</button>
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save item')}</button>
      </div>
    </form>
  );
}

/** The plain item list (counter and invoices). Shown inside the Products page. */
export function Items() {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const manage = can('catalog.manage');
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [list, setList] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState<Item | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = async (after?: string) => {
    try {
      const r = await api<Page<Item>>(`/v1/items?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}${after ? `&cursor=${after}` : ''}`);
      setList(after ? [...(list ?? []), ...r.data] : r.data);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
      setList([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggleFavorite = async (it: Item) => {
    try {
      const saved = await api<Item>(`/v1/items/${it.id}`, { method: 'PUT', body: itemBody({ ...toForm(it), favorite: !it.favorite }) });
      setList((l) => l?.map((x) => (x.id === it.id ? saved : x)) ?? null);
    } catch (e) {
      setError(e);
    }
  };
  const archive = async () => {
    if (!archiving) return;
    try {
      await api(`/v1/items/${archiving.id}`, { method: 'DELETE' });
      toast(t('{name} archived', { name: archiving.name }));
      setArchiving(null);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div><h2>{t('All items')}</h2></div>
        <span className="spacer" />
        <Link className="button secondary" to="/labels" viewTransition>{t('Print labels')}</Link>
        {manage && <button type="button" className="secondary" onClick={() => setImporting(true)}>{t('Import')}</button>}
        {manage && <button onClick={() => setEditing('new')}>{t('Add item')}</button>}
      </div>
      <p className="muted small">{t('Everything you sell at the counter and on invoices, including each variant of your products. Star an item to make it a quick button at the counter.')}</p>
      <input type="search" placeholder={t('Search by name, code or barcode')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search items')} />
      <ErrorText error={error} />
      <section className="card">
        {list === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : list.length === 0 ? <div className="empty">{query ? t('No items match your search.') : t('No items yet.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col"><span className="sr-only">{t('Quick button')}</span></th><th scope="col">{t('Item')}</th><th scope="col">{t('Code')}</th><th scope="col">{t('Unit')}</th><th scope="col" className="right">{t('Price')}</th><th scope="col">GST</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {list.map((it) => (
                  <tr key={it.id}>
                    <td className="star-cell">
                      <button className={`star ${it.favorite ? 'on' : ''}`} aria-pressed={it.favorite} aria-label={t('Quick button for {name}', { name: it.name })} disabled={!manage} onClick={() => void toggleFavorite(it)}>★</button>
                    </td>
                    <td data-label={t('Item')}><strong>{it.name}</strong>{it.description !== it.name && <div className="small muted">{it.description}</div>}</td>
                    <td data-label={t('Code')} className="mono">{[it.sellerCode, it.barcode].filter(Boolean).join(' · ') || '—'}</td>
                    <td data-label={t('Unit')}>{unitName(t, it.unitCode)}</td>
                    <td data-label={t('Price')} className="right">{money(it.unitPrice)}</td>
                    <td data-label="GST">{t(GST_CATEGORIES.find(([c]) => c === it.gstCategory)?.[1] ?? '')}</td>
                    <td className="right actions">
                      {manage && <button className="link" onClick={() => setEditing(it)}>{t('Edit')}</button>}
                      {manage && <button className="link" onClick={() => setArchiving(it)}>{t('Archive')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && <button className="secondary" onClick={() => void load(cursor)}>{t('Load more')}</button>}
      </section>

      {importing && <ImportDialog kind="items" onClose={() => setImporting(false)} onDone={() => void load()} />}
      {editing && (
        <Modal wide title={editing === 'new' ? t('Add item') : t('Edit {name}', { name: editing.name })} onClose={() => setEditing(null)}>
          <ItemForm
            {...(editing !== 'new' && { initial: editing })}
            onCancel={() => setEditing(null)}
            onSaved={(i) => {
              toast(editing === 'new' ? t('{name} added', { name: i.name }) : t('{name} saved', { name: i.name }));
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      )}
      {archiving && (
        <Modal title={t('Archive {name}?', { name: archiving.name })} onClose={() => setArchiving(null)}>
          <p>{t('It disappears from your catalog and the counter. Documents already issued are not affected.')}</p>
          <div className="row">
            <span className="spacer" />
            <button className="secondary" onClick={() => setArchiving(null)}>{t('Keep')}</button>
            <button className="danger" onClick={() => void archive()}>{t('Archive')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
