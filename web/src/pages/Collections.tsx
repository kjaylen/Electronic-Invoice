/**
 * Collections: groups of products with their own page in the store, picked by
 * hand (in the order chosen) or gathered by rules (a category, a word in the
 * title, a tag, a price, on sale, in stock, newly added).
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money } from '../ui';
import { ImageInput, ProductsInput } from '../site/editor-fields';
import type { Builder, SiteDoc } from '../site/types';

interface Condition { field: string; op: string; value: string }
interface Rules { match: 'all' | 'any'; conditions: Condition[] }
interface Collection {
  id: string;
  handle: string;
  title: string;
  description: string;
  image: string | null;
  rules: Rules | null;
  products: string[] | null;
  sort: string;
  published: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  productCount: number | null;
}

const FIELDS: Array<[string, string, string[]]> = [
  ['category', 'Category', ['is', 'is_not', 'contains']],
  ['title', 'Title', ['contains', 'is', 'is_not']],
  ['tag', 'Tag', ['is', 'is_not']],
  ['price', 'Price (with GST)', ['lt', 'gt']],
  ['on_sale', 'On sale', ['is', 'is_not']],
  ['in_stock', 'In stock', ['is', 'is_not']],
  ['new', 'Added in the last', ['within_days']],
];
const OPS: Record<string, string> = { is: 'is', is_not: 'is not', contains: 'contains', lt: 'is under BZ$', gt: 'is over BZ$', within_days: 'days' };
const SORTS: Array<[string, string]> = [['manual', 'In the order picked'], ['newest', 'Newest first'], ['price_asc', 'Price, low to high'], ['price_desc', 'Price, high to low'], ['title', 'Name, A to Z'], ['best_selling', 'Best selling']];

export function Collections() {
  const t = useT();
  const [data, setData] = useState<Collection[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Collection | 'new' | null>(null);
  const load = useCallback(() => void api<{ data: Collection[] }>('/v1/collections').then((r) => setData(r.data)).catch(setError), []);
  useEffect(load, [load]);
  return (
    <div className="stack">
      <div className="row">
        <p className="small muted" style={{ margin: 0, maxWidth: '44rem' }}>{t('A collection is a page of products in your store: pick them by hand, or let rules gather them (a category, a tag, a price, on sale). Show collections in the site’s menu and sections.')}</p>
        <span className="spacer" />
        <button type="button" onClick={() => setEditing('new')}>{t('Add collection')}</button>
      </div>
      <ErrorText error={error} />
      <section className="card">
        {data === null ? <div className="skeleton" style={{ height: '5rem' }} /> : data.length === 0 ? <div className="empty">{t('No collections yet.')}</div> : (
          <div className="table-wrap">
            <table className="responsive clickable">
              <thead><tr><th scope="col">{t('Collection')}</th><th scope="col">{t('Products')}</th><th scope="col">{t('How')}</th><th scope="col">{t('In the store')}</th></tr></thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} onClick={() => setEditing(c)}>
                    <td data-label={t('Collection')}><button type="button" className="link" onClick={(e) => { e.stopPropagation(); setEditing(c); }}>{c.title}</button><div className="small muted">/shop/collections/{c.handle}</div></td>
                    <td data-label={t('Products')}>{c.productCount ?? '—'}</td>
                    <td data-label={t('How')} className="small">{c.rules ? t('By rules') : t('Picked by hand')}</td>
                    <td data-label={t('In the store')}><span className={`badge ${c.published ? 'authorized' : 'test'}`}>{c.published ? t('Shown') : t('Hidden')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && <CollectionEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function CollectionEditor({ initial, onClose, onSaved }: { initial: Collection | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const slug = session?.business.slug ?? '';
  const [form, setForm] = useState({
    title: initial?.title ?? '', handle: initial?.handle ?? '', description: initial?.description ?? '', image: initial?.image ?? '',
    mode: initial?.rules ? 'rules' as const : 'manual' as const, products: initial?.products ?? [] as string[],
    rules: initial?.rules ?? { match: 'all' as const, conditions: [{ field: 'category', op: 'is', value: '' }] },
    sort: initial?.sort ?? 'manual', published: initial?.published ?? true, seoTitle: initial?.seoTitle ?? '', seoDescription: initial?.seoDescription ?? '',
  });
  const [preview, setPreview] = useState<{ count: number; data: Array<{ handle: string; title: string; price: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    void api<{ builder: Builder; draft: SiteDoc }>('/v1/store-site').then((r) => setCategories(r.builder.categories)).catch(() => {});
  }, []);
  const rulesKey = JSON.stringify(form.mode === 'rules' ? form.rules : null);
  useEffect(() => {
    if (form.mode !== 'rules') return setPreview(null);
    const rules = JSON.parse(rulesKey) as Rules;
    if (rules.conditions.some((c) => ['category', 'title', 'tag'].includes(c.field) && !c.value.trim())) return setPreview(null);
    const timer = setTimeout(() => void api<{ count: number; data: Array<{ handle: string; title: string; price: string }> }>('/v1/collections/preview', { method: 'POST', body: { rules, sort: form.sort === 'manual' ? 'newest' : form.sort } }).then(setPreview).catch(() => setPreview(null)), 350);
    return () => clearTimeout(timer);
  }, [rulesKey, form.mode, form.sort]);
  const setCondition = (i: number, c: Partial<Condition>) => setForm({ ...form, rules: { ...form.rules, conditions: form.rules.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) } });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: form.title.trim(), ...(form.handle && { handle: form.handle }), description: form.description, image: form.image || null,
        rules: form.mode === 'rules' ? { match: form.rules.match, conditions: form.rules.conditions.map((c) => ({ ...c, value: c.field === 'on_sale' || c.field === 'in_stock' ? 'yes' : c.value.trim() })) } : null,
        products: form.mode === 'manual' ? form.products : [], sort: form.mode === 'rules' && form.sort === 'manual' ? 'newest' : form.sort,
        published: form.published, seoTitle: form.seoTitle.trim() || null, seoDescription: form.seoDescription.trim() || null,
      };
      if (initial) await api(`/v1/collections/${initial.id}`, { method: 'PUT', body });
      else await api('/v1/collections', { method: 'POST', body });
      toast(t('Collection saved'));
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial || !window.confirm(t('Delete the collection “{title}”? Its products stay; menus that link to it will show all collections.', { title: initial.title }))) return;
    await api(`/v1/collections/${initial.id}`, { method: 'DELETE' });
    onSaved();
  };
  const editorCtx = { slug, builder: { sections: [], presets: [], fonts: [], icons: [], linkTypes: [], themeOptions: {}, categories, collections: [] }, site: null as unknown as SiteDoc };
  return (
    <Modal title={initial ? initial.title : t('Add collection')} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label={t('Title')}><input required autoFocus maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label={t('Address')} hint={t('Made from the title when left empty.')}><input placeholder="summer-sale" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></Field>
        </div>
        <Field label={t('Description')} hint={t('Shown at the top of the collection’s page. **bold**, *italics* and [links](https://…) work.')}><textarea rows={3} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <ImageInput label={t('Picture')} value={form.image} ctx={editorCtx} onChange={(v) => setForm({ ...form, image: v })} />
        <div className="se-choice">
          <span className="field-label">{t('Products')}</span>
          <div className="tabs" role="group" aria-label={t('Products')}>
            <button type="button" aria-pressed={form.mode === 'manual'} className={form.mode === 'manual' ? 'active' : ''} onClick={() => setForm({ ...form, mode: 'manual', sort: 'manual' })}>{t('Pick them by hand')}</button>
            <button type="button" aria-pressed={form.mode === 'rules'} className={form.mode === 'rules' ? 'active' : ''} onClick={() => setForm({ ...form, mode: 'rules', sort: form.sort === 'manual' ? 'newest' : form.sort })}>{t('Gather them by rules')}</button>
          </div>
        </div>
        {form.mode === 'manual' ? <ProductsInput label={t('Products, in order')} value={form.products} max={500} onChange={(products) => setForm({ ...form, products })} /> : (
          <div className="stack card collection-rules">
            <div className="row small">
              {t('Products that match')}
              <select aria-label={t('Match')} value={form.rules.match} onChange={(e) => setForm({ ...form, rules: { ...form.rules, match: e.target.value as 'all' | 'any' } })} style={{ width: 'auto' }}>
                <option value="all">{t('all of these')}</option>
                <option value="any">{t('any of these')}</option>
              </select>
            </div>
            {form.rules.conditions.map((c, i) => {
              const def = FIELDS.find(([f]) => f === c.field)!;
              const yesNo = c.field === 'on_sale' || c.field === 'in_stock';
              return (
                <div key={i} className="row collection-rule">
                  <select aria-label={t('Field')} value={c.field} onChange={(e) => { const f = FIELDS.find(([x]) => x === e.target.value)!; setCondition(i, { field: f[0], op: f[2][0]!, value: f[0] === 'new' ? '30' : '' }); }}>
                    {FIELDS.map(([f, l]) => <option key={f} value={f}>{t(l)}</option>)}
                  </select>
                  <select aria-label={t('Condition')} value={c.op} onChange={(e) => setCondition(i, { op: e.target.value })}>
                    {def[2].map((o) => <option key={o} value={o}>{yesNo ? (o === 'is' ? t('yes') : t('no')) : t(OPS[o]!)}</option>)}
                  </select>
                  {!yesNo && (c.field === 'category' && c.op !== 'contains' && categories.length ? (
                    <select aria-label={t('Value')} value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })}>
                      <option value="">{t('Choose')}</option>
                      {categories.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  ) : <input aria-label={t('Value')} inputMode={c.field === 'price' || c.field === 'new' ? 'decimal' : 'text'} value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} />)}
                  {form.rules.conditions.length > 1 && <button type="button" className="link small" onClick={() => setForm({ ...form, rules: { ...form.rules, conditions: form.rules.conditions.filter((_, j) => j !== i) } })} aria-label={t('Remove')}>✕</button>}
                </div>
              );
            })}
            {form.rules.conditions.length < 10 && <button type="button" className="secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setForm({ ...form, rules: { ...form.rules, conditions: [...form.rules.conditions, { field: 'tag', op: 'is', value: '' }] } })}>+ {t('Add a condition')}</button>}
            {preview && (
              <div className="small">
                <strong>{preview.count === 1 ? t('1 product matches') : t('{n} products match', { n: preview.count })}</strong>
                {preview.data.length > 0 && <span className="muted">: {preview.data.slice(0, 6).map((p) => `${p.title} (${money(p.price)})`).join(', ')}{preview.count > 6 ? '…' : ''}</span>}
              </div>
            )}
          </div>
        )}
        <div className="form-grid">
          <Field label={t('Order in the store')}>
            <select value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })}>
              {SORTS.filter(([k]) => k !== 'manual' || form.mode === 'manual').map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
            </select>
          </Field>
          <label className="row toggle" style={{ alignSelf: 'end', paddingBottom: '0.55rem' }}><input type="checkbox" checked={form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} /> {t('Show in the store')}</label>
        </div>
        <details className="se-group">
          <summary>{t('Search engines')}</summary>
          <div className="stack">
            <Field label={t('Search title')} hint={t('Optional.')}><input maxLength={120} value={form.seoTitle} onChange={(e) => setForm({ ...form, seoTitle: e.target.value })} /></Field>
            <Field label={t('Search description')} hint={t('Optional.')}><textarea rows={2} maxLength={300} value={form.seoDescription} onChange={(e) => setForm({ ...form, seoDescription: e.target.value })} /></Field>
          </div>
        </details>
        <ErrorText error={error} />
        <div className="row">
          {initial && <button type="button" className="link danger-link" onClick={() => void remove()}>{t('Delete')}</button>}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy || !form.title.trim()}>{busy ? t('Saving…') : t('Save collection')}</button>
        </div>
      </form>
    </Modal>
  );
}
