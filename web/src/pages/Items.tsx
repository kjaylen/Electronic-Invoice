import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link, type Item, type Page } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { Combobox, ErrorText, Field, GST_CATEGORIES, Modal, money, Select, unitName, UNITS, useDebounced, usePageTitle } from '../ui';
import { ImportDialog } from './ImportDialog';

type Form = { name: string; description: string; sellerCode: string; barcode: string; category: string; unitCode: string; unitPrice: string; wholesalePrice: string; gstCategory: string; exemptionReasonCode: string; favorite: boolean };
const EMPTY: Form = { name: '', description: '', sellerCode: '', barcode: '', category: '', unitCode: 'H87', unitPrice: '', wholesalePrice: '', gstCategory: 'S', exemptionReasonCode: '', favorite: false };

export interface Category { name: string; items: number }
interface Part { key: number; item: { id: string; name: string } | null; quantity: string }
let partKey = 0;

const toForm = (i: Item): Form => ({
  name: i.name,
  description: i.description === i.name ? '' : i.description,
  sellerCode: i.sellerCode ?? '',
  barcode: i.barcode ?? '',
  category: i.category ?? '',
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
  category: f.category.trim() || null,
  unitCode: f.unitCode,
  unitPrice: f.unitPrice,
  wholesalePrice: f.wholesalePrice.trim() || null,
  gstCategory: f.gstCategory,
  ...(f.gstCategory === 'E' && { exemptionReasonCode: f.exemptionReasonCode.trim() }),
  favorite: f.favorite,
});

function ItemForm(props: { initial?: Item; categories: Category[]; onSaved: (i: Item) => void; onCancel: () => void }) {
  const t = useT();
  const [form, setForm] = useState<Form>(props.initial ? toForm(props.initial) : EMPTY);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // What the item costs on average (from stock received), for the margin at the price typed.
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    if (!props.initial) return;
    api<{ averageCost: string | null }>(`/v1/inventory/${props.initial.id}`).then((r) => { if (r.averageCost !== null) setCost(Number(r.averageCost)); }).catch(() => {});
  }, [props.initial]);
  const marginHint = (price: string) => {
    if (cost === null || !/^\d+(\.\d{1,6})?$/.test(price) || Number(price) <= 0) return null;
    const pct = Math.round(((Number(price) - cost) / Number(price)) * 1000) / 10;
    return pct < 0 ? t('Below its cost of {cost}: a loss of {pct}% on each sale.', { cost: money(cost.toFixed(2)), pct: Math.abs(pct) }) : t('Costs {cost} on average: a {pct}% margin.', { cost: money(cost.toFixed(2)), pct });
  };
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // A bundle: the items it is made of (selling it takes them off the shelf).
  const [parts, setParts] = useState<Part[]>([]);
  const [hadParts, setHadParts] = useState(false);
  const [bundle, setBundle] = useState(false);
  useEffect(() => {
    if (!props.initial) return;
    api<{ data: Array<{ itemId: string; name: string; quantity: string }>; cost: string | null }>(`/v1/items/${props.initial.id}/components`).then((r) => {
      if (!r.data.length) return;
      setParts(r.data.map((c) => ({ key: ++partKey, item: { id: c.itemId, name: c.name }, quantity: c.quantity })));
      setHadParts(true);
      setBundle(true);
      if (r.cost !== null) setCost(Number(r.cost));
    }).catch(() => {});
  }, [props.initial]);
  const filledParts = parts.filter((p) => p.item);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = props.initial
        ? await api<Item>(`/v1/items/${props.initial.id}`, { method: 'PUT', body: itemBody(form) })
        : await api<Item>('/v1/items', { method: 'POST', body: itemBody(form) });
      if (bundle || hadParts) {
        await api(`/v1/items/${saved.id}/components`, { method: 'PUT', body: { components: bundle ? filledParts.map((p) => ({ itemId: p.item!.id, quantity: p.quantity || '1' })) : [] } });
      }
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
        <Field label={t('Category')} hint={t('Coffee, Bakery, Hardware… Groups the counter buttons and reports.')}>
          <input list="item-categories" maxLength={80} value={form.category} onChange={set('category')} />
        </Field>
        <datalist id="item-categories">{props.categories.map((c) => <option key={c.name} value={c.name} />)}</datalist>
      </div>
      <div className="form-grid">
        <Field label={t('Unit')}><Select value={form.unitCode} onChange={set('unitCode')}>{UNITS.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
        <Field label={t('Price (BZ$, before GST)')} {...(marginHint(form.unitPrice) && { hint: marginHint(form.unitPrice)! })}><input required inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={form.unitPrice} onChange={set('unitPrice')} /></Field>
        <Field label={t('Wholesale price')} hint={marginHint(form.wholesalePrice) ?? t('Before GST, for wholesale customers. Optional.')}><input inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={form.wholesalePrice} onChange={set('wholesalePrice')} /></Field>
        <Field label="GST"><Select value={form.gstCategory} onChange={set('gstCategory')}>{GST_CATEGORIES.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
        {form.gstCategory === 'E' && <Field label={t('Exemption reason code')}><input required value={form.exemptionReasonCode} onChange={set('exemptionReasonCode')} /></Field>}
      </div>
      <label className="row small"><input type="checkbox" checked={form.favorite} onChange={(e) => setForm({ ...form, favorite: e.target.checked })} /> {t('Show as a quick button at the counter')}</label>
      <label className="row small"><input type="checkbox" checked={bundle} onChange={(e) => { setBundle(e.target.checked); if (e.target.checked && !parts.length) setParts([{ key: ++partKey, item: null, quantity: '1' }]); }} /> {t('A bundle of other items (a combo, a gift basket)')}</label>
      {bundle && (
        <fieldset className="stack bundle-parts">
          <legend>{t('Made up of')}</legend>
          {parts.map((p, i) => (
            <div key={p.key} className="bundle-part">
              <Combobox<Item>
                label={t('Item {n}', { n: i + 1 })}
                placeholder={t('Search your items')}
                search={(q) => api<Page<Item>>(`/v1/items?limit=8&q=${encodeURIComponent(q)}`).then((r) => r.data.filter((it) => it.id !== props.initial?.id))}
                render={(it) => <><strong>{it.name}</strong> <span className="muted">· {money(it.unitPrice)}</span></>}
                value={p.item?.name ?? ''}
                onText={() => setParts((ps) => ps.map((x) => (x.key === p.key ? { ...x, item: null } : x)))}
                onPick={(it) => setParts((ps) => ps.map((x) => (x.key === p.key ? { ...x, item: { id: it.id, name: it.name } } : x)))}
              />
              <Field label={t('Quantity')}><input inputMode="decimal" pattern="\d{1,9}(\.\d{1,3})?" value={p.quantity} onChange={(e) => setParts((ps) => ps.map((x) => (x.key === p.key ? { ...x, quantity: e.target.value.trim() } : x)))} /></Field>
              <button type="button" className="link" onClick={() => setParts((ps) => ps.filter((x) => x.key !== p.key))}>{t('Remove')}</button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="secondary" onClick={() => setParts([...parts, { key: ++partKey, item: null, quantity: '1' }])}>+ {t('Add item')}</button>
          </div>
          <p className="small muted">{t('Selling the bundle takes its items off the shelf; its cost is theirs added up.')}</p>
        </fieldset>
      )}
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
  const [repricing, setRepricing] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  // '' every item, '\u0000' items without a category, otherwise that category.
  const [category, setCategory] = useState('');
  const [error, setError] = useState<unknown>(null);

  const loadCategories = () => api<{ data: Category[] }>('/v1/items/categories').then((r) => setCategories(r.data)).catch(() => {});
  useEffect(() => {
    void loadCategories();
  }, []);
  const load = async (after?: string) => {
    try {
      const filter = category === '' ? '' : `&category=${category === '\u0000' ? '' : encodeURIComponent(category)}`;
      const r = await api<Page<Item>>(`/v1/items?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}${filter}${after ? `&cursor=${after}` : ''}`);
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
  }, [query, category]);

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
        {manage && <a className="button secondary" href={link('/v1/items/export.csv')} download>{t('Export')}</a>}
        {manage && <button type="button" className="secondary" onClick={() => setImporting(true)}>{t('Import')}</button>}
        {manage && <button type="button" className="secondary" onClick={() => setRepricing(true)}>{t('Change prices')}</button>}
        {manage && <button onClick={() => setEditing('new')}>{t('Add item')}</button>}
      </div>
      <p className="muted small">{t('Everything you sell at the counter and on invoices, including each variant of your products. Star an item to make it a quick button at the counter.')}</p>
      <div className="row items-filter">
        <input type="search" placeholder={t('Search by name, code or barcode')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search items')} />
        {categories.length > 0 && (
          <Select aria-label={t('Category')} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('Every category')}</option>
            {categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.items})</option>)}
            <option value={'\u0000'}>{t('No category')}</option>
          </Select>
        )}
      </div>
      <ErrorText error={error} />
      <section className="card">
        {list === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : list.length === 0 ? <div className="empty">{query ? t('No items match your search.') : t('No items yet.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col"><span className="sr-only">{t('Quick button')}</span></th><th scope="col">{t('Item')}</th><th scope="col">{t('Category')}</th><th scope="col">{t('Code')}</th><th scope="col">{t('Unit')}</th><th scope="col" className="right">{t('Price')}</th><th scope="col">GST</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {list.map((it) => (
                  <tr key={it.id}>
                    <td className="star-cell">
                      <button className={`star ${it.favorite ? 'on' : ''}`} aria-pressed={it.favorite} aria-label={t('Quick button for {name}', { name: it.name })} disabled={!manage} onClick={() => void toggleFavorite(it)}>★</button>
                    </td>
                    <td data-label={t('Item')}><strong>{it.name}</strong>{it.bundle && <span className="badge test bundle-badge">{t('Bundle')}</span>}{it.description !== it.name && <div className="small muted">{it.description}</div>}</td>
                    <td data-label={t('Category')}>{it.category ? <button type="button" className="cat-tag" onClick={() => setCategory(it.category!)}>{it.category}</button> : <span className="muted">—</span>}</td>
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

      {importing && <ImportDialog kind="items" onClose={() => setImporting(false)} onDone={() => { void load(); void loadCategories(); }} />}
      {repricing && (
        <RepriceDialog
          categories={categories}
          initialCategory={category}
          onClose={() => setRepricing(false)}
          onDone={(n) => {
            toast(t('{n} prices changed', { n }));
            setRepricing(false);
            void load();
          }}
        />
      )}
      {editing && (
        <Modal wide title={editing === 'new' ? t('Add item') : t('Edit {name}', { name: editing.name })} onClose={() => setEditing(null)}>
          <ItemForm
            {...(editing !== 'new' && { initial: editing })}
            categories={categories}
            onCancel={() => setEditing(null)}
            onSaved={(i) => {
              toast(editing === 'new' ? t('{name} added', { name: i.name }) : t('{name} saved', { name: i.name }));
              setEditing(null);
              void load();
              void loadCategories();
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

interface RepriceResult { dryRun: boolean; matched: number; changed: number; changes: Array<{ id: string; name: string; from: string | null; to: string }> }

/** Change many prices at once: up or down by a percentage or an amount, or to one price; for a category or every item. */
function RepriceDialog(props: { categories: Category[]; initialCategory: string; onClose: () => void; onDone: (changed: number) => void }) {
  const t = useT();
  const [category, setCategory] = useState(props.initialCategory);
  const [mode, setMode] = useState<'percent' | 'amount' | 'set'>('percent');
  const [value, setValue] = useState('');
  const [price, setPrice] = useState<'retail' | 'wholesale'>('retail');
  const [roundTo, setRoundTo] = useState('');
  const [preview, setPreview] = useState<RepriceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = /^-?\d{1,9}(\.\d{1,6})?$/.test(value.trim()) && !(mode === 'set' && value.trim().startsWith('-'));
  const body = (dryRun: boolean) => ({
    ...(category !== '' && { category: category === '\u0000' ? null : category }),
    mode, value: value.trim(), price, dryRun,
    ...(roundTo && { roundTo }),
  });
  // A fresh preview whenever the change does.
  useEffect(() => {
    setPreview(null);
    if (!valid) return;
    const timer = setTimeout(() => {
      api<RepriceResult>('/v1/items/reprice', { method: 'POST', body: body(true) }).then(setPreview).catch(setError);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, mode, value, price, roundTo]);
  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<RepriceResult>('/v1/items/reprice', { method: 'POST', body: body(false) });
      props.onDone(r.changed);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal wide title={t('Change prices')} onClose={props.onClose}>
      <form className="stack" onSubmit={apply}>
        <div className="form-grid">
          <Field label={t('Items')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('Every item')}</option>
              {props.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.items})</option>)}
              <option value={'\u0000'}>{t('No category')}</option>
            </Select>
          </Field>
          <Field label={t('Price')}>
            <Select value={price} onChange={(e) => setPrice(e.target.value as 'retail' | 'wholesale')}>
              <option value="retail">{t('Price')}</option>
              <option value="wholesale">{t('Wholesale price')}</option>
            </Select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label={t('Change')}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'percent' | 'amount' | 'set')}>
              <option value="percent">{t('By a percentage')}</option>
              <option value="amount">{t('By an amount (BZ$)')}</option>
              <option value="set">{t('To one price (BZ$)')}</option>
            </Select>
          </Field>
          <Field label={mode === 'percent' ? t('Percent') : t('Amount')} hint={mode === 'set' ? t('Before GST.') : t('Negative lowers prices, e.g. -10.')}>
            <input required autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'percent' ? '5' : '0.50'} />
          </Field>
          <Field label={t('Round up to')}>
            <Select value={roundTo} onChange={(e) => setRoundTo(e.target.value)}>
              <option value="">{t('The cent')}</option>
              <option value="0.05">{t('5 cents')}</option>
              <option value="0.25">{t('25 cents')}</option>
              <option value="1.00">{t('A whole dollar')}</option>
            </Select>
          </Field>
        </div>
        {preview && (
          preview.changed === 0 ? <p className="muted">{t('No price would change.')}</p> : (
            <div className="stack">
              <p className="small">{t('{n} of {m} items change:', { n: preview.changed, m: preview.matched })}</p>
              <div className="table-wrap reprice-preview">
                <table>
                  <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Now')}</th><th scope="col" className="right">{t('New')}</th></tr></thead>
                  <tbody>
                    {preview.changes.slice(0, 50).map((c) => (
                      <tr key={c.id}><td>{c.name}</td><td className="right muted num">{c.from === null ? '—' : money(c.from)}</td><td className="right num"><strong>{money(c.to)}</strong></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.changed > 50 && <p className="small muted">{t('And {n} more.', { n: preview.changed - 50 })}</p>}
            </div>
          )
        )}
        <p className="small muted">{t('Documents already issued keep their prices.')}</p>
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={props.onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || !preview || preview.changed === 0}>{busy ? t('Saving…') : preview?.changed ? t('Change {n} prices', { n: preview.changed }) : t('Change prices')}</button>
        </div>
      </form>
    </Modal>
  );
}
