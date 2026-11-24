/**
 * The site builder's inputs: one for each kind of field a section can have
 * (text, choices, pictures, links, products, collections, icons, dates,
 * code), plus the picture library and the link picker they share.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { prepareImage } from '../images';
import { ErrorText, Field as FieldWrap, Modal } from '../ui';
import { imageSrc, SiteIcon } from './sections';
import type { Builder, Field, LinkType, SiteDoc, SiteLink } from './types';

export interface EditorCtx {
  slug: string;
  builder: Builder;
  site: SiteDoc;
}

// ---------- pictures ----------

interface Asset { id: string; name: string; contentType: string; bytes: number }
interface ProductRow { id: string; title: string; handle: string; imageId: string | null; status: string }

/** What the server takes for one picture. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** The business's pictures (and its product photos): pick one, or upload a new one. */
export function ImageLibrary({ ctx, onPick, onClose }: { ctx: EditorCtx; onPick: (ref: string) => void; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<'uploads' | 'products'>('uploads');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = () => void api<{ data: Asset[] }>('/v1/templates/assets').then((r) => setAssets(r.data.filter((a) => a.contentType.startsWith('image/')))).catch(setError);
  useEffect(load, []);
  useEffect(() => {
    if (tab === 'products' && products === null) void api<{ data: ProductRow[] }>('/v1/products?status=active').then((r) => setProducts(r.data.filter((p) => p.imageId))).catch(setError);
  }, [tab, products]);
  const upload = async (list: FileList | File[] | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      let last: Asset | null = null;
      for (const f of files) {
        // Photos from a phone are made smaller here, before they are sent.
        const { name, dataBase64 } = await prepareImage(f, { maxBytes: MAX_UPLOAD_BYTES });
        last = await api<Asset>('/v1/templates/assets', { method: 'POST', body: { name, dataBase64 } });
      }
      load();
      if (last && files.length === 1) onPick(`a:${last.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <Modal title={t('Choose a picture')} onClose={onClose} wide>
      <div
        className={`stack se-dropzone ${dropping ? 'dropping' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(e) => { e.preventDefault(); setDropping(false); setTab('uploads'); void upload(e.dataTransfer.files); }}
      >
        <div className="row">
          <div className="tabs" role="group" aria-label={t('Pictures')}>
            <button type="button" aria-pressed={tab === 'uploads'} className={tab === 'uploads' ? 'active' : ''} onClick={() => setTab('uploads')}>{t('Your pictures')}</button>
            <button type="button" aria-pressed={tab === 'products'} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>{t('Product photos')}</button>
          </div>
          <span className="spacer" />
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <button type="button" disabled={busy} onClick={() => file.current?.click()}>{busy ? t('Uploading…') : t('Upload pictures')}</button>
        </div>
        <ErrorText error={error} />
        {tab === 'uploads' ? (
          assets === null ? <div className="skeleton" style={{ height: '10rem' }} /> : assets.length === 0 ? <div className="empty">{t('No pictures yet. Upload one, or drop it here. Photos from your phone are fine.')}</div> : (
            <div className="se-library">
              {assets.map((a) => <button key={a.id} type="button" className="se-library-item" onClick={() => onPick(`a:${a.id}`)} title={a.name}><img src={`/v1/assets/${a.id}`} alt={a.name} loading="lazy" /><span className="small">{a.name}</span></button>)}
            </div>
          )
        ) : products === null ? <div className="skeleton" style={{ height: '10rem' }} /> : products.length === 0 ? <div className="empty">{t('No product photos yet.')}</div> : (
          <div className="se-library">
            {products.map((p) => <button key={p.id} type="button" className="se-library-item" onClick={() => onPick(`p:${p.imageId}`)} title={p.title}><img src={`/v1/store/${ctx.slug}/images/${p.imageId}`} alt={p.title} loading="lazy" /><span className="small">{p.title}</span></button>)}
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>{t('Drop pictures anywhere here to upload them. Large photos are made smaller for you, so pages load quickly.')}</p>
      </div>
    </Modal>
  );
}

export function ImageInput({ value, onChange, ctx, label }: { value: string; onChange: (v: string) => void; ctx: EditorCtx; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const src = imageSrc(value, ctx.slug);
  return (
    <div className="se-image">
      <span className="field-label">{label}</span>
      <div className="row">
        <button type="button" className="se-image-thumb" onClick={() => setOpen(true)} aria-label={src ? t('Change the picture') : t('Choose a picture')}>{src ? <img src={src} alt="" /> : <span aria-hidden="true">+</span>}</button>
        <div className="stack" style={{ gap: '0.3rem' }}>
          <button type="button" className="secondary small-button" onClick={() => setOpen(true)}>{src ? t('Change') : t('Choose')}</button>
          {src && <button type="button" className="link small" onClick={() => onChange('')}>{t('Remove')}</button>}
        </div>
      </div>
      {open && <ImageLibrary ctx={ctx} onClose={() => setOpen(false)} onPick={(ref) => { onChange(ref); setOpen(false); }} />}
    </div>
  );
}

function ImagesInput({ value, onChange, ctx, label, max }: { value: string[]; onChange: (v: string[]) => void; ctx: EditorCtx; label: string; max: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const move = (i: number, d: number) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div className="se-image">
      <span className="field-label">{label} <span className="muted small">({value.length}/{max})</span></span>
      <div className="se-images">
        {value.map((ref, i) => (
          <div key={ref} className="se-images-item">
            <img src={imageSrc(ref, ctx.slug) ?? ''} alt="" />
            <div className="se-images-actions">
              <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move left')}>←</button>
              <button type="button" className="link small" onClick={() => onChange(value.filter((x) => x !== ref))} aria-label={t('Remove')}>✕</button>
              <button type="button" className="link small" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={t('Move right')}>→</button>
            </div>
          </div>
        ))}
        {value.length < max && <button type="button" className="se-image-thumb" onClick={() => setOpen(true)} aria-label={t('Add a picture')}><span aria-hidden="true">+</span></button>}
      </div>
      {open && <ImageLibrary ctx={ctx} onClose={() => setOpen(false)} onPick={(ref) => { if (!value.includes(ref)) onChange([...value, ref]); setOpen(false); }} />}
    </div>
  );
}

// ---------- links ----------

const LINK_LABELS: Record<LinkType, string> = {
  home: 'Home page', catalog: 'All products', collections: 'All collections', collection: 'A collection', page: 'A page',
  product: 'A product', category: 'A category', gift_card: 'Gift card balance', account: 'My account', url: 'A web address',
};

export function LinkInput({ value, onChange, ctx, label }: { value: SiteLink | null; onChange: (v: SiteLink) => void; ctx: EditorCtx; label: string }) {
  const t = useT();
  const v = value ?? { type: 'home' as LinkType };
  return (
    <div className="se-link">
      <FieldWrap label={label}>
        <select value={v.type} onChange={(e) => onChange({ type: e.target.value as LinkType })}>
          {ctx.builder.linkTypes.map((lt) => <option key={lt} value={lt}>{t(LINK_LABELS[lt])}</option>)}
        </select>
      </FieldWrap>
      {v.type === 'collection' && (
        <select aria-label={t('Collection')} value={v.value ?? ''} onChange={(e) => onChange({ type: 'collection', value: e.target.value })}>
          <option value="">{t('Choose a collection')}</option>
          {ctx.builder.collections.map((c) => <option key={c.handle} value={c.handle}>{c.title}{c.published ? '' : ` (${t('hidden')})`}</option>)}
        </select>
      )}
      {v.type === 'page' && (
        <select aria-label={t('Page')} value={v.value ?? ''} onChange={(e) => onChange({ type: 'page', value: e.target.value })}>
          <option value="">{t('Choose a page')}</option>
          {ctx.site.pages.map((p) => <option key={p.id} value={p.slug}>{p.title}</option>)}
        </select>
      )}
      {v.type === 'category' && (
        <select aria-label={t('Category')} value={v.value ?? ''} onChange={(e) => onChange({ type: 'category', value: e.target.value })}>
          <option value="">{t('Choose a category')}</option>
          {ctx.builder.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {v.type === 'product' && <ProductSearch onPick={(p) => onChange({ type: 'product', value: p.handle })} placeholder={v.value ? v.value : t('Find a product')} />}
      {v.type === 'url' && <input aria-label={t('Web address')} placeholder="https://… · mailto:… · tel:…" value={v.value ?? ''} onChange={(e) => onChange({ type: 'url', value: e.target.value.trim() })} />}
    </div>
  );
}

// ---------- products and collections ----------

function ProductSearch({ onPick, placeholder, exclude = [] }: { onPick: (p: ProductRow) => void; placeholder: string; exclude?: string[] }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ProductRow[]>([]);
  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const timer = setTimeout(() => void api<{ data: ProductRow[] }>(`/v1/products?status=active&q=${encodeURIComponent(q.trim())}`).then((r) => setResults(r.data.filter((p) => !exclude.includes(p.handle)).slice(0, 8))).catch(() => {}), 200);
    return () => clearTimeout(timer);
  }, [q, exclude]);
  return (
    <div className="se-search">
      <input type="search" aria-label={t('Find a product')} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {results.length > 0 && (
        <ul className="se-search-results">
          {results.map((p) => <li key={p.id}><button type="button" className="link" onClick={() => { onPick(p); setQ(''); }}>{p.title}</button></li>)}
        </ul>
      )}
    </div>
  );
}

export function ProductsInput({ value, onChange, label, max }: { value: string[]; onChange: (v: string[]) => void; label: string; max: number }) {
  const t = useT();
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    const missing = value.filter((h) => !titles[h]);
    if (!missing.length) return;
    void api<{ data: ProductRow[] }>('/v1/products?status=all').then((r) => setTitles(Object.fromEntries(r.data.map((p) => [p.handle, p.title])))).catch(() => {});
  }, [value, titles]);
  const move = (i: number, d: number) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div className="stack" style={{ gap: '0.4rem' }}>
      <span className="field-label">{label} <span className="muted small">({value.length}/{max})</span></span>
      {value.length > 0 && (
        <ol className="se-list">
          {value.map((h, i) => (
            <li key={h}>
              <span className="grow">{titles[h] ?? h}</span>
              <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move up')}>↑</button>
              <button type="button" className="link small" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={t('Move down')}>↓</button>
              <button type="button" className="link small" onClick={() => onChange(value.filter((x) => x !== h))} aria-label={t('Remove')}>✕</button>
            </li>
          ))}
        </ol>
      )}
      {value.length < max && <ProductSearch exclude={value} placeholder={t('Add a product')} onPick={(p) => { setTitles((x) => ({ ...x, [p.handle]: p.title })); onChange([...value, p.handle]); }} />}
    </div>
  );
}

// ---------- the field for each setting ----------

const toLocal = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function FieldInput({ field, value, onChange, ctx }: { field: Field; value: unknown; onChange: (v: unknown) => void; ctx: EditorCtx }) {
  const t = useT();
  const label = t(field.label);
  const hint = field.hint ? t(field.hint) : undefined;
  const str = typeof value === 'string' ? value : '';
  switch (field.type) {
    case 'text':
      return <FieldWrap label={label} hint={hint}><input maxLength={field.maxLength} value={str} onChange={(e) => onChange(e.target.value)} /></FieldWrap>;
    case 'textarea':
      return <FieldWrap label={label} hint={hint}><textarea rows={3} maxLength={field.maxLength} value={str} onChange={(e) => onChange(e.target.value)} /></FieldWrap>;
    case 'richtext':
      return <FieldWrap label={label} hint={hint ?? t('**bold**, *italics*, [link](https://…), and lists starting with “- ”.')}><textarea rows={5} maxLength={field.maxLength} value={str} onChange={(e) => onChange(e.target.value)} /></FieldWrap>;
    case 'code':
      return <FieldWrap label={label} hint={hint ?? t('HTML with Liquid ({{ store.name }}, {% for product in products %}). Scripts and event handlers are removed.')}><textarea className="mono se-code" rows={10} spellCheck={false} maxLength={field.maxLength} value={str} onChange={(e) => onChange(e.target.value)} /></FieldWrap>;
    case 'select':
      if ((field.options ?? []).length <= 3) {
        return (
          <div className="se-choice">
            <span className="field-label">{label}</span>
            <div className="tabs" role="group" aria-label={label}>
              {(field.options ?? []).map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{t(l)}</button>)}
            </div>
          </div>
        );
      }
      return <FieldWrap label={label} hint={hint}><select value={str} onChange={(e) => onChange(e.target.value)}>{(field.options ?? []).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></FieldWrap>;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(field.default ?? 0);
      return (
        <FieldWrap label={`${label}: ${n}`} hint={hint}>
          <input type="range" min={field.min} max={field.max} step={field.step ?? 1} value={n} onChange={(e) => onChange(Number(e.target.value))} />
        </FieldWrap>
      );
    }
    case 'toggle':
      return <label className="row toggle se-toggle"><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
    case 'image':
      return <ImageInput value={str} onChange={onChange} ctx={ctx} label={label} />;
    case 'images':
      return <ImagesInput value={Array.isArray(value) ? value as string[] : []} onChange={onChange} ctx={ctx} label={label} max={field.maxItems ?? 24} />;
    case 'link':
      return <LinkInput value={(value as SiteLink | null) ?? null} onChange={onChange} ctx={ctx} label={label} />;
    case 'collection':
      return (
        <FieldWrap label={label} hint={hint ?? (ctx.builder.collections.length ? undefined : t('Make collections under Products → Collections.'))}>
          <select value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('Choose a collection')}</option>
            {ctx.builder.collections.map((c) => <option key={c.handle} value={c.handle}>{c.title}{c.published ? '' : ` (${t('hidden')})`}</option>)}
          </select>
        </FieldWrap>
      );
    case 'collections': {
      const picked = Array.isArray(value) ? value as string[] : [];
      return (
        <fieldset className="plain se-checks">
          <legend className="field-label">{label}</legend>
          {hint && <p className="small muted" style={{ margin: 0 }}>{hint}</p>}
          {ctx.builder.collections.length === 0 && <p className="small muted" style={{ margin: 0 }}>{t('Make collections under Products → Collections.')}</p>}
          {ctx.builder.collections.map((c) => (
            <label key={c.handle} className="row small"><input type="checkbox" checked={picked.includes(c.handle)} onChange={(e) => onChange(e.target.checked ? [...picked, c.handle] : picked.filter((x) => x !== c.handle))} /> {c.title}</label>
          ))}
        </fieldset>
      );
    }
    case 'products':
      return <ProductsInput value={Array.isArray(value) ? value as string[] : []} onChange={onChange} label={label} max={field.maxItems ?? 12} />;
    case 'category':
      return (
        <FieldWrap label={label} hint={hint}>
          <select value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('Choose a category')}</option>
            {ctx.builder.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FieldWrap>
      );
    case 'datetime':
      return <FieldWrap label={label} hint={hint}><input type="datetime-local" value={toLocal(str)} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')} /></FieldWrap>;
    case 'icon':
      return (
        <div className="se-choice">
          <span className="field-label">{label}</span>
          <div className="se-icons" role="group" aria-label={label}>
            {ctx.builder.icons.map((i) => <button key={i} type="button" className={`se-icon ${value === i ? 'active' : ''}`} aria-pressed={value === i} aria-label={i} onClick={() => onChange(i)}><SiteIcon name={i} /></button>)}
          </div>
        </div>
      );
  }
}

/** Whether a field shows, given the other settings (a picture field's "only with a picture" rules use '*'). */
export function fieldShown(field: Field, settings: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const v = settings[field.showIf.key];
  if (field.showIf.in.includes('*')) return Boolean(v);
  return field.showIf.in.includes(v);
}

export function Group({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="se-group" open={open}>
      <summary>{title}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}
