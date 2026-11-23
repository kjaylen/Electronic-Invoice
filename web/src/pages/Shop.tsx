/**
 * The public storefront, at /<business>/shop. No sign-in: buyers browse,
 * fill a cart (kept on their device), check out, and follow their order on a
 * private page that later holds their BTS receipt.
 */

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { api, ApiError, type PaymentMethod } from '../api';
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
}

interface ProductCard {
  handle: string;
  title: string;
  imageId: string | null;
  price: string;
  priceVaries: boolean;
  soldOut: boolean;
}

interface ProductPage {
  handle: string;
  title: string;
  description: string;
  options: string[];
  images: string[];
  variants: Array<{ id: string; title: string | null; option1: string | null; option2: string | null; price: string; available: boolean; left: number | null }>;
}

const slug = BUSINESS ?? '';
const shopApi = (path: string) => `/v1/store/${slug}${path}`;
export const imageUrl = (id: string) => `/v1/store/${slug}/images/${id}`;
const PAYMENT_LABEL: Record<PaymentMethod, string> = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', online: 'Pay online now' };

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

// ---------- layout ----------

export function ShopLayout() {
  const t = useT();
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { count } = useCart();
  const location = useLocation();
  useEffect(() => {
    void api<StoreInfo>(shopApi('')).then(setInfo).catch(setError);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  if (error) {
    const closed = error instanceof ApiError && (error.code === 'store_closed' || error.status === 404);
    return (
      <div className="shop">
        <main className="shop-main"><div className="shop-empty"><h1>{closed ? t('This store is not open yet') : t('Something went wrong')}</h1><p className="muted">{closed ? t('Check back soon.') : t('Please try again in a moment.')}</p></div></main>
      </div>
    );
  }
  return (
    <div className="shop">
      {info?.test && <div className="shop-test" role="note">{t('Test store: orders are not real and receipts have no fiscal value.')}</div>}
      <header className="shop-header">
        <Link to="/shop" className="shop-brand" viewTransition>
          <span className="shop-name">{info?.name ?? ' '}</span>
          {info?.tagline && <span className="shop-tagline">{info.tagline}</span>}
        </Link>
        <span className="spacer" />
        <LanguageToggle />
        <Link to="/shop/cart" className="button cart-button" viewTransition aria-label={t('Cart, {n} items', { n: count })}>
          {t('Cart')}<span className="chip" aria-hidden="true">{count}</span>
        </Link>
      </header>
      <main className="shop-main" id="main">
        <div className="page" key={location.pathname}>
          {info ? <Outlet context={info} /> : <div className="shop-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: '16rem' }} />)}</div>}
        </div>
      </main>
      <footer className="shop-footer">
        {info?.about && <p>{info.about}</p>}
        <p className="small">{info?.city && `${info.city} · `}{info?.telephone}{info?.whatsapp && <> · <a href={`https://wa.me/${whatsappNumber(info.whatsapp) ?? ''}`} target="_blank" rel="noreferrer">WhatsApp</a></>}</p>
        <p className="small muted">{t('Every purchase comes with a receipt authorized by the Belize Tax Service.')} · eInvoicing</p>
      </footer>
    </div>
  );
}

const useStoreInfo = () => useOutletContext<StoreInfo>();

// ---------- pages ----------

export function ShopHome() {
  const t = useT();
  const info = useStoreInfo();
  usePageTitle(info.name);
  const [products, setProducts] = useState<ProductCard[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => void api<{ data: ProductCard[] }>(shopApi(`/products${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)).then((r) => setProducts(r.data)), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <div className="stack">
      <div className="shop-hero">
        <h1>{info.name}</h1>
        {info.tagline && <p>{info.tagline}</p>}
        <div className="shop-perks small">
          {info.delivery.enabled && <span>{t('Delivery')}{info.delivery.zones.length > 0 && `: ${info.delivery.zones.map((z) => z.name).join(', ')}`}</span>}
          {info.pickup.enabled && <span>{t('Pickup in {city}', { city: info.city })}</span>}
        </div>
      </div>
      <input type="search" className="shop-search" placeholder={t('Search the store')} aria-label={t('Search the store')} value={q} onChange={(e) => setQ(e.target.value)} />
      {products === null ? <div className="shop-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: '16rem' }} />)}</div> : products.length === 0 ? (
        <div className="shop-empty"><p className="muted">{q ? t('Nothing matches your search.') : t('No products yet. Check back soon.')}</p></div>
      ) : (
        <div className="shop-grid">
          {products.map((p) => (
            <Link key={p.handle} to={`/shop/products/${p.handle}`} className={`shop-card ${p.soldOut ? 'sold-out' : ''}`} viewTransition>
              <div className="shop-thumb">{p.imageId ? <img src={imageUrl(p.imageId)} alt="" loading="lazy" /> : <span aria-hidden="true">◇</span>}{p.soldOut && <span className="sold-tag">{t('Sold out')}</span>}</div>
              <span className="shop-card-title">{p.title}</span>
              <span className="shop-price num">{p.priceVaries ? t('From {price}', { price: money(p.price) }) : money(p.price)}</span>
            </Link>
          ))}
        </div>
      )}
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
  usePageTitle(p?.title ?? '');
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
        <h1>{p.title}</h1>
        <p className="shop-price big num">{variant ? money(variant.price) : '—'}</p>
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
        {variant && !variant.available && <p className="form-error">{t('Sold out')}</p>}
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
    </div>
  );
}

export function ShopCart() {
  const t = useT();
  usePageTitle(t('Cart'));
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
  usePageTitle(t('Check out'));
  const info = useStoreInfo();
  const navigate = useNavigate();
  const cart = useCart();
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>(info.delivery.enabled ? 'delivery' : 'pickup');
  const [zone, setZone] = useState(info.delivery.zones[0]?.name ?? '');
  const [payment, setPayment] = useState<PaymentMethod | ''>('');
  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [address, setAddress] = useState({ street: '', city: '', districtCode: '1' });
  const [wantsInvoice, setWantsInvoice] = useState(false);
  const [business, setBusiness] = useState({ tin: '', name: '' });
  const [note, setNote] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<unknown>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const linesBody = useMemo(() => cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), [cart.lines]);

  const refresh = useCallback(() => {
    if (!linesBody.length) return;
    void api<QuoteResult>(shopApi('/quote'), { method: 'POST', body: { lines: linesBody, fulfillment, ...(fulfillment === 'delivery' && { zone }), ...(code && { discountCode: code }) } })
      .then((q) => {
        setQuote(q);
        setQuoteError(null);
        setCodeError(null);
        setPayment((p) => (p && q.paymentMethods.includes(p) ? p : q.paymentMethods[0] ?? ''));
      })
      .catch((e) => {
        // A code that does not work is said next to it, and the order is quoted without it.
        if (code) {
          setCodeError(e);
          setCode('');
          return;
        }
        setQuote(null);
        setQuoteError(e);
      });
  }, [linesBody, fulfillment, zone, code]);
  useEffect(refresh, [refresh]);

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
        },
      });
      cart.clear();
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
        <fieldset className="stack">
          <legend>{t('Your details')}</legend>
          <Field label={t('Name')}><input required autoComplete="name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></Field>
          <div className="form-grid">
            <Field label={t('Phone')} hint={t('So the store can reach you about the order.')}><input required type="tel" autoComplete="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></Field>
            <Field label={t('Email')} hint={t('For your order confirmation and receipt. Optional.')}><input type="email" autoComplete="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
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
              <Field label={t('Street')}><input required autoComplete="street-address" value={address.street} onChange={(e) => setAddress({ ...address, street: e.target.value })} /></Field>
              <div className="form-grid">
                <Field label={t('City or town')}><input required autoComplete="address-level2" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></Field>
                <Field label={t('District')}><Select value={address.districtCode} onChange={(e) => setAddress({ ...address, districtCode: e.target.value })}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
              </div>
            </div>
          )}
        </fieldset>

        <fieldset className="stack">
          <legend>{t('Payment')}</legend>
          <div className="choices">
            {(quote?.paymentMethods ?? []).map((m) => (
              <Radio key={m} name="payment" value={m} checked={payment === m} onChange={(v) => setPayment(v as PaymentMethod)}>
                <strong>{t(PAYMENT_LABEL[m])}</strong>
                <span className="small muted">{m === 'bank_transfer' ? t('The bank details appear after you order.') : m === 'cash_on_delivery' ? t('Pay the driver in cash.') : m === 'online' ? t(PROVIDER_NOTE[info.payments.online ?? 'test'] ?? PROVIDER_NOTE.test!) : t('Pay when you collect.')}</span>
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
        <ErrorText error={error} />
        <button type="submit" className="big lime" disabled={busy || !quote || !payment}>{busy ? t('Placing your order…') : payment === 'online' ? t('Pay {amount}', { amount: money(quote?.totals.total ?? '0') }) : t('Place order')}<span className="chip" aria-hidden="true">→</span></button>
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
}

export function ShopOrder() {
  const t = useT();
  const { number } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [o, setO] = useState<BuyerOrder | null>(null);
  const [error, setError] = useState<unknown>(null);
  usePageTitle(t('Order #{n}', { n: number ?? '' }));
  const load = useCallback(() => api<BuyerOrder>(shopApi(`/orders/${number}?t=${encodeURIComponent(token)}`)).then(setO).catch(setError), [number, token]);
  const navigate = useNavigate();
  const paymentId = params.get('payment');
  const [confirming, setConfirming] = useState(Boolean(paymentId));
  const [payError, setPayError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  // Paying from a wallet app (E-Kyash): the QR code stays up while we wait.
  const [wallet, setWallet] = useState<(WalletInfo & { paymentId: string }) | null>(null);
  const confirmUrl = useCallback((id: string) => shopApi(`/orders/${number}/payments/${id}/confirm?t=${encodeURIComponent(token)}`), [number, token]);
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
        navigate(`/shop/orders/${number}?t=${encodeURIComponent(token)}`, { replace: true });
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
      store.set(`etd.orderlinks.${slug}`, { ...(store.get<Record<string, string>>(`etd.orderlinks.${slug}`) ?? {}), [String(number)]: `/shop/orders/${number}?t=${token}` });
      const r = await api<{ redirectUrl: string }>(shopApi(`/orders/${number}/pay?t=${encodeURIComponent(token)}`), { method: 'POST' });
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
  if (error) return <div className="shop-empty"><h1>{t('Order not found')}</h1><p className="muted">{t('Use the link from your confirmation.')}</p></div>;
  if (!o || confirming) return <div className="stack shop-narrow">{confirming && <p className="muted">{t('Checking your payment…')}</p>}<div className="skeleton" style={{ height: '20rem' }} /></div>;

  const steps: Array<[string, boolean]> = [
    [t('Ordered'), true],
    [t('Paid'), o.paymentStatus === 'paid'],
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
          <h2>{t('Pay {amount} by bank transfer', { amount: money(o.totals.total) })}</h2>
          <pre className="instructions">{o.instructions || t('The store will send you its bank details.')}</pre>
          <p className="small">{t('Use order #{n} as the reference. The store confirms your payment and your receipt appears here.', { n: o.number })}</p>
        </section>
      )}
      {wallet && o.paymentStatus === 'unpaid' && o.status === 'open' && <WalletPay wallet={wallet} amount={o.totals.total} />}
      {o.online && o.paymentStatus === 'unpaid' && o.status === 'open' && !wallet && (
        <section className="card stack pay-box">
          <h2>{t('Pay {amount} online', { amount: money(o.totals.total) })}</h2>
          {o.online.lastStatus === 'failed' && <div className="banner bad"><div><strong>{t('The payment did not go through')}</strong>{o.online.lastProblem ?? t('Nothing was charged. You can try again.')}</div></div>}
          {o.online.lastStatus === 'pending' && <p className="small muted">{t('If you already paid, it can take a minute to show here.')}</p>}
          {o.online.canPay ? <button className="big lime" disabled={paying} onClick={() => void payNow()}>{paying ? t('Opening the payment page…') : t('Pay now')}<span className="chip" aria-hidden="true">→</span></button>
            : <p className="small">{t('The store is not taking online payments right now. Contact it to pay another way.')}</p>}
          <ErrorText error={payError} />
        </section>
      )}
      {o.paymentStatus === 'unpaid' && o.status === 'open' && o.paymentMethod !== 'bank_transfer' && o.paymentMethod !== 'online' && (
        <div className="banner info"><div>{o.paymentMethod === 'cash_on_delivery' ? t('Pay {amount} in cash when your order arrives.', { amount: money(o.totals.total) }) : t('Pay {amount} when you pick up your order.', { amount: money(o.totals.total) })}</div></div>
      )}
      {o.document && (
        <section className="card receipt-box row">
          <div>
            <strong>{o.document.type === '01' ? t('Your tax invoice') : t('Your receipt')}</strong>
            <div className="small muted">{t('Authorized by the Belize Tax Service')} · {o.document.series}-{o.document.number}</div>
          </div>
          <span className="spacer" />
          <a className="button" href={shopApi(`/orders/${o.number}/document?t=${encodeURIComponent(token)}`)} target="_blank" rel="noreferrer">{t('Download PDF')}<span className="chip" aria-hidden="true">↓</span></a>
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
        </div>
      </section>
      <p className="small muted">
        {t('Questions about your order?')} {o.store.telephone}
        {wa && <> · <a href={`https://wa.me/${wa}?text=${encodeURIComponent(t('Hello, about my order #{n}', { n: o.number }))}`} target="_blank" rel="noreferrer">WhatsApp</a></>}
      </p>
      <p className="small muted">{t('Keep this page’s link: it is how you get back to your order and receipt.')}</p>
    </div>
  );
}

/** The test gateway's pretend card page: approve or decline; no money moves. */
export function ShopTestPayment() {
  const t = useT();
  usePageTitle(t('Test payment'));
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
