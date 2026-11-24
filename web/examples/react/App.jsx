import React, { useEffect, useMemo, useState } from 'react';
import { floreo } from './floreo.js';

const PAYMENT_NAMES = { bank_transfer: 'Bank transfer', pay_at_pickup: 'Pay at pickup', cash_on_delivery: 'Cash on delivery', online: 'Pay online now' };

/** The store's products, a page at a time. */
function useProducts() {
  const [products, setProducts] = useState([]);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const load = (cursor) =>
    floreo(`/products?limit=6&sort=title${cursor ? `&cursor=${cursor}` : ''}`)
      .then((page) => {
        setProducts((shown) => (cursor ? [...shown, ...page.data] : page.data));
        setNext(page.nextCursor);
      })
      .catch(setError);
  useEffect(() => {
    load();
  }, []);
  return { products, error, more: next ? () => load(next) : null };
}

/** The cart priced by the store: the total, and the ways to pay. */
function useQuote(lines) {
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!lines.length) return setQuote(null);
    let current = true;
    floreo('/quote', { method: 'POST', body: { lines, fulfillment: 'pickup' } }).then((q) => current && setQuote(q)).catch(() => current && setQuote(null));
    return () => {
      current = false;
    };
  }, [JSON.stringify(lines)]);
  return quote;
}

export default function App() {
  const { products, error, more } = useProducts();
  const [cart, setCart] = useState([]); // [{ variantId, quantity, title }]
  const [order, setOrder] = useState(null);
  const [problem, setProblem] = useState(null);
  const lines = useMemo(() => cart.map(({ variantId, quantity }) => ({ variantId, quantity })), [cart]);
  const quote = useQuote(lines);
  // One key for this checkout: sending the order again with it never orders twice.
  const [orderKey] = useState(() => crypto.randomUUID());

  // What is ordered is a variant (a size, a colour); a product without options has one.
  async function add(handle) {
    const product = await floreo(`/products/${handle}`);
    const variant = product.variants.find((v) => v.available);
    const title = [product.title, variant.title].filter(Boolean).join(' – ');
    setCart((now) => (now.some((l) => l.variantId === variant.id)
      ? now.map((l) => (l.variantId === variant.id ? { ...l, quantity: l.quantity + 1 } : l))
      : [...now, { variantId: variant.id, quantity: 1, title }]));
  }

  async function placeOrder(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    setProblem(null);
    try {
      const placed = await floreo('/orders', {
        method: 'POST',
        idempotencyKey: orderKey,
        body: {
          lines,
          fulfillment: 'pickup',
          paymentMethod: form.get('paymentMethod'),
          customer: { name: form.get('name'), phone: form.get('phone') },
          ...(form.get('paymentMethod') === 'online' && { returnUrl: window.location.origin + window.location.pathname }),
        },
      });
      // Paying online: on to the payment page; the buyer comes back with floreo_order in the address.
      if (placed.payment?.url) return window.location.assign(placed.payment.url);
      setCart([]);
      setOrder(placed);
    } catch (e) {
      setProblem(e.message);
    }
  }

  if (error) return <p role="alert">{error.message}</p>;
  if (order) return <p>Thank you. Order #{order.number} is placed. <a href={order.orderUrl}>See your order</a></p>;
  return (
    <main>
      <h1>My store</h1>
      <ul className="products">
        {products.map((p) => (
          <li key={p.handle}>
            {p.imageUrl && <img src={p.imageUrl} alt="" width="160" />}
            <strong>{p.title}</strong> BZ${p.price}{' '}
            <button disabled={p.soldOut} onClick={() => add(p.handle)}>{p.soldOut ? 'Sold out' : 'Add to cart'}</button>
          </li>
        ))}
      </ul>
      {more && <button onClick={more}>Show more</button>}

      <h2>Cart</h2>
      <ul className="cart">{cart.map((l) => <li key={l.variantId}>{l.quantity} × {l.title}</li>)}</ul>
      {quote && (
        <form onSubmit={placeOrder}>
          <p>Total BZ${quote.totals.total}</p>
          <label>Full name <input name="name" required /></label>
          <label>Phone <input name="phone" required minLength={7} /></label>
          <label>How to pay{' '}
            <select name="paymentMethod">{quote.paymentMethods.map((m) => <option key={m} value={m}>{PAYMENT_NAMES[m] ?? m}</option>)}</select>
          </label>
          {problem && <p role="alert">{problem}</p>}
          <button>Place order</button>
        </form>
      )}
    </main>
  );
}
