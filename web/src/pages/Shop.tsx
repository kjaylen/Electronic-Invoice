/**
 * The public storefront, at /<business>/shop. No sign-in needed: buyers
 * browse, fill a cart (kept on their device), check out, and follow their
 * order on a private page that later holds their BTS receipt. Where the store
 * has accounts, a buyer can also sign in (a code by email) to see all their
 * orders, keep addresses and check out faster.
 */

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { api, ApiError, type PaymentMethod, setSitePreview } from '../api';
import { CollectionTiles, imageSrc, MenuLinks, ProductCardView, ProductGrid, RelatedProducts, RichText, Sections, SiteIcon, SiteLinkEl, type SiteContext, useCatalogParams, useCollections, type ProductCard as SiteProductCard } from '../site/sections';
import { FONT_FAMILIES, loadFonts, themeCss } from '../site/theme';
import type { SiteDoc } from '../site/types';
import { BUSINESS } from '../business';
import { LanguageToggle, useT } from '../i18n';
import { PROVIDER_NOTE, WalletPay, type WalletInfo } from '../wallet';
import { store } from '../storage';
import { DISTRICTS, ErrorText, Field, money, Select, usePageTitle, whatsappNumber } from '../ui';

// ---------- data ----------

interface StoreInfo {
  slug: string;
  name: string;
  tagline: string;
  about: string;
  whatsapp: string | null;
  telephone: string;
  city: string;
  test: boolean;
  delivery: { enabled: boolean; zones: Array<{ name: string; fee: string }> };
  pickup: { enabled: boolean; address: string | null };
  payments: { bankTransfer: boolean; cashOnDelivery: boolean; payAtPickup: boolean; online: 'paypal' | 'test' | 'belizebank' | 'ekyash' | null };
  /** The store may email a reminder to buyers who leave at checkout. */
  reminders?: boolean;
  /** Buyers can sign in to an account at this store. */
  accounts?: boolean;
  /** The business's theme (Settings, Templates), rendered and sanitized by the server. Empty strings: none. */
  theme?: StoreTheme;
  /** The published site (the site builder). */
  site?: SiteDoc;
  email?: string;
  street?: string;
}

/** What pages get from the layout: the store, its theme, the site (or the builder's draft in the preview), and the context sections need. */
type ShopContext = StoreInfo & { theme: StoreTheme; site: SiteDoc; siteCtx: SiteContext };

interface StoreTheme { css: string; announcement: string; home: string; footer: string }
const NO_THEME: StoreTheme = { css: '', announcement: '', home: '', footer: '' };

interface ProductCard {
  handle: string;
  title: string;
  imageId: string | null;
  price: string;
  priceVaries: boolean;
  soldOut: boolean;
  category?: string | null;
  compareAt?: string | null;
  badge?: string | null;
}

interface ProductPage {
  handle: string;
  title: string;
  description: string;
  options: string[];
  images: string[];
  badge?: string | null;
  variants: Array<{ id: string; title: string | null; option1: string | null; option2: string | null; price: string; compareAt?: string | null; available: boolean; left: number | null }>;
}

const slug = BUSINESS ?? '';
const shopApi = (path: string) => `/v1/store/${slug}${path}`;
export const imageUrl = (id: string) => `/v1/store/${slug}/images/${id}`;
const PAYMENT_LABEL: Record<PaymentMethod, string> = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', online: 'Pay online now', gift_card: 'Gift card' };

// ---------- the cart, on this device ----------

export interface CartLine {
  variantId: string;
  quantity: number;
  handle: string;
  title: string;
  variantTitle: string | null;
  price: string;
  imageId: string | null;
}

const CART_KEY = `etd.cart.${slug}`;
const listeners = new Set<() => void>();
let cartCache: CartLine[] = store.get<CartLine[]>(CART_KEY) ?? [];
function setCart(next: CartLine[]) {
  cartCache = next;
  store.set(CART_KEY, next);
  listeners.forEach((l) => l());
}
window.addEventListener('storage', (e) => {
  if (e.key === CART_KEY) {
    cartCache = store.get<CartLine[]>(CART_KEY) ?? [];
    listeners.forEach((l) => l());
  }
});
// ---------- this checkout (checkout reminders) ----------

const CHECKOUT_KEY = `etd.checkout.${slug}`;
const PREFILL_KEY = `etd.checkout.prefill.${slug}`;
/** The id the store knows this checkout by, made on first use (a new one after each order). */
function checkoutId(): string {
  const existing = store.get<string>(CHECKOUT_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  store.set(CHECKOUT_KEY, id);
  return id;
}
interface Prefill { email: string; name: string | null; fulfillment: 'delivery' | 'pickup' | null; zone: string | null; discountCode: string | null }

export function useCart() {
  const lines = useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, () => cartCache);
  return {
    lines,
    count: lines.reduce((n, l) => n + l.quantity, 0),
    add: (line: CartLine) => {
      const existing = cartCache.find((l) => l.variantId === line.variantId);
      setCart(existing ? cartCache.map((l) => (l.variantId === line.variantId ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...cartCache, line]);
    },
    setQuantity: (variantId: string, quantity: number) => setCart(quantity <= 0 ? cartCache.filter((l) => l.variantId !== variantId) : cartCache.map((l) => (l.variantId === variantId ? { ...l, quantity: Math.min(quantity, 9999) } : l))),
    clear: () => setCart([]),
  };
}

// ---------- the buyer's account (stores with accounts) ----------

interface BuyerAddress { id: string; street: string; city: string; districtCode: string; isDefault: boolean }
interface BuyerAccount {
  buyer: { email: string; name: string | null; phone: string | null; business: { tin: string; name: string } | null; createdAt: string };
  addresses: BuyerAddress[];
}
// undefined: not known yet; null: no one is signed in.
let accountCache: BuyerAccount | null | undefined;
const accountListeners = new Set<() => void>();
function setAccount(next: BuyerAccount | null) {
  accountCache = next;
  accountListeners.forEach((l) => l());
}
let accountLoading: Promise<void> | null = null;
/** Who is signed in at this store: asked once, or again when `fresh`. */
function loadAccount(fresh = false): Promise<void> {
  if (!accountLoading || fresh) {
    accountLoading = api<{ buyer: BuyerAccount['buyer'] | null; addresses: BuyerAddress[] }>(shopApi('/account'))
      .then((r) => setAccount(r.buyer ? { buyer: r.buyer, addresses: r.addresses } : null))
      .catch(() => setAccount(null));
  }
  return accountLoading;
}
function useAccount(): BuyerAccount | null | undefined {
  return useSyncExternalStore((cb) => {
    accountListeners.add(cb);
    return () => accountListeners.delete(cb);
  }, () => accountCache);
}
const districtName = (code: string) => DISTRICTS.find(([c]) => c === code)?.[1] ?? '';

// ---------- theme ----------

const THEME_PARTS = { 'store.theme': 'css', 'store.announcement': 'announcement', 'store.home': 'home', 'store.footer': 'footer' } as const;

/**
 * In the template editor's preview (a same-origin frame opened with ?theme-preview), the editor
 * sends the part being edited, already rendered and sanitized by the server, as you type.
 */
function useThemePreview(): Partial<StoreTheme> {
  const [parts, setParts] = useState<Partial<StoreTheme>>({});
  useEffect(() => {
    if (window.parent === window || !new URLSearchParams(window.location.search).has('theme-preview')) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const data = e.data as { type?: string; key?: string; content?: unknown };
      if (data?.type !== 'theme-preview' || typeof data.content !== 'string' || !data.key || !(data.key in THEME_PARTS)) return;
      const part = THEME_PARTS[data.key as keyof typeof THEME_PARTS];
      setParts((p) => ({ ...p, [part]: data.content as string }));
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'theme-preview-ready' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return parts;
}

/** A section of the business's own HTML; its links to the store stay inside the shop. */
function ThemeSection({ html, className }: { html: string; className: string }) {
  const navigate = useNavigate();
  if (!html) return null;
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const shop = url.pathname.match(/^(?:\/[^/]+)?\/shop(\/.*)?$/);
    if (!shop) return;
    e.preventDefault();
    navigate(`/shop${shop[1] ?? ''}${url.search}`, { viewTransition: true });
  };
  return <div className={`theme-section ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- the site builder's preview ----------

/** Opened by the site builder (a frame with ?site-preview): show its draft, and tell it what is clicked. */
const SITE_PREVIEW = typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).has('site-preview');
if (SITE_PREVIEW) setSitePreview(true);

function useSitePreview(): SiteDoc | null {
  const [site, setSite] = useState<SiteDoc | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!SITE_PREVIEW) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const data = e.data as { type?: string; site?: SiteDoc; path?: string; id?: string; scroll?: boolean };
      if (data?.type === 'site-preview' && data.site) setSite(data.site);
      if (data?.type === 'site-navigate' && typeof data.path === 'string' && data.path.startsWith('/shop')) navigate(data.path);
      if (data?.type === 'site-highlight' && data.id) {
        const el = document.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(data.id)}"]`);
        document.querySelectorAll('.site-section.selected').forEach((x) => x.classList.remove('selected'));
        if (el) {
          el.classList.add('selected');
          // Chosen in the editor's list: brought into view. Clicked here: it is in view already.
          if (data.scroll !== false) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'site-ready' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);
  useEffect(() => {
    if (SITE_PREVIEW) window.parent.postMessage({ type: 'site-location', path: location.pathname }, window.location.origin);
  }, [location.pathname]);
  return site;
}

const SOCIAL: Array<[keyof SiteDoc['social'], string]> = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['x', 'X']];

// ---------- layout ----------

export function ShopLayout() {
  const t = useT();
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { count } = useCart();
  const location = useLocation();
  const preview = useThemePreview();
  const draft = useSitePreview();
  const [menuOpen, setMenuOpen] = useState(false);
  const theme = useMemo(() => ({ ...NO_THEME, ...info?.theme, ...preview }), [info, preview]);
  const site = draft ?? info?.site ?? null;
  const css = useMemo(() => (site ? themeCss(site.theme, FONT_FAMILIES) : ''), [site]);
  const siteCtx = useMemo<SiteContext | null>(() => info && {
    slug: info.slug, name: info.name, city: info.city, telephone: info.telephone, street: info.street, whatsapp: info.whatsapp,
    delivery: info.delivery, pickup: info.pickup, preview: SITE_PREVIEW,
    templateSection: theme.home ? <ThemeSection html={theme.home} className="shop-home-section" /> : null,
  }, [info, theme.home]);
  const outlet = useMemo(() => info && site && siteCtx && { ...info, theme, site, siteCtx }, [info, theme, site, siteCtx]);
  useEffect(() => {
    void api<StoreInfo>(shopApi('')).then(setInfo).catch(setError);
  }, []);
  const account = useAccount();
  useEffect(() => {
    if (info?.accounts) void loadAccount();
  }, [info?.accounts]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setMenuOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (site) loadFonts([site.theme.fonts.heading, site.theme.fonts.body]);
  }, [site]);
  // Escape closes the phone menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  // The store's own icon in the browser tab.
  useEffect(() => {
    const src = site ? imageSrc(site.theme.favicon, info?.slug ?? '') : null;
    if (!src) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const before = link.href;
    link.href = src;
    return () => {
      link.href = before;
    };
  }, [site, info?.slug]);

  if (error) {
    const closed = error instanceof ApiError && (error.code === 'store_closed' || error.status === 404);
    return (
      <div className="shop">
        <main className="shop-main"><div className="shop-empty"><h1>{closed ? t('This store is not open yet') : t('Something went wrong')}</h1><p className="muted">{closed ? t('Check back soon.') : t('Please try again in a moment.')}</p></div></main>
      </div>
    );
  }
  const logo = site ? imageSrc(site.theme.logo, info?.slug ?? '') : null;
  const announcement = site?.header.announcement;
  const menu = site?.header.menu ?? [];
  const social = site ? SOCIAL.filter(([k]) => site.social[k]) : [];
  const wa = whatsappNumber(info?.whatsapp ?? null);
  const ways = info ? [info.payments.bankTransfer && t('Bank transfer'), info.payments.cashOnDelivery && t('Cash on delivery'), info.payments.payAtPickup && t('Pay at pickup'), info.payments.online && t('Card or PayPal online')].filter(Boolean) : [];
  return (
    <div className={`shop ${site ? `site-spacing-${site.theme.spacing}` : ''}`}>
      <a className="skip-link" href="#main">{t('Skip to content')}</a>
      {css && <style data-theme="site">{css}</style>}
      {theme.css && <style data-theme="store">{theme.css}</style>}
      {announcement?.enabled && announcement.text && (
        <div className={`site-announcement tone-${announcement.style}`}>
          {announcement.link ? <SiteLinkEl link={announcement.link}>{announcement.text}</SiteLinkEl> : announcement.text}
        </div>
      )}
      <ThemeSection html={theme.announcement} className="shop-announcement" />
      {info?.test && <div className="shop-test" role="note">{t('Test store: orders are not real and receipts have no fiscal value.')}</div>}
      <header className={`shop-header layout-${site?.theme.headerLayout ?? 'left'} ${site && !site.header.sticky ? 'not-sticky' : ''}`}>
        {menu.length > 0 && <button type="button" className="icon-button site-menu-toggle" aria-label={t('Menu')} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>{menuOpen ? '✕' : '☰'}</button>}
        <Link to="/shop" className="shop-brand" viewTransition>
          {logo ? <img className="site-logo" src={logo} alt={info?.name ?? ''} style={{ height: site!.theme.logoHeight }} /> : (
            <>
              <span className="shop-name">{info?.name ?? ' '}</span>
              {info?.tagline && <span className="shop-tagline">{info.tagline}</span>}
            </>
          )}
        </Link>
        {menu.length > 0 && <nav className="site-nav" aria-label={t('Store menu')}><MenuLinks items={menu} /></nav>}
        <span className="spacer" />
        {site?.header.showSearch && <Link to="/shop/all" className="site-search-link" aria-label={t('Search the store')} viewTransition><SiteIcon name="search" /></Link>}
        <LanguageToggle />
        {info?.accounts && <Link to="/shop/account" className="shop-account-link" viewTransition>{account ? t('Account') : t('Sign in')}</Link>}
        <Link to="/shop/cart" className="button cart-button" viewTransition aria-label={t('Cart, {n} items', { n: count })}>
          {t('Cart')}<span className="chip" aria-hidden="true">{count}</span>
        </Link>
      </header>
      {menuOpen && menu.length > 0 && <nav className="site-drawer" aria-label={t('Store menu')}><MenuLinks items={menu} onNavigate={() => setMenuOpen(false)} /></nav>}
      <main className="shop-main" id="main" tabIndex={-1}>
        <div className="page" key={location.pathname}>
          {outlet ? <Outlet context={outlet} /> : <div className="shop-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: '16rem' }} />)}</div>}
        </div>
      </main>
      <footer className="shop-footer site-footer">
        <div className="site-footer-grid">
          <div className="site-footer-about stack">
            <strong className="site-footer-name">{info?.name}</strong>
            {site ? site.footer.text && <RichText text={site.footer.text} /> : info?.about && <p>{info.about}</p>}
            {(!site || site.footer.showContact) && (
              <p className="small">{info?.city && `${info.city} · `}{info?.telephone}{site?.footer.showContact && info?.email && <> · <a href={`mailto:${info.email}`}>{info.email}</a></>}{wa && <> · <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">WhatsApp</a></>}</p>
            )}
            {site?.footer.showSocial && social.length > 0 && (
              <div className="site-social">
                {social.map(([k, label]) => <a key={k} href={site.social[k]} target="_blank" rel="noreferrer" aria-label={label}><SiteIcon name={k} /></a>)}
              </div>
            )}
          </div>
          {site?.footer.columns.map((col) => (
            <div key={col.id} className="site-footer-col">
              {col.title && <h2 className="site-footer-title">{col.title}</h2>}
              <ul>{col.links.map((l) => <li key={l.id}><SiteLinkEl link={l.link}>{l.label}</SiteLinkEl></li>)}</ul>
            </div>
          ))}
        </div>
        {site?.footer.showPayments && ways.length > 0 && <p className="small site-payments">{t('We accept')}: {ways.join(' · ')}</p>}
        <ThemeSection html={theme.footer} className="shop-footer-section" />
        {/* On a phone the header has no room for it. */}
        <div className="site-footer-lang"><LanguageToggle /></div>
        <p className="small muted">{t('Every purchase comes with a receipt authorized by the Belize Tax Service.')} · Floreo</p>
      </footer>
    </div>
  );
}

const useStoreInfo = () => useOutletContext<ShopContext>();

// ---------- pages ----------

export function ShopHome() {
  const info = useStoreInfo();
  usePageTitle(info.tagline ? info.tagline : '', info.name);
  return <div className="stack site-page"><Sections sections={info.site.home.sections} ctx={info.siteCtx} firstIsTitle /></div>;
}

/** /shop/all: every product, with search and categories (?q=, ?category=). */
export function ShopCatalog() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(t('All products'), info.name);
  const initial = useCatalogParams();
  return <div className="stack site-page"><ProductGrid key={`${initial.q}|${initial.category ?? ''}`} settings={{ showSearch: true, showCategories: true, columns: 4 }} ctx={info.siteCtx} title={t('All products')} initial={initial} /></div>;
}

/** /shop/collections: every published collection. */
export function ShopCollections() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(t('Collections'), info.name);
  const collections = useCollections(info.slug);
  return (
    <div className="stack site-page">
      <h1>{t('Collections')}</h1>
      {collections === null ? <div className="skeleton" style={{ height: '14rem' }} /> : collections.length === 0 ? <div className="shop-empty"><p className="muted">{t('No collections yet.')}</p><Link className="button" to="/shop/all">{t('See all products')}</Link></div> : <CollectionTiles collections={collections} ctx={info.siteCtx} columns={3} />}
    </div>
  );
}

interface CollectionPage { handle: string; title: string; description: string; image: string | null; products: SiteProductCard[] }

/** /shop/collections/:handle: a collection and its products, in the order chosen (or another). */
export function ShopCollection() {
  const t = useT();
  const info = useStoreInfo();
  const { handle } = useParams();
  const [sort, setSort] = useState('');
  const [c, setC] = useState<CollectionPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  usePageTitle(c?.title ?? '', info.name);
  useEffect(() => {
    void api<CollectionPage>(shopApi(`/collections/${handle}${sort ? `?sort=${sort}` : ''}`)).then(setC).catch(setError);
  }, [handle, sort]);
  if (error) return <div className="shop-empty"><h1>{t('This collection is not available')}</h1><Link className="button" to="/shop">{t('Back to the store')}</Link></div>;
  if (!c) return <div className="skeleton" style={{ height: '20rem' }} />;
  const src = imageSrc(c.image, info.slug);
  return (
    <div className="stack site-page">
      <div className={`site-collection-head ${src ? 'with-image' : ''}`}>
        {src && <img src={src} alt="" />}
        <div className="stack">
          <h1>{c.title}</h1>
          {c.description && <RichText text={c.description} />}
        </div>
      </div>
      <div className="row">
        <span className="small muted">{c.products.length === 1 ? t('1 product') : t('{n} products', { n: c.products.length })}</span>
        <span className="spacer" />
        <label className="row small site-sort">{t('Sort')}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="">{t('Featured')}</option>
            <option value="newest">{t('Newest first')}</option>
            <option value="price_asc">{t('Price, low to high')}</option>
            <option value="price_desc">{t('Price, high to low')}</option>
            <option value="title">{t('Name, A to Z')}</option>
            <option value="best_selling">{t('Best selling')}</option>
          </select>
        </label>
      </div>
      {c.products.length === 0 ? <div className="shop-empty"><p className="muted">{t('Nothing here yet.')}</p></div> : (
        <div className="shop-grid site-grid" style={{ '--columns': '4' } as React.CSSProperties}>{c.products.map((p) => <ProductCardView key={p.handle} p={p} slug={info.slug} />)}</div>
      )}
    </div>
  );
}

/** /shop/pages/:slug: a page the business made in the site builder. */
export function ShopPage() {
  const t = useT();
  const info = useStoreInfo();
  const { slug: pageSlug } = useParams();
  const page = info.site.pages.find((x) => x.slug === pageSlug);
  usePageTitle(page ? page.seoTitle || page.title : '', info.name);
  if (!page) return <div className="shop-empty"><h1>{t('This page is not available')}</h1><Link className="button" to="/shop">{t('Back to the store')}</Link></div>;
  const opensWithTitle = ['hero', 'rich_text', 'image_with_text'].includes(page.sections.find((x) => !x.hidden)?.type ?? '');
  return (
    <div className="stack site-page">
      {!opensWithTitle && <h1>{page.title}</h1>}
      <Sections sections={page.sections} ctx={info.siteCtx} firstIsTitle={opensWithTitle} />
    </div>
  );
}

export function ShopProduct() {
  const t = useT();
  const { handle } = useParams();
  const navigate = useNavigate();
  const cart = useCart();
  const [p, setP] = useState<ProductPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [choice, setChoice] = useState<Array<string | null>>([null, null]);
  const [photo, setPhoto] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const info = useStoreInfo();
  usePageTitle(p?.title ?? '', info.name);
  useEffect(() => {
    void api<ProductPage>(shopApi(`/products/${handle}`)).then((r) => {
      setP(r);
      const first = r.variants.find((v) => v.available) ?? r.variants[0];
      setChoice([first?.option1 ?? null, first?.option2 ?? null]);
    }).catch(setError);
  }, [handle]);
  const variant = useMemo(() => p?.variants.find((v) => (p.options.length === 0 || v.option1 === choice[0]) && (p.options.length < 2 || v.option2 === choice[1])) ?? null, [p, choice]);
  if (error) return <div className="shop-empty"><h1>{t('This product is not available')}</h1><Link to="/shop">{t('Back to the store')}</Link></div>;
  if (!p) return <div className="skeleton" style={{ height: '24rem' }} />;
  const values = (i: 0 | 1) => [...new Set(p.variants.map((v) => (i === 0 ? v.option1 : v.option2)).filter((x): x is string => Boolean(x)))];
  const isAvailable = (i: 0 | 1, value: string) => p.variants.some((v) => (i === 0 ? v.option1 === value && (p.options.length < 2 || v.option2 === choice[1]) : v.option2 === value && v.option1 === choice[0]) && v.available);

  const add = () => {
    if (!variant) return;
    cart.add({ variantId: variant.id, quantity, handle: p.handle, title: p.title, variantTitle: variant.title, price: variant.price, imageId: p.images[0] ?? null });
    setAdded(true);
  };
  return (
    <div className="shop-product">
      <div className="gallery">
        <div className="gallery-main">{p.images[photo] ? <img src={imageUrl(p.images[photo]!)} alt={p.title} /> : <span aria-hidden="true">◇</span>}</div>
        {p.images.length > 1 && (
          <div className="gallery-thumbs">
            {p.images.map((id, i) => (
              <button key={id} type="button" className={i === photo ? 'active' : ''} aria-label={t('Photo {n}', { n: i + 1 })} aria-pressed={i === photo} onClick={() => setPhoto(i)}><img src={imageUrl(id)} alt="" /></button>
            ))}
          </div>
        )}
      </div>
      <div className="stack buy">
        <Link to="/shop" className="small" viewTransition>← {t('All products')}</Link>
        {p.badge && <span className="site-badge-inline">{p.badge}</span>}
        <h1>{p.title}</h1>
        <p className="shop-price big num">{variant ? money(variant.price) : '—'}{variant?.compareAt && <s className="was-price">{money(variant.compareAt)}</s>}{variant?.compareAt && <span className="site-save">{t('Save {amount}', { amount: money((Number(variant.compareAt) - Number(variant.price)).toFixed(2)) })}</span>}</p>
        <p className="small muted">{t('GST included')}</p>
        {p.options.map((name, i) => (
          <fieldset key={name} className="plain option-picker">
            <legend className="small">{name}</legend>
            <div className="row">
              {values(i as 0 | 1).map((value) => (
                <button key={value} type="button" aria-pressed={choice[i] === value} className={`option ${choice[i] === value ? 'active' : ''} ${isAvailable(i as 0 | 1, value) ? '' : 'unavailable'}`} onClick={() => { setChoice((c) => (i === 0 ? [value, c[1] ?? null] : [c[0] ?? null, value])); setAdded(false); }}>{value}</button>
              ))}
            </div>
          </fieldset>
        ))}
        {variant && !variant.available && (
          <div className="stack back-in-stock">
            <p className="form-error">{t('Sold out')}</p>
            <BackInStock handle={p.handle} variantId={variant.id} />
          </div>
        )}
        {variant?.left !== null && variant?.left !== undefined && variant.available && <p className="small low-stock">{t('Only {n} left', { n: variant.left })}</p>}
        <div className="row">
          <div className="qty shop-qty">
            <button type="button" aria-label={t('One less')} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>−</button>
            <input aria-label={t('Quantity')} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1))} />
            <button type="button" aria-label={t('One more')} onClick={() => setQuantity((q) => q + 1)}>+</button>
          </div>
          <button type="button" className="big" disabled={!variant || !variant.available} onClick={add}>{t('Add to cart')}<span className="chip" aria-hidden="true">+</span></button>
        </div>
        {added && (
          <div className="banner ok" role="status">
            <div className="row" style={{ width: '100%' }}>
              <span><strong>{t('Added to your cart')}</strong></span>
              <span className="spacer" />
              <button type="button" className="lime" onClick={() => navigate('/shop/cart', { viewTransition: true })}>{t('View cart')}</button>
            </div>
          </div>
        )}
        {p.description && <div className="description">{p.description.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>}
      </div>
      {/* The site's sections for every product page, then related products. */}
      <div className="site-product-extras">
        <Sections sections={info.site.product.sections} ctx={info.siteCtx} />
        {info.site.product.showRelated && <RelatedProducts title={info.site.product.relatedTitle} handle={p.handle} ctx={info.siteCtx} />}
      </div>
    </div>
  );
}

export function ShopCart() {
  const t = useT();
  usePageTitle(t('Cart'), useStoreInfo().name);
  const navigate = useNavigate();
  const { lines, setQuantity } = useCart();
  const subtotal = lines.reduce((sum, l) => sum + Math.round(Number(l.price) * 100) * l.quantity, 0);
  if (lines.length === 0) return <div className="shop-empty"><h1>{t('Your cart is empty')}</h1><Link className="button" to="/shop" viewTransition>{t('Keep shopping')}</Link></div>;
  return (
    <div className="stack shop-narrow">
      <h1>{t('Cart')}</h1>
      <ul className="shop-cart">
        {lines.map((l) => (
          <li key={l.variantId}>
            <div className="shop-thumb small-thumb">{l.imageId ? <img src={imageUrl(l.imageId)} alt="" /> : <span aria-hidden="true">◇</span>}</div>
            <div className="grow">
              <Link to={`/shop/products/${l.handle}`}>{l.title}</Link>
              {l.variantTitle && <div className="small muted">{l.variantTitle}</div>}
              <div className="small num">{money(l.price)}</div>
            </div>
            <div className="qty shop-qty">
              <button type="button" aria-label={t('One less {name}', { name: l.title })} onClick={() => setQuantity(l.variantId, l.quantity - 1)}>−</button>
              <input aria-label={t('Quantity of {name}', { name: l.title })} inputMode="numeric" value={l.quantity} onChange={(e) => setQuantity(l.variantId, Number(e.target.value.replace(/\D/g, '')) || 0)} />
              <button type="button" aria-label={t('One more {name}', { name: l.title })} onClick={() => setQuantity(l.variantId, l.quantity + 1)}>+</button>
            </div>
            <span className="num line-sum">{money((Math.round(Number(l.price) * 100) * l.quantity / 100).toFixed(2))}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <span className="muted">{t('Subtotal, GST included')}</span>
        <span className="spacer" />
        <strong className="num">{money((subtotal / 100).toFixed(2))}</strong>
      </div>
      <p className="small muted">{t('Delivery is added at checkout. The exact total, to the cent, is on the next page.')}</p>
      <div className="row"><Link to="/shop" viewTransition>← {t('Keep shopping')}</Link><span className="spacer" /><button className="big" onClick={() => navigate('/shop/checkout', { viewTransition: true })}>{t('Check out')}<span className="chip" aria-hidden="true">→</span></button></div>
    </div>
  );
}

interface QuoteResult {
  lines: Array<{ variantId: string; productTitle: string; variantTitle: string | null; quantity: number; total: string; listTotal?: string }>;
  delivery: { zone: string; total: string } | null;
  discount: { code: string; kind: string; saved: string } | null;
  totals: { lineExtension: string; gst: string; total: string };
  /** What a gift card pays, and what is left to pay. */
  giftCard?: { last4: string; balance: string; applied: string } | null;
  due?: string;
  paymentMethods: PaymentMethod[];
}

function Radio({ name, value, checked, onChange, children }: { name: string; value: string; checked: boolean; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className={`choice ${checked ? 'active' : ''}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
      <span>{children}</span>
    </label>
  );
}

export function ShopCheckout() {
  const t = useT();
  usePageTitle(t('Check out'), useStoreInfo().name);
  const info = useStoreInfo();
  const navigate = useNavigate();
  const cart = useCart();
  const account = useAccount();
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>(() => {
    const p = store.get<Prefill>(PREFILL_KEY);
    return p?.fulfillment === 'pickup' && info.pickup.enabled ? 'pickup' : info.delivery.enabled ? 'delivery' : 'pickup';
  });
  const [zone, setZone] = useState(() => {
    const p = store.get<Prefill>(PREFILL_KEY);
    return p?.zone && info.delivery.zones.some((z) => z.name === p.zone) ? p.zone : info.delivery.zones[0]?.name ?? '';
  });
  const [payment, setPayment] = useState<PaymentMethod | ''>('');
  // Back from a reminder's link: what the buyer had filled in.
  const [prefill] = useState(() => store.get<Prefill>(PREFILL_KEY));
  useEffect(() => store.remove(PREFILL_KEY), []);
  const [contact, setContact] = useState({ name: prefill?.name ?? '', email: prefill?.email ?? '', phone: '' });
  const [address, setAddress] = useState({ street: '', city: '', districtCode: '1' });
  // Signed in: one of the account's addresses, or "new" (which can be saved to it).
  const [addressChoice, setAddressChoice] = useState('new');
  const [saveAddress, setSaveAddress] = useState(true);
  const [wantsInvoice, setWantsInvoice] = useState(false);
  const [business, setBusiness] = useState({ tin: '', name: '' });
  const [note, setNote] = useState('');
  const [codeInput, setCodeInput] = useState(prefill?.discountCode ?? '');
  const [code, setCode] = useState(prefill?.discountCode ?? '');
  const [codeError, setCodeError] = useState<unknown>(null);
  // A gift card: typed, then applied (the quote says what it pays).
  const [giftInput, setGiftInput] = useState('');
  const [gift, setGift] = useState('');
  const [giftError, setGiftError] = useState<unknown>(null);
  const [giftOpen, setGiftOpen] = useState(false);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const linesBody = useMemo(() => cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), [cart.lines]);

  const refresh = useCallback(() => {
    if (!linesBody.length) return;
    void api<QuoteResult>(shopApi('/quote'), { method: 'POST', body: { lines: linesBody, fulfillment, ...(fulfillment === 'delivery' && { zone }), ...(code && { discountCode: code }), ...(gift && { giftCard: gift }) } })
      .then((q) => {
        setQuote(q);
        setQuoteError(null);
        setCodeError(null);
        setGiftError(null);
        setPayment((p) => (p && q.paymentMethods.includes(p) ? p : q.paymentMethods[0] ?? ''));
      })
      .catch((e) => {
        // A gift card that does not work is said next to it, and the order is quoted without it.
        if (gift && e instanceof ApiError && e.code.startsWith('gift_card')) {
          setGiftError(e);
          setGift('');
          return;
        }
        // A code that does not work is said next to it, and the order is quoted without it.
        if (code) {
          setCodeError(e);
          setCode('');
          return;
        }
        setQuote(null);
        setQuoteError(e);
      });
  }, [linesBody, fulfillment, zone, code, gift]);
  useEffect(refresh, [refresh]);

  // Once there is an email, the store keeps this checkout, to send a reminder if the buyer leaves.
  const validEmail = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(contact.email.trim());
  useEffect(() => {
    if (!info.reminders || !validEmail || !linesBody.length) return;
    const timer = setTimeout(() => {
      void api(shopApi(`/checkouts/${checkoutId()}`), {
        method: 'PUT',
        body: { email: contact.email.trim(), ...(contact.name.trim() && { name: contact.name.trim() }), lines: linesBody, fulfillment, ...(fulfillment === 'delivery' && zone && { zone }), ...(code && { discountCode: code }) },
      }).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [info.reminders, validEmail, contact.email, contact.name, linesBody, fulfillment, zone, code]);

  // Signed in: the account fills in what the buyer has not typed (once).
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (filled || !account) return;
    setFilled(true);
    const b = account.buyer;
    setContact((c) => ({ name: c.name || b.name || '', email: c.email || b.email, phone: c.phone || b.phone || '' }));
    const a = account.addresses.find((x) => x.isDefault) ?? account.addresses[0];
    if (a) {
      setAddressChoice(a.id);
      setAddress({ street: a.street, city: a.city, districtCode: a.districtCode });
    }
    if (b.business) {
      setBusiness(b.business);
      setWantsInvoice(true);
    }
  }, [account, filled]);

  if (!cart.lines.length) return <div className="shop-empty"><h1>{t('Your cart is empty')}</h1><Link className="button" to="/shop">{t('Keep shopping')}</Link></div>;
  const needsAddress = fulfillment === 'delivery' || wantsInvoice;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!payment) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ number: number; token: string; path: string; payment?: { redirectUrl: string } | { error: string } }>(shopApi('/orders'), {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: {
          lines: linesBody,
          fulfillment,
          ...(fulfillment === 'delivery' && { zone }),
          paymentMethod: payment,
          customer: { name: contact.name, phone: contact.phone, ...(contact.email && { email: contact.email }) },
          ...(needsAddress && { address }),
          ...(wantsInvoice && { business }),
          ...(note.trim() && { note: note.trim() }),
          ...(code && { discountCode: code }),
          ...(gift && quote?.giftCard && { giftCard: gift }),
          ...(info.reminders && store.get<string>(CHECKOUT_KEY) && { checkoutId: store.get<string>(CHECKOUT_KEY) }),
          ...(account && needsAddress && addressChoice === 'new' && saveAddress && { saveAddress: true }),
        },
      });
      cart.clear();
      // The account may have kept a new address or details.
      if (account) void loadAccount(true);
      store.remove(CHECKOUT_KEY);
      store.set(`etd.orderlinks.${slug}`, { ...(store.get<Record<string, string>>(`etd.orderlinks.${slug}`) ?? {}), [String(r.number)]: `/shop/orders/${r.number}?t=${r.token}` });
      // Paying online: on to the payment page (the provider's, or the test card page).
      if (r.payment && 'redirectUrl' in r.payment) {
        if (/^https?:/.test(r.payment.redirectUrl)) window.location.assign(r.payment.redirectUrl);
        else navigate(r.payment.redirectUrl.replace(/^\/[^/]+(?=\/shop\/)/, ''), { replace: true });
        return;
      }
      navigate(`/shop/orders/${r.number}?t=${r.token}`, { replace: true, viewTransition: true });
    } catch (err) {
      setError(err);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="shop-checkout" onSubmit={submit}>
      <div className="stack">
        <h1>{t('Check out')}</h1>
        {info.accounts && account === null && (
          <p className="small muted" style={{ margin: 0 }}>{t('Ordered here before?')} <Link to="/shop/account?next=checkout" viewTransition>{t('Sign in for faster checkout')}</Link></p>
        )}
        {account && <p className="small muted" style={{ margin: 0 }}>{t('Signed in as {email}', { email: account.buyer.email })}</p>}
        <fieldset className="stack">
          <legend>{t('Your details')}</legend>
          <Field label={t('Name')}><input required autoComplete="name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label={t('Phone')} hint={t('So the store can reach you about the order.')}><input required type="tel" autoComplete="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></Field>
            <Field label={t('Email')} hint={info.reminders ? `${t('For your order confirmation and receipt. Optional.')} ${t('If you leave before ordering, we may email you a reminder; you can stop them from the email.')}` : t('For your order confirmation and receipt. Optional.')}><input type="email" autoComplete="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
          </div>
        </fieldset>

        <fieldset className="stack">
          <legend>{t('Delivery or pickup')}</legend>
          <div className="choices">
            {info.delivery.enabled && info.delivery.zones.map((z) => (
              <Radio key={z.name} name="fulfillment" value={`d:${z.name}`} checked={fulfillment === 'delivery' && zone === z.name} onChange={() => { setFulfillment('delivery'); setZone(z.name); }}>
                <strong>{t('Delivery: {zone}', { zone: z.name })}</strong><span className="num">{Number(z.fee) > 0 ? money(z.fee) : t('Free')}</span>
              </Radio>
            ))}
            {info.pickup.enabled && (
              <Radio name="fulfillment" value="pickup" checked={fulfillment === 'pickup'} onChange={() => setFulfillment('pickup')}>
                <strong>{t('Pickup')}</strong><span className="small muted">{info.pickup.address}</span>
              </Radio>
            )}
          </div>
          {needsAddress && (
            <div className="stack">
              {account && account.addresses.length > 0 && (
                <div className="choices" role="radiogroup" aria-label={t('Address')}>
                  {account.addresses.map((a) => (
                    <Radio key={a.id} name="address" value={a.id} checked={addressChoice === a.id} onChange={() => { setAddressChoice(a.id); setAddress({ street: a.street, city: a.city, districtCode: a.districtCode }); }}>
                      <strong>{a.street}</strong><span className="small muted">{a.city}, {districtName(a.districtCode)}</span>
                    </Radio>
                  ))}
                  <Radio name="address" value="new" checked={addressChoice === 'new'} onChange={() => { setAddressChoice('new'); setAddress({ street: '', city: '', districtCode: '1' }); }}>
                    <strong>{t('Another address')}</strong>
                  </Radio>
                </div>
              )}
              {addressChoice === 'new' && (
                <>
                  <Field label={t('Street')}><input required autoComplete="street-address" value={address.street} onChange={(e) => setAddress({ ...address, street: e.target.value })} /></Field>
                  <div className="form-grid">
                    <Field label={t('City or town')}><input required autoComplete="address-level2" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></Field>
                    <Field label={t('District')}><Select value={address.districtCode} onChange={(e) => setAddress({ ...address, districtCode: e.target.value })}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
                  </div>
                  {account && <label className="row small"><input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} /> {t('Save this address to my account')}</label>}
                </>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="stack">
          <legend>{t('Payment')}</legend>
          <div className="choices">
            {(quote?.paymentMethods ?? []).map((m) => (
              <Radio key={m} name="payment" value={m} checked={payment === m} onChange={(v) => setPayment(v as PaymentMethod)}>
                <strong>{t(PAYMENT_LABEL[m])}</strong>
                <span className="small muted">{m === 'gift_card' ? t('Your gift card pays for all of it.') : m === 'bank_transfer' ? t('The bank details appear after you order.') : m === 'cash_on_delivery' ? t('Pay the driver in cash.') : m === 'online' ? t(PROVIDER_NOTE[info.payments.online ?? 'test'] ?? PROVIDER_NOTE.test!) : t('Pay when you collect.')}</span>
              </Radio>
            ))}
          </div>
          <label className="row small"><input type="checkbox" checked={wantsInvoice} onChange={(e) => setWantsInvoice(e.target.checked)} /> {t('I need a tax invoice for my business (with my TIN)')}</label>
          {wantsInvoice && (
            <div className="form-grid">
              <Field label={t('Business name')}><input required value={business.name} onChange={(e) => setBusiness({ ...business, name: e.target.value })} /></Field>
              <Field label="TIN"><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={business.tin} onChange={(e) => setBusiness({ ...business, tin: e.target.value })} /></Field>
            </div>
          )}
          <Field label={t('Note for the store')} hint={t('Optional.')}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </fieldset>
      </div>

      <aside className="card ticket summary stack">
        <span className="kicker" style={{ color: 'var(--lime)' }}>{t('Your order')}</span>
        {quote ? (
          <>
            <ul className="summary-lines">
              {quote.lines.map((l) => <li key={l.variantId}><span>{l.quantity} × {l.productTitle}{l.variantTitle && ` (${l.variantTitle})`}</span><span className="num">{money(l.listTotal ?? l.total)}</span></li>)}
              {quote.delivery && <li><span>{t('Delivery: {zone}', { zone: quote.delivery.zone })}</span><span className="num">{money(quote.delivery.total)}</span></li>}
              {quote.discount && <li className="discount-line"><span>{t('Discount {code}', { code: quote.discount.code })}</span><span className="num">−{money(quote.discount.saved)}</span></li>}
            </ul>
            <div><span>{t('GST included')}</span><span>{money(quote.totals.gst)}</span></div>
            <div className="grand"><span>{t('Total')}</span><span>{money(quote.totals.total)}</span></div>
            {quote.giftCard && (
              <>
                <div className="gift-line"><span>{t('Gift card ••••{last4}', { last4: quote.giftCard.last4 })}</span><span>−{money(quote.giftCard.applied)}</span></div>
                <div className="due-line"><span>{t('To pay')}</span><span>{money(quote.due ?? quote.totals.total)}</span></div>
              </>
            )}
          </>
        ) : quoteError ? <ErrorText error={quoteError} /> : <div className="skeleton" />}
        <div className="discount-entry">
          {code && quote?.discount ? (
            <div className="row small"><span>{t('Code {code} applied', { code: quote.discount.code })}</span><span className="spacer" /><button type="button" className="link" onClick={() => { setCode(''); setCodeInput(''); }}>{t('Remove')}</button></div>
          ) : (
            <div className="row">
              <input aria-label={t('Discount code')} placeholder={t('Discount code')} value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setCode(codeInput.trim()); } }} />
              <button type="button" className="secondary" disabled={!codeInput.trim()} onClick={() => setCode(codeInput.trim())}>{t('Apply')}</button>
            </div>
          )}
          <ErrorText error={codeError} />
        </div>
        <div className="discount-entry">
          {gift && quote?.giftCard ? (
            <div className="row small"><span>{t('Gift card ••••{last4}: {balance} on it', { last4: quote.giftCard.last4, balance: money(quote.giftCard.balance) })}</span><span className="spacer" /><button type="button" className="link" onClick={() => { setGift(''); setGiftInput(''); }}>{t('Remove')}</button></div>
          ) : giftOpen ? (
            <div className="row">
              <input aria-label={t('Gift card code')} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" value={giftInput} onChange={(e) => setGiftInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setGift(giftInput.trim()); } }} />
              <button type="button" className="secondary" disabled={!giftInput.trim()} onClick={() => setGift(giftInput.trim())}>{t('Apply')}</button>
            </div>
          ) : (
            <button type="button" className="link small" onClick={() => setGiftOpen(true)}>{t('Have a gift card?')}</button>
          )}
          <ErrorText error={giftError} />
        </div>
        <ErrorText error={error} />
        <button type="submit" className="big lime" disabled={busy || !quote || !payment}>{busy ? t('Placing your order…') : payment === 'online' ? t('Pay {amount}', { amount: money(quote?.due ?? quote?.totals.total ?? '0') }) : t('Place order')}<span className="chip" aria-hidden="true">→</span></button>
        <p className="small muted">{t('You get a receipt authorized by the Belize Tax Service once your payment is confirmed.')}</p>
      </aside>
    </form>
  );
}

interface BuyerOrder {
  store: { name: string; slug: string; whatsapp: string | null; telephone: string; email: string };
  number: number;
  status: 'open' | 'cancelled';
  paymentStatus: 'unpaid' | 'paid';
  fulfillmentStatus: 'unfulfilled' | 'fulfilled';
  /** When the store said it was ready for pickup, or on its way. */
  readyAt?: string | null;
  paymentMethod: PaymentMethod;
  fulfillment: 'delivery' | 'pickup';
  deliveryZone: string | null;
  customer: { name: string };
  address: { street: string; city: string; districtName: string | null } | null;
  lines: Array<{ lineNumber: number; productTitle: string; variantTitle: string | null; quantity: number; total: string }>;
  totals: { lineExtension: string; gst: string; total: string };
  createdAt: string;
  cancelReason: string | null;
  instructions: string | null;
  pickup: { address: string; instructions: string } | null;
  document: { type: string; series: string; number: string } | null;
  discount: { code: string } | null;
  online: { canPay: boolean; lastStatus: string | null; lastProblem: string | null; provider: string | null } | null;
  giftCard?: { amount: string } | null;
  amountDue?: string;
}

export function ShopOrder() {
  const t = useT();
  const { number } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [o, setO] = useState<BuyerOrder | null>(null);
  const [error, setError] = useState<unknown>(null);
  usePageTitle(t('Order #{n}', { n: number ?? '' }), useStoreInfo().name);
  // The order's link carries its token; from the account, the sign-in does instead.
  const tq = token ? `?t=${encodeURIComponent(token)}` : '';
  const info = useStoreInfo();
  const load = useCallback(() => api<BuyerOrder>(shopApi(`/orders/${number}${tq}`)).then(setO).catch(setError), [number, tq]);
  const navigate = useNavigate();
  const paymentId = params.get('payment');
  const [confirming, setConfirming] = useState(Boolean(paymentId));
  const [payError, setPayError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  // Paying from a wallet app (E-Kyash): the QR code stays up while we wait.
  const [wallet, setWallet] = useState<(WalletInfo & { paymentId: string }) | null>(null);
  const confirmUrl = useCallback((id: string) => shopApi(`/orders/${number}/payments/${id}/confirm${tq}`), [number, tq]);
  useEffect(() => {
    // Back from the payment page: ask whether it went through, then load the order.
    if (!paymentId) {
      void load();
      return;
    }
    void api<{ status: string; problem: string | null; wallet?: WalletInfo | null }>(confirmUrl(paymentId), { method: 'POST' })
      .then((r) => {
        if (r.status === 'pending' && r.wallet) setWallet({ ...r.wallet, paymentId });
      })
      .catch(() => null)
      .finally(() => {
        setConfirming(false);
        navigate(`/shop/orders/${number}${tq}`, { replace: true });
        void load();
      });
  }, [load, paymentId, number, token, navigate, confirmUrl]);
  useEffect(() => {
    if (!wallet) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (++tries > 200) return clearInterval(timer);
      void api<{ status: string }>(confirmUrl(wallet.paymentId), { method: 'POST' }).then((r) => {
        if (r.status !== 'pending') {
          setWallet(null);
          void load();
        }
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [wallet, confirmUrl, load]);
  const payNow = async () => {
    setPaying(true);
    setPayError(null);
    try {
      if (token) store.set(`etd.orderlinks.${slug}`, { ...(store.get<Record<string, string>>(`etd.orderlinks.${slug}`) ?? {}), [String(number)]: `/shop/orders/${number}?t=${token}` });
      const r = await api<{ redirectUrl: string }>(shopApi(`/orders/${number}/pay${tq}`), { method: 'POST' });
      if (/^https?:/.test(r.redirectUrl)) window.location.assign(r.redirectUrl);
      else navigate(r.redirectUrl.replace(/^\/[^/]+(?=\/shop\/)/, ''));
    } catch (e) {
      setPayError(e);
      setPaying(false);
    }
  };
  // While waiting for the payment to be confirmed, check now and then.
  useEffect(() => {
    if (!o || o.status === 'cancelled' || (o.paymentStatus === 'paid' && o.document && o.fulfillmentStatus === 'fulfilled')) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 15_000);
    return () => clearInterval(timer);
  }, [o, load]);
  if (error) {
    return (
      <div className="shop-empty">
        <h1>{t('Order not found')}</h1>
        <p className="muted">{t('Use the link from your confirmation.')}</p>
        {!token && info.accounts && <Link className="button" to={`/shop/account?next=orders/${number}`}>{t('Sign in to see your orders')}</Link>}
      </div>
    );
  }
  if (!o || confirming) return <div className="stack shop-narrow">{confirming && <p className="muted">{t('Checking your payment…')}</p>}<div className="skeleton" style={{ height: '20rem' }} /></div>;

  const steps: Array<[string, boolean]> = [
    [t('Ordered'), true],
    [t('Paid'), o.paymentStatus === 'paid'],
    [o.fulfillment === 'pickup' ? t('Ready for pickup') : t('On its way'), Boolean(o.readyAt) || o.fulfillmentStatus === 'fulfilled'],
    [o.fulfillment === 'pickup' ? t('Picked up') : t('Delivered'), o.fulfillmentStatus === 'fulfilled'],
  ];
  const wa = whatsappNumber(o.store.whatsapp);
  return (
    <div className="stack shop-narrow">
      <div>
        <span className="kicker">{o.store.name}</span>
        <h1>{o.status === 'cancelled' ? t('Order #{n} was cancelled', { n: o.number }) : t('Thank you, {name}', { name: o.customer.name.split(' ')[0] ?? '' })}</h1>
        <p className="muted">{t('Order #{n}', { n: o.number })} · {new Date(o.createdAt).toLocaleString()}</p>
      </div>
      {o.status === 'cancelled' ? (
        <div className="banner info"><div><strong>{t('Cancelled')}</strong>{o.cancelReason}</div></div>
      ) : (
        <ol className="steps" aria-label={t('Order progress')}>
          {steps.map(([label, done]) => <li key={label} className={done ? 'done' : ''}><span className="dot" aria-hidden="true" />{label}<span className="sr-only">{done ? t('done') : t('to come')}</span></li>)}
        </ol>
      )}
      {o.instructions !== null && o.paymentStatus === 'unpaid' && o.status === 'open' && (
        <section className="card stack pay-box">
          <h2>{t('Pay {amount} by bank transfer', { amount: money(o.amountDue ?? o.totals.total) })}</h2>
          <pre className="instructions">{o.instructions || t('The store will send you its bank details.')}</pre>
          <p className="small">{t('Use order #{n} as the reference. The store confirms your payment and your receipt appears here.', { n: o.number })}</p>
        </section>
      )}
      {wallet && o.paymentStatus === 'unpaid' && o.status === 'open' && <WalletPay wallet={wallet} amount={o.totals.total} />}
      {o.online && o.paymentStatus === 'unpaid' && o.status === 'open' && !wallet && (
        <section className="card stack pay-box">
          <h2>{t('Pay {amount} online', { amount: money(o.amountDue ?? o.totals.total) })}</h2>
          {o.online.lastStatus === 'failed' && <div className="banner bad"><div><strong>{t('The payment did not go through')}</strong>{o.online.lastProblem ?? t('Nothing was charged. You can try again.')}</div></div>}
          {o.online.lastStatus === 'pending' && <p className="small muted">{t('If you already paid, it can take a minute to show here.')}</p>}
          {o.online.canPay ? <button className="big lime" disabled={paying} onClick={() => void payNow()}>{paying ? t('Opening the payment page…') : t('Pay now')}<span className="chip" aria-hidden="true">→</span></button>
            : <p className="small">{t('The store is not taking online payments right now. Contact it to pay another way.')}</p>}
          <ErrorText error={payError} />
        </section>
      )}
      {o.paymentStatus === 'unpaid' && o.status === 'open' && o.paymentMethod !== 'bank_transfer' && o.paymentMethod !== 'online' && (
        <div className="banner info"><div>{o.paymentMethod === 'cash_on_delivery' ? t('Pay {amount} in cash when your order arrives.', { amount: money(o.amountDue ?? o.totals.total) }) : t('Pay {amount} when you pick up your order.', { amount: money(o.amountDue ?? o.totals.total) })}</div></div>
      )}
      {o.document && (
        <section className="card receipt-box row">
          <div>
            <strong>{o.document.type === '01' ? t('Your tax invoice') : t('Your receipt')}</strong>
            <div className="small muted">{t('Authorized by the Belize Tax Service')} · {o.document.series}-{o.document.number}</div>
          </div>
          <span className="spacer" />
          <a className="button" href={shopApi(`/orders/${o.number}/document${tq}`)} target="_blank" rel="noreferrer">{t('Download PDF')}<span className="chip" aria-hidden="true">↓</span></a>
        </section>
      )}
      {o.pickup && o.status === 'open' && <div className="banner info"><div><strong>{t('Pickup')}</strong>{o.pickup.address}{o.pickup.instructions && <><br />{o.pickup.instructions}</>}</div></div>}
      <section className="card">
        <ul className="summary-lines plain-lines">
          {o.lines.map((l) => <li key={l.lineNumber}><span>{l.quantity} × {l.productTitle}{l.variantTitle && ` (${l.variantTitle})`}</span><span className="num">{money(l.total)}</span></li>)}
          {o.fulfillment === 'delivery' && <li><span>{t('Delivery: {zone}', { zone: o.deliveryZone ?? '' })}</span><span className="muted small">{o.address && `${o.address.street}, ${o.address.city}`}</span></li>}
        </ul>
        <div className="totals">
          {o.discount && <div><span>{t('Discount code')}</span><span>{o.discount.code}</span></div>}
          <div><span>{t('GST included')}</span><span>{money(o.totals.gst)}</span></div>
          <div className="grand"><span>{t('Total')}</span><span>{money(o.totals.total)}</span></div>
          {o.giftCard && <div><span>{t('Paid with a gift card')}</span><span>−{money(o.giftCard.amount)}</span></div>}
          {o.giftCard && o.paymentMethod !== 'gift_card' && <div><span>{o.paymentStatus === 'paid' ? t('Paid the rest') : t('To pay')}</span><span>{money(o.amountDue ?? o.totals.total)}</span></div>}
        </div>
      </section>
      <p className="small muted">
        {t('Questions about your order?')} {o.store.telephone}
        {wa && <> · <a href={`https://wa.me/${wa}?text=${encodeURIComponent(t('Hello, about my order #{n}', { n: o.number }))}`} target="_blank" rel="noreferrer">WhatsApp</a></>}
      </p>
      {token ? <p className="small muted">{t('Keep this page’s link: it is how you get back to your order and receipt.')}</p>
        : <p className="small"><Link to="/shop/account" viewTransition>← {t('All your orders')}</Link></p>}
    </div>
  );
}

/** The test gateway's pretend card page: approve or decline; no money moves. */
export function ShopTestPayment() {
  const t = useT();
  usePageTitle(t('Test payment'), useStoreInfo().name);
  const { paymentId } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ store: string; orderNumber: number; amount: string; status: string; decided: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<NonNullable<typeof info>>(shopApi(`/test-payments/${paymentId}`)).then(setInfo).catch(setError);
  }, [paymentId]);
  const decide = async (decision: 'approved' | 'declined') => {
    setBusy(true);
    try {
      await api(shopApi(`/test-payments/${paymentId}`), { method: 'POST', body: { decision } });
      // Back to the order, the way a real provider would send the buyer back.
      const back = store.get<Record<string, string>>(`etd.orderlinks.${slug}`)?.[String(info!.orderNumber)];
      navigate(back ? `${back}&payment=${paymentId}` : '/shop', { replace: true });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  if (error) return <div className="shop-empty"><ErrorText error={error} /></div>;
  if (!info) return <div className="skeleton" style={{ height: '16rem' }} />;
  return (
    <div className="shop-narrow stack test-pay">
      <div className="banner warn"><div><strong>{t('Test payment')}</strong>{t('This store is in the BTS test environment. No card is charged and no money moves.')}</div></div>
      <section className="card stack fake-card">
        <span className="kicker">{info.store} · {t('Order #{n}', { n: info.orderNumber })}</span>
        <div className="fake-card-amount">{money(info.amount)}</div>
        <div className="fake-card-number mono">4242 4242 4242 4242</div>
        <div className="row small muted"><span>12 / 34</span><span className="spacer" /><span>CVC 123</span></div>
        <div className="row">
          <button className="secondary" disabled={busy || info.decided} onClick={() => void decide('declined')}>{t('Decline')}</button>
          <span className="spacer" />
          <button className="lime" disabled={busy || info.decided} onClick={() => void decide('approved')}>{t('Pay {amount}', { amount: money(info.amount) })}</button>
        </div>
      </section>
    </div>
  );
}

/** "Email me when it's back" on a sold-out variant. */
function BackInStock({ handle, variantId }: { handle: string; variantId: string }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setDone(null);
    setError(null);
  }, [variantId]);
  if (done) return <p className="small" role="status">{t('We will email {email} once, when it is back.', { email: done })}</p>;
  return (
    <form className="row nowrap" onSubmit={(e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      api(shopApi(`/products/${handle}/notify`), { method: 'POST', body: { variantId, email: email.trim() } })
        .then(() => setDone(email.trim()))
        .catch(setError)
        .finally(() => setBusy(false));
    }}>
      <input type="email" required placeholder={t('Your email')} aria-label={t('Your email')} value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit" className="secondary" disabled={busy || !email.trim()}>{t('Email me when it is back')}</button>
      <ErrorText error={error} />
    </form>
  );
}

/** A reminder's link: the cart goes back on this device, then on to the checkout. */
export function ShopResume() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(t('Your cart'), info.name);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ordered' | 'empty' | 'error'>('loading');
  useEffect(() => {
    const token = params.get('t') ?? '';
    void api<{ ordered: true } | ({ ordered: false; checkoutId: string; lines: CartLine[] } & Prefill)>(shopApi(`/checkouts/restore?t=${encodeURIComponent(token)}`))
      .then((r) => {
        if (r.ordered) return setState('ordered');
        if (!r.lines.length) return setState('empty');
        setCart(r.lines);
        store.set(CHECKOUT_KEY, r.checkoutId);
        store.set(PREFILL_KEY, { email: r.email, name: r.name, fulfillment: r.fulfillment, zone: r.zone, discountCode: r.discountCode });
        navigate('/shop/checkout', { replace: true });
      })
      .catch(() => setState('error'));
  }, [params, navigate]);
  if (state === 'loading') return <div className="shop-empty"><p className="muted">{t('Getting your cart…')}</p></div>;
  return (
    <div className="shop-empty">
      <h1>{state === 'ordered' ? t('You already ordered this') : state === 'empty' ? t('These are no longer available') : t('This link has expired')}</h1>
      <p className="muted">{state === 'ordered' ? t('Thank you. Your order confirmation has the details.') : t('Have a look at what is in the store now.')}</p>
      <Link className="button" to="/shop">{t('Go to the store')}</Link>
    </div>
  );
}

/** A reminder's "stop these emails" link. */
export function ShopUnsubscribe() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(t('Email reminders'), info.name);
  const [params] = useSearchParams();
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'error'>('ask');
  const stop = () => {
    setState('busy');
    void api(shopApi(`/checkouts/unsubscribe?t=${encodeURIComponent(params.get('t') ?? '')}`), { method: 'POST' }).then(() => setState('done')).catch(() => setState('error'));
  };
  return (
    <div className="shop-empty">
      {state === 'done' ? (
        <>
          <h1>{t('You will not get these reminders again')}</h1>
          <p className="muted">{t('{store} will still email you about orders you place.', { store: info.name })}</p>
        </>
      ) : state === 'error' ? (
        <h1>{t('This link has expired')}</h1>
      ) : (
        <>
          <h1>{t('Stop cart reminders from {store}?', { store: info.name })}</h1>
          <p className="muted">{t('We email a reminder when an order is started and not finished. Order confirmations still come.')}</p>
          <button onClick={stop} disabled={state === 'busy'}>{t('Stop these emails')}</button>
        </>
      )}
      <Link to="/shop">{t('Go to the store')}</Link>
    </div>
  );
}

// ---------- the buyer's account ----------

/** Where to go after signing in (from the checkout or an order's page). */
function afterSignIn(next: string | null): string | null {
  return next && /^(checkout|orders\/\d{1,9})$/.test(next) ? `/shop/${next}` : null;
}

/** /shop/account: sign in (or make the account), then the account. */
export function ShopAccount() {
  const t = useT();
  const info = useStoreInfo();
  const account = useAccount();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  usePageTitle(account ? t('Your account') : t('Sign in'), info.name);
  useEffect(() => {
    if (info.accounts) void loadAccount();
  }, [info.accounts]);
  if (!info.accounts) return <div className="shop-empty"><h1>{t('This store does not have accounts')}</h1><Link className="button" to="/shop">{t('Back to the store')}</Link></div>;
  if (account === undefined) return <div className="shop-narrow"><div className="skeleton" style={{ height: '16rem' }} /></div>;
  if (account === null) {
    return <BuyerSignIn storeName={info.name} onDone={() => { const to = afterSignIn(params.get('next')); if (to) navigate(to, { replace: true, viewTransition: true }); }} />;
  }
  return <AccountHome account={account} />;
}

/** Email, then the six-digit code from it. */
function BuyerSignIn({ storeName, onDone }: { storeName: string; onDone: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ challenge: string; minutes: number } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await api<{ challenge: string; minutes: number }>(shopApi('/account/code'), { method: 'POST', body: { email: email.trim() } }));
      setCode('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!sent) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<BuyerAccount>(shopApi('/account/verify'), { method: 'POST', body: { challenge: sent.challenge, code: code.replace(/\s/g, '') } });
      setAccount({ buyer: r.buyer, addresses: r.addresses });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <div className="shop-narrow account-sign-in">
      <section className="card stack">
        <div>
          <span className="kicker">{storeName}</span>
          <h1>{t('Sign in')}</h1>
        </div>
        {!sent ? (
          <form className="stack" onSubmit={send}>
            <p className="muted" style={{ margin: 0 }}>{t('We email you a code: there is no password to remember. The first time, this makes your account.')}</p>
            <Field label={t('Email')}><input type="email" required autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <ErrorText error={error} />
            <button type="submit" className="big" disabled={busy || !email.trim()}>{busy ? t('Sending…') : t('Email me a code')}</button>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p className="muted" style={{ margin: 0 }}>{t('We sent a 6-digit code to {email}. It works for {n} minutes.', { email: email.trim(), n: sent.minutes })}</p>
            <Field label={t('Code')}>
              <input className="code-input" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="big" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? t('Signing in…') : t('Sign in')}</button>
            <div className="row small">
              <button type="button" className="link" disabled={busy} onClick={() => void send()}>{t('Send a new code')}</button>
              <span className="spacer" />
              <button type="button" className="link" disabled={busy} onClick={() => { setSent(null); setError(null); }}>{t('Use another email')}</button>
            </div>
          </form>
        )}
      </section>
      <p className="small muted">{t('Your account keeps your orders at this store, your addresses and your business details for tax invoices. You can still check out without one.')}</p>
    </div>
  );
}

interface AccountOrder {
  number: number;
  status: 'open' | 'cancelled';
  paymentStatus: 'unpaid' | 'paid';
  fulfillmentStatus: 'unfulfilled' | 'fulfilled';
  fulfillment: 'delivery' | 'pickup';
  ready: boolean;
  items: number;
  total: string;
  refunded: string | null;
  createdAt: string;
}

function orderState(o: AccountOrder, t: ReturnType<typeof useT>): string {
  if (o.status === 'cancelled') return t('Cancelled');
  if (o.fulfillmentStatus === 'fulfilled') return o.fulfillment === 'pickup' ? t('Picked up') : t('Delivered');
  if (o.ready) return o.fulfillment === 'pickup' ? t('Ready for pickup') : t('On its way');
  return o.paymentStatus === 'paid' ? t('Paid') : t('Ordered');
}

function AccountHome({ account }: { account: BuyerAccount }) {
  const t = useT();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<AccountOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    void api<{ data: AccountOrder[] }>(shopApi('/account/orders')).then((r) => setOrders(r.data)).catch(setError);
  }, []);
  const signOut = async () => {
    await api(shopApi('/account/sign-out'), { method: 'POST' }).catch(() => {});
    setAccount(null);
    navigate('/shop', { viewTransition: true });
  };
  const close = async () => {
    try {
      await api(shopApi('/account'), { method: 'DELETE' });
      setAccount(null);
      navigate('/shop', { viewTransition: true });
    } catch (e) {
      setError(e);
      setClosing(false);
    }
  };
  return (
    <div className="stack shop-narrow account">
      <div className="row">
        <div>
          <h1>{account.buyer.name ? t('Hello, {name}', { name: account.buyer.name.split(' ')[0] ?? '' }) : t('Your account')}</h1>
          <p className="muted" style={{ margin: 0 }}>{account.buyer.email}</p>
        </div>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => void signOut()}>{t('Sign out')}</button>
      </div>

      <section className="card stack">
        <h2>{t('Your orders')}</h2>
        <ErrorText error={error} />
        {orders === null ? <div className="skeleton" style={{ height: '5rem' }} /> : orders.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('No orders yet.')} <Link to="/shop" viewTransition>{t('Start shopping')}</Link></p>
        ) : (
          <ul className="account-orders">
            {orders.map((o) => (
              <li key={o.number}>
                <Link to={`/shop/orders/${o.number}`} viewTransition>
                  <span className="grow">
                    <strong>{t('Order #{n}', { n: o.number })}</strong>
                    <span className="small muted">{new Date(o.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {o.items === 1 ? t('1 item') : t('{n} items', { n: o.items })}</span>
                  </span>
                  <span className={`order-state ${o.status === 'cancelled' ? 'off' : o.fulfillmentStatus === 'fulfilled' ? 'done' : ''}`}>{orderState(o, t)}</span>
                  <span className="num">{money(o.total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AccountAddresses addresses={account.addresses} />
      <AccountDetails account={account} />

      <section className="card stack">
        <h2>{t('Close your account')}</h2>
        <p className="small muted" style={{ margin: 0 }}>{t('Your addresses and details are deleted and you are signed out. The store keeps its records of your orders, which it needs for its taxes.')}</p>
        {closing ? (
          <div className="row">
            <button type="button" className="danger" onClick={() => void close()}>{t('Yes, close my account')}</button>
            <button type="button" className="secondary" onClick={() => setClosing(false)}>{t('Keep it')}</button>
          </div>
        ) : <div><button type="button" className="secondary" onClick={() => setClosing(true)}>{t('Close my account')}</button></div>}
      </section>
    </div>
  );
}

type AddressForm = { street: string; city: string; districtCode: string; isDefault: boolean };

function AccountAddresses({ addresses }: { addresses: BuyerAddress[] }) {
  const t = useT();
  // The address being edited ('new' for one being added).
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<AddressForm>({ street: '', city: '', districtCode: '1', isDefault: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const open = (a?: BuyerAddress) => {
    setEditing(a?.id ?? 'new');
    setForm(a ? { street: a.street, city: a.city, districtCode: a.districtCode, isDefault: a.isDefault } : { street: '', city: '', districtCode: '1', isDefault: addresses.length === 0 });
    setError(null);
  };
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      await loadAccount(true);
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = { street: form.street.trim(), city: form.city.trim(), districtCode: form.districtCode, isDefault: form.isDefault };
    void run(() => editing === 'new' ? api(shopApi('/account/addresses'), { method: 'POST', body }) : api(shopApi(`/account/addresses/${editing}`), { method: 'PUT', body }));
  };
  return (
    <section className="card stack">
      <div className="row">
        <h2>{t('Addresses')}</h2>
        <span className="spacer" />
        {editing === null && addresses.length < 10 && <button type="button" className="secondary" onClick={() => open()}>{t('Add an address')}</button>}
      </div>
      {addresses.length === 0 && editing === null && <p className="muted" style={{ margin: 0 }}>{t('Addresses you keep here are offered at checkout.')}</p>}
      <ul className="account-addresses">
        {addresses.map((a) => editing === a.id ? null : (
          <li key={a.id}>
            <span className="grow">
              <strong>{a.street}</strong>
              <span className="small muted">{a.city}, {districtName(a.districtCode)}</span>
            </span>
            {a.isDefault ? <span className="badge authorized">{t('Default')}</span> : (
              <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api(shopApi(`/account/addresses/${a.id}`), { method: 'PUT', body: { street: a.street, city: a.city, districtCode: a.districtCode, isDefault: true } }))}>{t('Make default')}</button>
            )}
            <button type="button" className="link small" disabled={busy} onClick={() => open(a)}>{t('Edit')}</button>
            <button type="button" className="link small" disabled={busy} onClick={() => void run(() => api(shopApi(`/account/addresses/${a.id}`), { method: 'DELETE' }))}>{t('Remove')}</button>
          </li>
        ))}
      </ul>
      {editing !== null && (
        <form className="stack address-form" onSubmit={save}>
          <Field label={t('Street')}><input required autoComplete="street-address" autoFocus value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label={t('City or town')}><input required autoComplete="address-level2" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label={t('District')}><Select value={form.districtCode} onChange={(e) => setForm({ ...form, districtCode: e.target.value })}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
          </div>
          <label className="row small"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> {t('Use this address first at checkout')}</label>
          <div className="row">
            <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save address')}</button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      <ErrorText error={error} />
    </section>
  );
}

function AccountDetails({ account }: { account: BuyerAccount }) {
  const t = useT();
  const b = account.buyer;
  const [form, setForm] = useState({ name: b.name ?? '', phone: b.phone ?? '', invoice: Boolean(b.business), tin: b.business?.tin ?? '', businessName: b.business?.name ?? '' });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await api<BuyerAccount>(shopApi('/account'), {
        method: 'PUT',
        body: { name: form.name.trim(), phone: form.phone.trim(), business: form.invoice ? { tin: form.tin, name: form.businessName.trim() } : null },
      });
      setAccount({ buyer: r.buyer, addresses: r.addresses });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" onSubmit={save}>
      <h2>{t('Your details')}</h2>
      <p className="small muted" style={{ margin: 0 }}>{t('Checkout fills these in for you.')}</p>
      <div className="form-grid">
        <Field label={t('Name')}><input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t('Phone')}><input type="tel" autoComplete="tel" pattern="[0-9+()\-\s]{7,30}" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
      </div>
      <label className="row small"><input type="checkbox" checked={form.invoice} onChange={(e) => setForm({ ...form, invoice: e.target.checked })} /> {t('I need tax invoices for my business (with my TIN)')}</label>
      {form.invoice && (
        <div className="form-grid">
          <Field label={t('Business name')}><input required value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></Field>
          <Field label="TIN"><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} /></Field>
        </div>
      )}
      <ErrorText error={error} />
      <div className="row">
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save details')}</button>
        {saved && <span className="small muted" role="status">{t('Saved')}</span>}
      </div>
    </form>
  );
}

// ---------- a gift card's balance ----------

/** /shop/gift-card: the balance of a card, from its code (the link in its email). */
export function ShopGiftCardBalance() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(t('Gift card balance'), info.name);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ last4: string; balance: string; status: 'active' | 'used_up' | 'expired' | 'disabled'; expiresOn: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<NonNullable<typeof result>>(shopApi('/gift-cards/balance'), { method: 'POST', body: { code: code.trim() } }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shop-narrow account-sign-in">
      <form className="card stack" onSubmit={check}>
        <div>
          <span className="kicker">{info.name}</span>
          <h1>{t('Gift card balance')}</h1>
        </div>
        <Field label={t('Gift card code')}><input required autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy || !code.trim()}>{busy ? t('Checking…') : t('Check the balance')}</button>
        {result && (
          <div className="gift-card-face" role="status">
            <span className="small">{t('Gift card ••••{last4}', { last4: result.last4 })}</span>
            <strong className="gift-card-amount">{money(result.balance)}</strong>
            <span className="small">
              {result.status === 'active' ? (result.expiresOn ? t('Use it by {date}, here or in the store.', { date: result.expiresOn }) : t('Use it here at checkout, or in the store.'))
                : result.status === 'used_up' ? t('This card has been used up.') : result.status === 'expired' ? t('This card has expired.') : t('This card is turned off. Contact the store.')}
            </span>
          </div>
        )}
      </form>
      <Link className="small" to="/shop" viewTransition>← {t('Back to the store')}</Link>
    </div>
  );
}
