/** Products for the online store (each with its variants and photos), plus the plain item list used at the counter. */

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, link, type Product, type ProductSummary, type Variant } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, GST_CATEGORIES, Modal, money, Segmented, Select, UNITS, usePageTitle } from '../ui';
import { Items } from './Items';

const STATUS_LABEL = { draft: 'Draft', active: 'On sale', archived: 'Archived' } as const;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Price with GST, as buyers see it: 12.5% on standard-rated items. */
function withGst(price: string, gst: string): string {
  if (!/^\d+(\.\d+)?$/.test(price)) return '';
  const cents = Math.round(Number(price) * 100);
  return ((gst === 'S' ? Math.round(cents * 1.125) : cents) / 100).toFixed(2);
}

export function Products() {
  const t = useT();
  const { can, session, me } = useSession();
  const servicesOnly = me?.sells === 'services';
  usePageTitle(servicesOnly ? t('Services') : t('Products'));
  const [params, setParams] = useSearchParams();
  const tab = servicesOnly || params.get('tab') === 'items' ? 'items' : 'products';
  const [list, setList] = useState<ProductSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (tab !== 'products') return;
    void api<{ data: ProductSummary[] }>(`/v1/products${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setList(r.data)).catch(setError);
  }, [tab, q]);
  const shop = `/${session?.business.slug}/shop`;

  if (servicesOnly) {
    return (
      <div className="stack">
        <div>
          <span className="kicker">{t('Catalog')}</span>
          <h1>{t('Services')}</h1>
          <p className="muted">{t('What you charge for, by the hour, the day or the job, with its GST. They fill in the rate on invoices, quotes and logged work.')}</p>
        </div>
        <Items />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Catalog')}</span><h1>{t('Products')}</h1></div>
        <span className="spacer" />
        <Segmented switches label={t('Catalog')} value={tab} onChange={(v) => setParams(v === 'items' ? { tab: 'items' } : {}, { replace: true })} options={[['products', t('Online store')], ['items', t('All items')]]} />
      </div>
      {tab === 'items' ? <Items /> : (
        <>
          <div className="row">
            <input type="search" placeholder={t('Search products')} aria-label={t('Search products')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
            <span className="spacer" />
            <a className="button secondary" href={shop} target="_blank" rel="noreferrer">{t('View store')}<span className="chip" aria-hidden="true">↗</span></a>
            {can('catalog.manage') && <Link className="button" to="/products/new" viewTransition>{t('Add product')}</Link>}
          </div>
          <p className="small muted">{t('A product has photos, a description and one or more variants (sizes, colours). Each variant also sells at the counter and on invoices.')}</p>
          <ErrorText error={error} />
          {list === null ? <div className="skeleton" style={{ height: '10rem' }} /> : list.length === 0 ? (
            <div className="card empty">{t('No products yet. Add your first one and turn on your store in Settings.')}</div>
          ) : (
            <div className="product-grid">
              {list.map((p) => (
                <Link key={p.id} to={`/products/${p.id}`} className="card product-card" viewTransition>
                  <div className="thumb">{p.imageId ? <img src={link(`/v1/products/${p.id}/images/${p.imageId}`)} alt="" loading="lazy" /> : <span aria-hidden="true">◇</span>}</div>
                  <div className="info">
                    <strong>{p.title}</strong>
                    <span className="num">{p.priceFrom ? (p.priceFrom === p.priceTo ? money(p.priceFrom) : `${money(p.priceFrom)} – ${money(p.priceTo)}`) : '—'}</span>
                    <span className="row small">
                      <span className={`badge ${p.status === 'active' ? 'authorized' : p.status === 'draft' ? 'pending' : 'cancelled'}`}>{t(STATUS_LABEL[p.status])}</span>
                      <span className="muted">{p.variants === 1 ? t('1 variant') : t('{n} variants', { n: p.variants })}{p.stock !== null && ` · ${t('{n} in stock', { n: p.stock })}`}</span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const blankVariant = (): Variant => ({ option1: null, option2: null, price: '', gstCategory: 'S', exemptionReasonCode: null, unitCode: 'H87', sellerCode: null, barcode: null, stock: null });

/** Add or edit a product: details, photos, variants. */
export function ProductEditor() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const { can, session } = useSession();
  const isNew = !id;
  const [product, setProduct] = useState<Product | null>(null);
  const [form, setForm] = useState({ title: '', description: '', status: 'draft' as Product['status'], option1Name: '', option2Name: '' });
  const [variants, setVariants] = useState<Variant[]>([blankVariant()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  usePageTitle(isNew ? t('Add product') : form.title || t('Product'));

  const fill = useCallback((p: Product) => {
    setProduct(p);
    setForm({ title: p.title, description: p.description, status: p.status, option1Name: p.option1Name ?? '', option2Name: p.option2Name ?? '' });
    setVariants(p.variants.length ? p.variants : [blankVariant()]);
  }, []);
  useEffect(() => {
    if (id) void api<Product>(`/v1/products/${id}`).then(fill).catch(setError);
  }, [id, fill]);

  if (!can('catalog.manage')) return <Navigate to="/products" replace />;
  const hasOptions = Boolean(form.option1Name.trim());
  const setVariant = (i: number, patch: Partial<Variant>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      title: form.title.trim(),
      description: form.description,
      status: form.status,
      option1Name: hasOptions ? form.option1Name.trim() : null,
      option2Name: hasOptions && form.option2Name.trim() ? form.option2Name.trim() : null,
      variants: (hasOptions ? variants : variants.slice(0, 1)).map((v) => ({
        ...(v.id && { id: v.id }),
        option1: hasOptions ? v.option1?.trim() || null : null,
        option2: hasOptions && form.option2Name.trim() ? v.option2?.trim() || null : null,
        price: v.price,
        gstCategory: v.gstCategory,
        exemptionReasonCode: v.gstCategory === 'E' ? v.exemptionReasonCode : null,
        unitCode: v.unitCode,
        sellerCode: v.sellerCode?.trim() || null,
        barcode: v.barcode?.trim() || null,
        stock: v.stock,
      })),
    };
    try {
      const saved = isNew ? await api<Product>('/v1/products', { method: 'POST', body }) : await api<Product>(`/v1/products/${id}`, { method: 'PUT', body });
      toast(t('{name} saved', { name: saved.title }));
      if (isNew) navigate(`/products/${saved.id}`, { replace: true });
      else fill(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !product) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of [...files]) await api(`/v1/products/${product.id}/images`, { method: 'POST', body: { dataBase64: await readAsBase64(file) } });
      fill(await api<Product>(`/v1/products/${product.id}`));
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const imageAction = async (imageId: string, action: 'cover' | 'delete') => {
    if (!product) return;
    try {
      if (action === 'cover') fill(await api<Product>(`/v1/products/${product.id}/images/${imageId}/cover`, { method: 'POST' }));
      else {
        await api(`/v1/products/${product.id}/images/${imageId}`, { method: 'DELETE' });
        fill(await api<Product>(`/v1/products/${product.id}`));
      }
    } catch (err) {
      setError(err);
    }
  };
  const archive = async () => {
    try {
      await api(`/v1/products/${id}`, { method: 'DELETE' });
      toast(t('{name} archived', { name: form.title }));
      navigate('/products', { viewTransition: true });
    } catch (err) {
      setError(err);
    }
  };

  if (!isNew && !product && !error) return <div className="skeleton" style={{ height: '16rem' }} />;
  return (
    <form className="stack" onSubmit={save}>
      <div className="row">
        <div>
          <span className="kicker"><Link to="/products" viewTransition style={{ color: 'inherit' }}>{t('Products')}</Link></span>
          <h1>{isNew ? t('Add product') : form.title}</h1>
        </div>
        <span className="spacer" />
        {product && product.status === 'active' && <a className="button secondary" href={`/${session?.business.slug}/shop/products/${product.handle}`} target="_blank" rel="noreferrer">{t('View in store')}<span className="chip" aria-hidden="true">↗</span></a>}
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save product')}</button>
      </div>
      <ErrorText error={error} />
      <div className="editor-grid">
        <div className="stack">
          <section className="card stack">
            <Field label={t('Title')}><input required autoFocus={isNew} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label={t('Description')} hint={t('What buyers read on the product page.')}><textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          </section>

          <section className="card stack">
            <div className="row"><h2>{t('Photos')}</h2><span className="spacer" />{product && <span className="small muted">{t('The first photo is the cover.')}</span>}</div>
            {!product ? <p className="small muted">{t('Save the product first, then add photos.')}</p> : (
              <>
                <div className="photo-grid">
                  {product.images.map((img, i) => (
                    <figure key={img.id} className={i === 0 ? 'cover' : ''}>
                      <img src={link(`/v1/products/${product.id}/images/${img.id}`)} alt={t('Photo {n} of {name}', { n: i + 1, name: product.title })} />
                      <figcaption className="row">
                        {i === 0 ? <span className="small">{t('Cover')}</span> : <button type="button" className="link" onClick={() => void imageAction(img.id, 'cover')}>{t('Make cover')}</button>}
                        <span className="spacer" />
                        <button type="button" className="link danger-link" aria-label={t('Remove photo {n}', { n: i + 1 })} onClick={() => void imageAction(img.id, 'delete')}>{t('Remove')}</button>
                      </figcaption>
                    </figure>
                  ))}
                  {product.images.length < 10 && (
                    <label className="photo-add">
                      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => void upload(e.target.files)} />
                      <span>{uploading ? t('Uploading…') : `+ ${t('Add photos')}`}</span>
                      <span className="small muted">{t('JPEG, PNG or WebP, up to 5 MB')}</span>
                    </label>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="card stack">
            <h2>{t('Variants')}</h2>
            <div className="form-grid">
              <Field label={t('Option name')} hint={t('e.g. Size. Leave empty when there is only one version.')}><input value={form.option1Name} onChange={(e) => setForm({ ...form, option1Name: e.target.value })} /></Field>
              {hasOptions && <Field label={t('Second option')} hint={t('e.g. Colour. Optional.')}><input value={form.option2Name} onChange={(e) => setForm({ ...form, option2Name: e.target.value })} /></Field>}
            </div>
            <div className="variants">
              {(hasOptions ? variants : variants.slice(0, 1)).map((v, i) => (
                <div key={v.id ?? `new-${i}`} className="variant-row">
                  {hasOptions && <Field label={form.option1Name}><input required value={v.option1 ?? ''} onChange={(e) => setVariant(i, { option1: e.target.value })} /></Field>}
                  {hasOptions && form.option2Name.trim() && <Field label={form.option2Name}><input value={v.option2 ?? ''} onChange={(e) => setVariant(i, { option2: e.target.value })} /></Field>}
                  <Field label={t('Price (BZ$, before GST)')} hint={v.price ? t('Buyers pay {amount}', { amount: money(withGst(v.price, v.gstCategory)) }) : undefined}>
                    <input required inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} />
                  </Field>
                  <Field label="GST"><Select value={v.gstCategory} onChange={(e) => setVariant(i, { gstCategory: e.target.value as Variant['gstCategory'] })}>{GST_CATEGORIES.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
                  <Field label={t('Stock')} hint={t('Empty: not tracked.')}><input inputMode="numeric" pattern="\d*" value={v.stock ?? ''} onChange={(e) => setVariant(i, { stock: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')) })} /></Field>
                  <Field label={t('Your code')}><input value={v.sellerCode ?? ''} onChange={(e) => setVariant(i, { sellerCode: e.target.value })} /></Field>
                  <Field label={t('Barcode')}><input inputMode="numeric" value={v.barcode ?? ''} onChange={(e) => setVariant(i, { barcode: e.target.value })} /></Field>
                  <Field label={t('Unit')}><Select value={v.unitCode} onChange={(e) => setVariant(i, { unitCode: e.target.value })}>{UNITS.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
                  {v.gstCategory === 'E' && <Field label={t('Exemption reason code')}><input required value={v.exemptionReasonCode ?? ''} onChange={(e) => setVariant(i, { exemptionReasonCode: e.target.value })} /></Field>}
                  {hasOptions && variants.length > 1 && <button type="button" className="link danger-link remove-variant" aria-label={t('Remove variant {n}', { n: i + 1 })} onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}>{t('Remove')}</button>}
                </div>
              ))}
            </div>
            {hasOptions && <div><button type="button" className="secondary" onClick={() => setVariants((vs) => [...vs, { ...blankVariant(), price: vs[vs.length - 1]?.price ?? '', gstCategory: vs[vs.length - 1]?.gstCategory ?? 'S' }])}>+ {t('Add variant')}</button></div>}
          </section>
        </div>

        <aside className="stack">
          <section className="card stack">
            <h2>{t('Status')}</h2>
            <Segmented label={t('Status')} value={form.status === 'archived' ? 'draft' : form.status} onChange={(v) => setForm({ ...form, status: v })} options={[['draft', t('Draft')], ['active', t('On sale')]]} />
            <p className="small muted">{form.status === 'active' ? t('Visible in your online store.') : t('Hidden from your store until you put it on sale.')}</p>
          </section>
          {product && <section className="card stack"><h2>{t('Address')}</h2><p className="mono small">/shop/products/{product.handle}</p></section>}
          {!isNew && <button type="button" className="secondary danger-outline" onClick={() => setArchiving(true)}>{t('Archive product')}</button>}
        </aside>
      </div>
      {archiving && (
        <Modal title={t('Archive {name}?', { name: form.title })} onClose={() => setArchiving(false)}>
          <p>{t('It leaves your store. Its variants stay in your item list for past documents.')}</p>
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setArchiving(false)}>{t('Keep')}</button><button type="button" className="danger" onClick={() => void archive()}>{t('Archive')}</button></div>
        </Modal>
      )}
    </form>
  );
}
