/**
 * The storefront's sections, as the site builder arranges them: each type
 * draws its settings (text is always rendered as text, never as HTML; custom
 * code arrives already sanitized by the server), and fetches the products or
 * collections it shows.
 */

import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { useT } from '../i18n';
import { ErrorText, Field, money } from '../ui';
import type { Block, MenuItem, Section, SiteLink } from './types';

export interface ProductCard {
  handle: string;
  title: string;
  imageId: string | null;
  price: string;
  compareAt?: string | null;
  priceVaries: boolean;
  soldOut: boolean;
  category?: string | null;
  badge?: string | null;
}

/** What sections need from the store. */
export interface SiteContext {
  slug: string;
  name: string;
  city: string;
  telephone: string;
  street?: string;
  whatsapp: string | null;
  delivery: { enabled: boolean; zones: Array<{ name: string }> };
  pickup: { enabled: boolean };
  /** The business's own home section (Settings → Templates), rendered and sanitized. */
  templateSection: ReactNode;
  preview: boolean;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const b = (v: unknown) => v === true;
const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const storeApi = (slug: string, path: string) => `/v1/store/${slug}${path}`;
export const productImage = (slug: string, id: string) => `/v1/store/${slug}/images/${id}`;
/** A picture reference from the builder: one of the business's images, or a product photo. */
export function imageSrc(ref: unknown, slug: string): string | null {
  const r = s(ref);
  if (r.startsWith('a:')) return `/v1/assets/${r.slice(2)}`;
  if (r.startsWith('p:')) return productImage(slug, r.slice(2));
  return null;
}

// ---------- text typed where it shows (the builder's preview) ----------

/** The section being drawn, in the builder's preview only: its texts can be typed in place. */
const EditScope = createContext<string | null>(null);

/**
 * A text from a section's settings. On the storefront it is just the text. In the builder's preview
 * it can be clicked and typed into; each keystroke goes to the editor, which keeps the draft.
 * The element's text is set by hand, never by React, so typing does not lose its place.
 */
function T({ k, v, block }: { k: string; v: string; block?: string }) {
  const section = useContext(EditScope);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== v) el.textContent = v;
  }, [v, section]);
  if (!section) return <>{v}</>;
  return (
    <span
      ref={ref}
      className="site-editable"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      data-field={k}
      onInput={(e) => window.parent.postMessage({ type: 'site-edit', id: section, block: block ?? null, key: k, value: e.currentTarget.innerText.replace(/\s*\n\s*/g, ' ') }, window.location.origin)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        // What the editor kept (cut to the field's length) is what shows.
        if (e.currentTarget.textContent !== v) e.currentTarget.textContent = v;
      }}
    />
  );
}

// ---------- links ----------

function asLink(v: unknown): SiteLink | null {
  return v && typeof v === 'object' && 'type' in v ? v as SiteLink : null;
}

/** Where a link goes: a page of the shop (for the router), or an address elsewhere. */
export function linkTarget(l: SiteLink | null): { to: string } | { href: string } | null {
  if (!l) return null;
  const v = l.value ?? '';
  switch (l.type) {
    case 'home': return { to: '/shop' };
    case 'catalog': return { to: '/shop/all' };
    case 'collections': return { to: '/shop/collections' };
    case 'collection': return { to: `/shop/collections/${v}` };
    case 'page': return { to: `/shop/pages/${v}` };
    case 'product': return { to: `/shop/products/${v}` };
    case 'category': return { to: `/shop/all?category=${encodeURIComponent(v)}` };
    case 'gift_card': return { to: '/shop/gift-card' };
    case 'account': return { to: '/shop/account' };
    case 'url': {
      // The store's own pages written as addresses ("/shop/...", "/<slug>/shop/...") stay in the shop.
      const own = /^(?:\/[^/]+)?\/shop(\/.*)?$/.exec(v);
      if (own) return { to: `/shop${own[1] ?? ''}` };
      return v ? { href: v } : null;
    }
  }
}

export function SiteLinkEl({ link, className, children, onClick }: { link: SiteLink | null; className?: string; children: ReactNode; onClick?: () => void }) {
  const target = linkTarget(link);
  if (!target) return <span className={className}>{children}</span>;
  if ('to' in target) return <Link to={target.to} className={className} viewTransition onClick={onClick}>{children}</Link>;
  const external = /^https?:/i.test(target.href);
  return <a href={target.href} className={className} onClick={onClick} {...(external && { target: '_blank', rel: 'noreferrer' })}>{children}</a>;
}

function Buttons({ settings, suffixes = ['', '2'] }: { settings: Record<string, unknown>; suffixes?: string[] }) {
  const shown = suffixes.filter((x) => s(settings[`button${x}Label`]).trim());
  if (!shown.length) return null;
  return (
    <div className="site-buttons">
      {shown.map((x, i) => <SiteLinkEl key={x} link={asLink(settings[`button${x}Link`])} className={`button ${i > 0 ? 'secondary' : ''}`}><T k={`button${x}Label`} v={s(settings[`button${x}Label`])} /></SiteLinkEl>)}
    </div>
  );
}

// ---------- text ----------

const SAFE = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

/** Inline formatting: **bold**, *italics*, [links](https://...). */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={`${key}-${i++}`}>{m[2]}</em>);
    else if (m[3] && m[4]) {
      const href = m[4];
      out.push(SAFE.test(href) ? <SiteLinkEl key={`${key}-${i++}`} link={{ type: 'url', value: href }}>{m[3]}</SiteLinkEl> : m[3]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs, lists ("- ") and inline formatting, drawn as text. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  if (!blocks.length) return null;
  return (
    <div className={`rich-text ${className ?? ''}`}>
      {blocks.map((blk, i) => {
        const lines = blk.split('\n');
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''), j)}</li>)}</ul>;
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''), j)}</li>)}</ol>;
        if (/^#{1,3}\s/.test(blk)) return <h3 key={i}>{inline(blk.replace(/^#{1,3}\s/, ''))}</h3>;
        return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l, j)] : inline(l, j)))}</p>;
      })}
    </div>
  );
}

// ---------- icons ----------

const ICON_PATHS: Record<string, ReactNode> = {
  truck: <><path d="M2.5 5.5h9v8h-9zM11.5 8.5h3l3 3v2h-6" /><circle cx="5.5" cy="14.5" r="1.5" /><circle cx="14.5" cy="14.5" r="1.5" /></>,
  store: <><path d="M3.5 8v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8" /><path d="M2.5 4.5 4 2.5h12l1.5 2v1.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0V4.5Z" /></>,
  receipt: <><path d="M5 2.5h10v15l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3z" /><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" /></>,
  leaf: <><path d="M4 16c0-7 4-11 12-12-1 8-5 12-12 12Z" /><path d="M4 16 11 9" /></>,
  star: <path d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" />,
  heart: <path d="M10 16.5s-6.5-3.8-6.5-8.6A3.6 3.6 0 0 1 10 5.8a3.6 3.6 0 0 1 6.5 2.1c0 4.8-6.5 8.6-6.5 8.6Z" />,
  shield: <><path d="M10 2.5 4 5v5c0 3.6 2.6 6.4 6 7.5 3.4-1.1 6-3.9 6-7.5V5z" /><path d="m7.3 10 1.9 1.9 3.6-3.6" /></>,
  clock: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4.2l2.8 1.8" /></>,
  gift: <><rect x="3" y="7.5" width="14" height="9.5" rx="1" /><path d="M2.5 7.5h15v3h-15zM10 7.5V17" /><path d="M10 7.5C8.5 5 6 4.5 6 6s2.5 1.5 4 1.5Zm0 0C11.5 5 14 4.5 14 6s-2.5 1.5-4 1.5Z" /></>,
  phone: <path d="M6 2.5h2.5l1.2 3.5-1.7 1.2a9 9 0 0 0 4.8 4.8L14 10.3l3.5 1.2V14a2 2 0 0 1-2 2A12.5 12.5 0 0 1 4 4.5a2 2 0 0 1 2-2Z" />,
  chat: <path d="M3.5 4.5h13a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8l-4 3v-3h-.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />,
  tag: <><path d="M10.6 3H16a1 1 0 0 1 1 1v5.4a1 1 0 0 1-.3.7l-6.8 6.8a1 1 0 0 1-1.4 0l-5.4-5.4a1 1 0 0 1 0-1.4l6.8-6.8a1 1 0 0 1 .7-.3Z" /><circle cx="13.5" cy="6.5" r="1.2" /></>,
  sparkle: <path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6z" />,
  check: <><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></>,
  map: <><path d="M10 17.5s5.5-5 5.5-9.5a5.5 5.5 0 0 0-11 0c0 4.5 5.5 9.5 5.5 9.5Z" /><circle cx="10" cy="8" r="2" /></>,
  card: <><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M2.5 8h15M5.5 12.5h3" /></>,
  sun: <><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></>,
  wave: <path d="M2 8c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2M2 13c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2" />,
  facebook: <path d="M11.5 17.5v-6h2l.4-2.5h-2.4V7.6c0-.7.3-1.3 1.3-1.3h1.2V4.1a14 14 0 0 0-1.9-.1c-1.9 0-3.1 1.1-3.1 3.2V9H7v2.5h2v6" />,
  instagram: <><rect x="3" y="3" width="14" height="14" rx="4" /><circle cx="10" cy="10" r="3.2" /><circle cx="14.2" cy="5.8" r=".6" /></>,
  tiktok: <path d="M12 3v9.3a2.8 2.8 0 1 1-2.8-2.8M12 3c.3 2 1.8 3.5 4 3.7" />,
  youtube: <><rect x="2.5" y="5" width="15" height="10" rx="3" /><path d="m8.5 8 3.5 2-3.5 2z" /></>,
  x: <path d="m4 4 12 12M16 4 4 16" />,
  search: <><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" /></>,
  whatsapp: <><path d="M4 16.5 5 13a6.5 6.5 0 1 1 2.4 2.4z" /><path d="M8 8.2c.3 1.6 1.8 3.1 3.6 3.6l.9-1 1.3.6-.2 1.2c-2.6.3-5.8-2.6-5.9-5.6l1.2-.3.6 1.3z" /></>,
};
export function SiteIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={`site-icon ${className ?? ''}`} viewBox="0 0 20 20" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name] ?? ICON_PATHS.check}
    </svg>
  );
}

// ---------- products ----------

export function ProductCardView({ p, slug }: { p: ProductCard; slug: string }) {
  const t = useT();
  return (
    <Link to={`/shop/products/${p.handle}`} className={`shop-card site-product-card ${p.soldOut ? 'sold-out' : ''}`} viewTransition>
      <div className="site-card-frame">
        <div className="shop-thumb">
          {p.imageId ? <img src={productImage(slug, p.imageId)} alt="" loading="lazy" /> : <span aria-hidden="true">◇</span>}
          {p.soldOut ? <span className="sold-tag">{t('Sold out')}</span> : p.badge ? <span className="sold-tag site-badge">{p.badge}</span> : p.compareAt ? <span className="sold-tag site-badge sale">{t('Sale')}</span> : null}
        </div>
        <span className="shop-card-title">{p.title}</span>
        <span className="shop-price num">
          {p.priceVaries ? t('From {price}', { price: money(p.price) }) : money(p.price)}
          {p.compareAt && <s className="was-price">{money(p.compareAt)}</s>}
        </span>
      </div>
    </Link>
  );
}

function useProducts(slug: string, query: string | null) {
  const [products, setProducts] = useState<ProductCard[] | null>(null);
  useEffect(() => {
    if (query === null) return;
    let live = true;
    setProducts(null);
    void api<{ data: ProductCard[] }>(storeApi(slug, `/products${query}`)).then((r) => live && setProducts(r.data)).catch(() => live && setProducts([]));
    return () => {
      live = false;
    };
  }, [slug, query]);
  return products;
}

const gridStyle = (columns: number) => ({ '--columns': String(columns) }) as React.CSSProperties;

function SkeletonGrid({ columns }: { columns: number }) {
  return <div className="site-grid" style={gridStyle(columns)}>{Array.from({ length: Math.min(columns, 4) }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: '3 / 4' }} />)}</div>;
}

function Heading({ text, first, className, k = 'heading' }: { text: string; first?: boolean; className?: string; k?: string }) {
  if (!text) return null;
  return first ? <h1 className={className}><T k={k} v={text} /></h1> : <h2 className={className}><T k={k} v={text} /></h2>;
}

/** Every product (or a collection's), with search and category buttons. */
export function ProductGrid({ settings, ctx, title, initial }: { settings: Record<string, unknown>; ctx: SiteContext; title?: string; initial?: { q?: string; category?: string | null } }) {
  const t = useT();
  const [q, setQ] = useState(initial?.q ?? '');
  const [category, setCategory] = useState<string | null>(initial?.category ?? null);
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q]);
  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (s(settings.source) === 'collection' && s(settings.collection)) params.set('collection', s(settings.collection));
  if (s(settings.sort) && s(settings.sort) !== 'newest') params.set('sort', s(settings.sort));
  const products = useProducts(ctx.slug, `?${params.toString()}`);
  const categories = [...new Set((products ?? []).map((p) => p.category).filter((c): c is string => Boolean(c)))].sort((a, z) => a.localeCompare(z));
  const shown = (products ?? []).filter((p) => !category || p.category === category);
  const columns = n(settings.columns, 4);
  const heading = title ?? s(settings.title);
  return (
    <div className="stack" id="products">
      {heading && (title ? <h1>{heading}</h1> : <h2><T k="title" v={heading} /></h2>)}
      {settings.showSearch !== false && <input type="search" className="shop-search" placeholder={t('Search the store')} aria-label={t('Search the store')} value={q} onChange={(e) => setQ(e.target.value)} />}
      {settings.showCategories !== false && categories.length > 1 && (
        <div className="quick-tabs shop-categories" role="group" aria-label={t('Categories')}>
          <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)}>{t('Everything')}</button>
          {categories.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}
      {products === null ? <SkeletonGrid columns={columns} /> : shown.length === 0 ? (
        <div className="shop-empty"><p className="muted">{debounced ? t('Nothing matches your search.') : t('No products yet. Check back soon.')}</p></div>
      ) : (
        <div className="shop-grid site-grid" style={gridStyle(columns)}>{shown.map((p) => <ProductCardView key={p.handle} p={p} slug={ctx.slug} />)}</div>
      )}
    </div>
  );
}

function FeaturedProducts({ settings, ctx, relatedTo }: { settings: Record<string, unknown>; ctx: SiteContext; relatedTo?: string }) {
  const t = useT();
  const source = relatedTo ? 'related' : s(settings.source);
  const limit = n(settings.limit, 4);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (source === 'related') p.set('relatedTo', relatedTo!);
    else if (source === 'manual') {
      const handles = arr(settings.products);
      if (!handles.length) return null;
      p.set('handles', handles.join(','));
    } else if (source === 'collection') {
      if (!s(settings.collection)) return null;
      p.set('collection', s(settings.collection));
    } else if (source === 'category') {
      if (!s(settings.category)) return null;
      p.set('category', s(settings.category));
    } else if (source === 'on_sale') p.set('onSale', '1');
    else if (source === 'best_selling') p.set('sort', 'best_selling');
    if (source !== 'manual') p.set('limit', String(limit));
    return `?${p.toString()}`;
  }, [source, relatedTo, limit, settings.products, settings.collection, settings.category]);
  const products = useProducts(ctx.slug, query);
  const columns = n(settings.columns, 4);
  if (query === null) return ctx.preview ? <div className="site-placeholder">{t('Choose the products to show in the editor.')}</div> : null;
  if (products && products.length === 0) return ctx.preview ? <div className="site-placeholder">{t('No products to show here yet.')}</div> : null;
  const viewAll = source === 'collection' ? { type: 'collection' as const, value: s(settings.collection) } : source === 'category' ? { type: 'category' as const, value: s(settings.category) } : { type: 'catalog' as const };
  return (
    <div className="stack">
      {(s(settings.title) || (b(settings.showViewAll) && !relatedTo)) && (
        <div className="site-row-head">
          {s(settings.title) && <h2>{relatedTo ? s(settings.title) : <T k="title" v={s(settings.title)} />}</h2>}
          {b(settings.showViewAll) && !relatedTo && source !== 'manual' && <SiteLinkEl link={viewAll} className="site-view-all">{t('View all')} →</SiteLinkEl>}
        </div>
      )}
      {s(settings.text) && <p className="muted site-lead"><T k="text" v={s(settings.text)} /></p>}
      {products === null ? <SkeletonGrid columns={columns} /> : <div className="shop-grid site-grid" style={gridStyle(columns)}>{products.map((p) => <ProductCardView key={p.handle} p={p} slug={ctx.slug} />)}</div>}
    </div>
  );
}

interface CollectionCard { handle: string; title: string; description: string; image: string | null; productCount: number | null }

export function useCollections(slug: string) {
  const [data, setData] = useState<CollectionCard[] | null>(null);
  useEffect(() => {
    void api<{ data: CollectionCard[] }>(storeApi(slug, '/collections')).then((r) => setData(r.data)).catch(() => setData([]));
  }, [slug]);
  return data;
}

export function CollectionTiles({ collections, ctx, columns }: { collections: CollectionCard[]; ctx: SiteContext; columns: number }) {
  const t = useT();
  return (
    <div className="site-grid site-collections" style={gridStyle(columns)}>
      {collections.map((c) => {
        const src = imageSrc(c.image, ctx.slug);
        return (
          <Link key={c.handle} to={`/shop/collections/${c.handle}`} className="site-collection" viewTransition>
            <div className="site-collection-image">{src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden="true">{c.title.slice(0, 1)}</span>}</div>
            <strong>{c.title}</strong>
            {c.productCount !== null && <span className="small muted">{c.productCount === 1 ? t('1 product') : t('{n} products', { n: c.productCount })}</span>}
          </Link>
        );
      })}
    </div>
  );
}

function CollectionList({ settings, ctx }: { settings: Record<string, unknown>; ctx: SiteContext }) {
  const t = useT();
  const all = useCollections(ctx.slug);
  const picked = arr(settings.collections);
  const shown = (all ?? []).filter((c) => !picked.length || picked.includes(c.handle)).sort((a, z) => (picked.length ? picked.indexOf(a.handle) - picked.indexOf(z.handle) : 0));
  if (all && !shown.length) return ctx.preview ? <div className="site-placeholder">{t('Make a collection under Products → Collections to show it here.')}</div> : null;
  return (
    <div className="stack">
      {s(settings.title) && <h2><T k="title" v={s(settings.title)} /></h2>}
      {all === null ? <SkeletonGrid columns={n(settings.columns, 3)} /> : <CollectionTiles collections={shown} ctx={ctx} columns={n(settings.columns, 3)} />}
    </div>
  );
}

// ---------- the other sections ----------

function Hero({ settings, ctx, first }: { settings: Record<string, unknown>; ctx: SiteContext; first: boolean }) {
  const t = useT();
  const src = imageSrc(settings.image, ctx.slug);
  const perks = b(settings.showPerks) && (ctx.delivery.enabled || ctx.pickup.enabled);
  const style = src ? ({ '--overlay': String(n(settings.overlay, 30) / 100) }) as React.CSSProperties : undefined;
  return (
    <div className={`site-hero ${src ? 'has-image' : 'shop-hero'} align-${s(settings.align) || 'left'} height-${s(settings.height) || 'medium'}`} style={style}>
      {/* A real picture (described, and fetched first when it opens the page), not a background. */}
      {src && <img className="site-hero-image" src={src} alt={s(settings.imageAlt)} style={{ objectPosition: s(settings.focus) || 'center' }} {...(first ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })} decoding="async" />}
      <div className="site-hero-inner">
        <Heading text={s(settings.heading)} first={first} />
        {s(settings.text) && <p><T k="text" v={s(settings.text)} /></p>}
        {perks && (
          <div className="shop-perks small">
            {ctx.delivery.enabled && <span>{t('Delivery')}{ctx.delivery.zones.length > 0 && `: ${ctx.delivery.zones.map((z) => z.name).join(', ')}`}</span>}
            {ctx.pickup.enabled && <span>{t('Pickup in {city}', { city: ctx.city })}</span>}
          </div>
        )}
        <Buttons settings={settings} />
      </div>
    </div>
  );
}

function Countdown({ settings }: { settings: Record<string, unknown> }) {
  const t = useT();
  const ends = Date.parse(s(settings.endsAt));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Number.isNaN(ends) ? null : Math.max(0, ends - now);
  if (left === 0 && !s(settings.endedText)) return null;
  const parts: Array<[number, string]> = left === null ? [] : [[Math.floor(left / 86_400_000), t('days')], [Math.floor(left / 3_600_000) % 24, t('hours')], [Math.floor(left / 60_000) % 60, t('minutes')], [Math.floor(left / 1000) % 60, t('seconds')]];
  return (
    <div className={`site-countdown tone-${s(settings.background) || 'dark'}`}>
      {left === 0 ? <h2><T k="endedText" v={s(settings.endedText)} /></h2> : (
        <>
          {s(settings.heading) && <h2><T k="heading" v={s(settings.heading)} /></h2>}
          {left === null ? <p className="small">{t('Set when it ends in the editor.')}</p> : (
            <div className="site-countdown-figures" role="timer" aria-live="off">
              {parts.map(([v, label]) => <div key={label}><strong className="num">{String(v).padStart(2, '0')}</strong><span>{label}</span></div>)}
            </div>
          )}
          {s(settings.text) && <p><T k="text" v={s(settings.text)} /></p>}
          <Buttons settings={settings} suffixes={['']} />
        </>
      )}
    </div>
  );
}

function videoEmbed(url: string): string | null {
  const yt = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/.exec(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = /vimeo\.com\/(?:video\/)?(\d{5,12})/.exec(url);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

function ContactForm({ settings, ctx }: { settings: Record<string, unknown>; ctx: SiteContext }) {
  const t = useT();
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (ctx.preview) return;
    setBusy(true);
    setError(null);
    try {
      await api(storeApi(ctx.slug, '/contact'), { method: 'POST', body: { name: form.name.trim(), email: form.email.trim(), message: form.message.trim(), ...(form.phone.trim() && { phone: form.phone.trim() }), ...(form.website && { website: form.website }) } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="site-contact">
      {s(settings.title) && <h2><T k="title" v={s(settings.title)} /></h2>}
      {s(settings.text) && <p className="muted"><T k="text" v={s(settings.text)} /></p>}
      {sent ? <div className="banner ok" role="status"><div><strong>{t('Thank you. Your message was sent.')}</strong>{t('The store will reply by email.')}</div></div> : (
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label={t('Name')}><input required autoComplete="name" maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('Email')}><input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          {b(settings.showPhone) && <Field label={t('Phone')} hint={t('Optional.')}><input type="tel" autoComplete="tel" maxLength={30} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>}
          <Field label={t('Message')}><textarea required rows={5} maxLength={4000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
          <label className="site-honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></label>
          <ErrorText error={error} />
          <div><button type="submit" disabled={busy}>{busy ? t('Sending…') : s(settings.buttonLabel) || t('Send')}</button></div>
        </form>
      )}
    </div>
  );
}

function VisitUs({ settings, blocks, ctx }: { settings: Record<string, unknown>; blocks: Block[]; ctx: SiteContext }) {
  const t = useT();
  const address = s(settings.address).trim() || [ctx.street, ctx.city].filter(Boolean).join(', ');
  const src = imageSrc(settings.image, ctx.slug);
  const wa = ctx.whatsapp?.replace(/\D/g, '');
  const alt = s(settings.imageAlt) || ctx.name;
  return (
    <div className={`site-visit ${src ? 'with-image' : ''}`}>
      <div className="stack">
        {s(settings.title) && <h2><T k="title" v={s(settings.title)} /></h2>}
        {address && <p className="site-address"><SiteIcon name="map" /> <span style={{ whiteSpace: 'pre-line' }}>{address}</span></p>}
        {blocks.length > 0 && (
          <dl className="site-hours">
            {blocks.map((blk) => <div key={blk.id}><dt><T k="days" v={s(blk.settings.days)} block={blk.id} /></dt><dd><T k="hours" v={s(blk.settings.hours)} block={blk.id} /></dd></div>)}
          </dl>
        )}
        <div className="site-buttons">
          {b(settings.showDirections) && address && <a className="button" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ctx.name}, ${address}, Belize`)}`} target="_blank" rel="noreferrer">{t('Directions')}</a>}
          {b(settings.showCall) && ctx.telephone && <a className="button secondary" href={`tel:${ctx.telephone.replace(/[^\d+]/g, '')}`}>{t('Call {phone}', { phone: ctx.telephone })}</a>}
          {b(settings.showWhatsapp) && wa && <a className="button secondary" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">WhatsApp</a>}
        </div>
      </div>
      {src && <img className="site-visit-image" src={src} alt={alt} loading="lazy" decoding="async" />}
    </div>
  );
}

function Faq({ settings, blocks }: { settings: Record<string, unknown>; blocks: Block[] }) {
  return (
    <div className="site-faq">
      {s(settings.title) && <h2><T k="title" v={s(settings.title)} /></h2>}
      {s(settings.text) && <p className="muted"><T k="text" v={s(settings.text)} /></p>}
      <div className="site-faq-list">
        {blocks.map((blk) => (
          <details key={blk.id}>
            <summary>{s(blk.settings.question)}</summary>
            <RichText text={s(blk.settings.answer)} />
          </details>
        ))}
      </div>
    </div>
  );
}

/** One section, by its type. */
function SectionBody({ section, ctx, first }: { section: Section; ctx: SiteContext; first: boolean }) {
  const t = useT();
  const st = section.settings;
  switch (section.type) {
    case 'hero': return <Hero settings={st} ctx={ctx} first={first} />;
    case 'banner':
      return (
        <div className={`site-banner tone-${s(st.background) || 'primary'}`}>
          <span><T k="text" v={s(st.text)} /></span>
          {s(st.buttonLabel) && <SiteLinkEl link={asLink(st.buttonLink)} className="site-banner-link"><T k="buttonLabel" v={s(st.buttonLabel)} /> →</SiteLinkEl>}
        </div>
      );
    case 'product_grid': return <ProductGrid settings={st} ctx={ctx} />;
    case 'featured_products': return <FeaturedProducts settings={st} ctx={ctx} />;
    case 'collection_list': return <CollectionList settings={st} ctx={ctx} />;
    case 'image_with_text': {
      const src = imageSrc(st.image, ctx.slug);
      return (
        <div className={`site-split image-${s(st.imagePosition) || 'left'}`}>
          <div className="site-split-image">{src ? <img src={src} alt={s(st.imageAlt)} loading="lazy" decoding="async" /> : <span aria-hidden="true">◇</span>}</div>
          <div className="stack site-split-text">
            <Heading text={s(st.heading)} first={first} />
            <RichText text={s(st.text)} />
            <Buttons settings={st} suffixes={['']} />
          </div>
        </div>
      );
    }
    case 'rich_text':
      return (
        <div className={`site-rich align-${s(st.align) || 'left'} width-${s(st.width) || 'narrow'}`}>
          <Heading text={s(st.heading)} first={first} />
          <RichText text={s(st.text)} />
          <Buttons settings={st} suffixes={['']} />
        </div>
      );
    case 'columns':
      return (
        <div className="stack">
          {s(st.title) && <h2><T k="title" v={s(st.title)} /></h2>}
          <div className="site-columns" style={gridStyle(Math.min(4, Math.max(1, section.blocks.length)))}>
            {section.blocks.map((blk) => {
              const src = imageSrc(blk.settings.image, ctx.slug);
              return (
                <div key={blk.id} className="site-column">
                  {src && <img src={src} alt={s(blk.settings.imageAlt)} loading="lazy" decoding="async" />}
                  {s(blk.settings.heading) && <h3><T k="heading" v={s(blk.settings.heading)} block={blk.id} /></h3>}
                  <RichText text={s(blk.settings.text)} />
                  {s(blk.settings.linkLabel) && <SiteLinkEl link={asLink(blk.settings.link)} className="site-view-all"><T k="linkLabel" v={s(blk.settings.linkLabel)} block={blk.id} /> →</SiteLinkEl>}
                </div>
              );
            })}
          </div>
        </div>
      );
    case 'highlights':
      return (
        <div className="stack">
          {s(st.title) && <h2><T k="title" v={s(st.title)} /></h2>}
          <div className="site-highlights" style={gridStyle(Math.min(4, Math.max(1, section.blocks.length)))}>
            {section.blocks.map((blk) => (
              <div key={blk.id} className="site-highlight">
                <SiteIcon name={s(blk.settings.icon)} />
                <strong><T k="title" v={s(blk.settings.title)} block={blk.id} /></strong>
                {s(blk.settings.text) && <p className="small"><T k="text" v={s(blk.settings.text)} block={blk.id} /></p>}
              </div>
            ))}
          </div>
        </div>
      );
    case 'testimonials':
      return (
        <div className="stack">
          {s(st.title) && <h2><T k="title" v={s(st.title)} /></h2>}
          <div className="site-testimonials">
            {section.blocks.map((blk) => (
              <figure key={blk.id} className="site-testimonial">
                <blockquote>“<T k="quote" v={s(blk.settings.quote)} block={blk.id} />”</blockquote>
                <figcaption><strong><T k="author" v={s(blk.settings.author)} block={blk.id} /></strong>{s(blk.settings.detail) && <span className="muted"> · <T k="detail" v={s(blk.settings.detail)} block={blk.id} /></span>}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      );
    case 'faq': return <Faq settings={st} blocks={section.blocks} />;
    case 'gallery': {
      const images = arr(st.images).map((r) => imageSrc(r, ctx.slug)).filter((x): x is string => Boolean(x));
      if (!images.length) return ctx.preview ? <div className="site-placeholder">{t('Add pictures to the gallery in the editor.')}</div> : null;
      return (
        <div className="stack">
          {s(st.title) && <h2><T k="title" v={s(st.title)} /></h2>}
          <div className={`site-gallery aspect-${s(st.aspect) || 'square'}`} style={gridStyle(n(st.columns, 3))}>{images.map((src) => <img key={src} src={src} alt="" loading="lazy" />)}</div>
        </div>
      );
    }
    case 'logo_list': {
      const images = arr(st.images).map((r) => imageSrc(r, ctx.slug)).filter((x): x is string => Boolean(x));
      if (!images.length) return ctx.preview ? <div className="site-placeholder">{t('Add logos in the editor.')}</div> : null;
      return (
        <div className="stack site-logos-wrap">
          {s(st.title) && <h2 className="site-logos-title"><T k="title" v={s(st.title)} /></h2>}
          <div className="site-logos">{images.map((src) => <img key={src} src={src} alt="" loading="lazy" />)}</div>
        </div>
      );
    }
    case 'video': {
      const src = videoEmbed(s(st.url));
      if (!src) return ctx.preview ? <div className="site-placeholder">{t('Paste a YouTube or Vimeo link in the editor.')}</div> : null;
      return (
        <div className="stack">
          {s(st.title) && <h2><T k="title" v={s(st.title)} /></h2>}
          <div className="site-video"><iframe src={src} title={s(st.title) || t('Video')} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen /></div>
          {s(st.caption) && <p className="small muted"><T k="caption" v={s(st.caption)} /></p>}
        </div>
      );
    }
    case 'countdown': return <Countdown settings={st} />;
    case 'visit_us': return <VisitUs settings={st} blocks={section.blocks} ctx={ctx} />;
    case 'contact_form': return <ContactForm settings={st} ctx={ctx} />;
    case 'template_section':
      return ctx.templateSection ?? null;
    case 'custom_code':
      // Rendered and sanitized by the server (no scripts or event handlers).
      return s(st.html) ? <div className="theme-section site-custom" dangerouslySetInnerHTML={{ __html: s(st.html) }} /> : ctx.preview ? <div className="site-placeholder">{t('Your HTML shows here.')}</div> : null;
    case 'spacer': return <div className={`site-spacer size-${s(st.size) || 'medium'}`}>{b(st.divider) && <hr />}</div>;
    default: return null;
  }
}

const BACKGROUND_SECTIONS = new Set(['image_with_text', 'rich_text', 'columns', 'highlights', 'testimonials']);

/** A page's sections, in order (hidden ones left out). In the builder's preview, a click selects a section, its texts can be typed in place, and a section can be added after any other. */
export function Sections({ sections, ctx, firstIsTitle }: { sections: Section[]; ctx: SiteContext; firstIsTitle?: boolean }) {
  const t = useT();
  const visible = sections.filter((x) => !x.hidden);
  const tell = (message: Record<string, unknown>) => window.parent.postMessage(message, window.location.origin);
  return (
    <>
      {visible.map((section, i) => {
        const bg = BACKGROUND_SECTIONS.has(section.type) ? s(section.settings.background) : '';
        const body = (
          <section
            key={section.id}
            className={`site-section site-${section.type.replace(/_/g, '-')} ${bg && bg !== 'none' ? `tone-${bg} toned` : ''}`}
            data-section-id={section.id}
            {...(ctx.preview && {
              onClickCapture: (e: React.MouseEvent) => {
                if ((e.target as HTMLElement).closest('a, button, input, textarea, select, summary, label')) e.preventDefault();
                tell({ type: 'site-select', id: section.id });
              },
            })}
          >
            <EditScope.Provider value={ctx.preview ? section.id : null}>
              <SectionBody section={section} ctx={ctx} first={Boolean(firstIsTitle) && i === 0} />
            </EditScope.Provider>
          </section>
        );
        if (!ctx.preview) return body;
        // In the preview each section sits in a slot of its own, which holds the "add a section after this one" button
        // (outside the section, so no section's own shape hides it).
        return (
          <div key={section.id} className="site-slot">
            {body}
            <button type="button" className="site-insert" tabIndex={-1} onClick={() => tell({ type: 'site-add', after: section.id })}>+ {t('Add section')}</button>
          </div>
        );
      })}
    </>
  );
}

/** Related products under a product (the product page setting). */
export function RelatedProducts({ title, handle, ctx }: { title: string; handle: string; ctx: SiteContext }) {
  return <section className="site-section site-related"><FeaturedProducts settings={{ title, limit: 4, columns: 4 }} ctx={ctx} relatedTo={handle} /></section>;
}

// ---------- header and footer menus ----------

export function MenuLinks({ items, onNavigate }: { items: MenuItem[]; onNavigate?: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="site-menu">
      {items.map((m) => (
        <li key={m.id} className={m.children.length ? 'has-children' : ''} onMouseLeave={() => setOpen((o) => (o === m.id ? null : o))} onKeyDown={(e) => { if (e.key === 'Escape' && open === m.id) { setOpen(null); e.currentTarget.querySelector('button')?.focus(); } }}>
          {m.children.length ? (
            <>
              <button type="button" className="link site-menu-parent" aria-expanded={open === m.id} onClick={() => setOpen((o) => (o === m.id ? null : m.id))} onMouseEnter={() => setOpen(m.id)}>{m.label} <span aria-hidden="true">▾</span></button>
              <ul className={`site-submenu ${open === m.id ? 'open' : ''}`}>
                {m.children.map((c) => <li key={c.id}><SiteLinkEl link={c.link} onClick={() => { setOpen(null); onNavigate?.(); }}>{c.label}</SiteLinkEl></li>)}
              </ul>
            </>
          ) : <SiteLinkEl link={m.link} onClick={onNavigate}>{m.label}</SiteLinkEl>}
        </li>
      ))}
    </ul>
  );
}

/** ?category= and ?q= on the all-products page. */
export function useCatalogParams() {
  const [params] = useSearchParams();
  return { q: params.get('q') ?? '', category: params.get('category') };
}
