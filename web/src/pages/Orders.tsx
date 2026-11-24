/** Online orders: the to-do list, and one order with its actions (paid → receipt, delivered, cancel, refund). */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Order, type CheckoutSummary, type StoreBuyer, type StoreCheckout } from '../api';
import { type T, useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, fromCents, Modal, money, Segmented, StatusBadge, toCents, TYPE_NAMES, usePageTitle, whatsappNumber } from '../ui';
import { usePollWhile } from './Dashboard';

export const PAYMENT_LABEL = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', online: 'Paid online', gift_card: 'Gift card' } as const;

export function refundState(o: Pick<Order, 'totals'>): 'full' | 'partial' | null {
  const refunded = toCents(o.totals.refunded ?? '0');
  if (refunded <= 0n) return null;
  return refunded >= toCents(o.totals.total) ? 'full' : 'partial';
}

export function OrderBadges({ order: o }: { order: Pick<Order, 'status' | 'paymentStatus' | 'fulfillmentStatus' | 'fulfillment' | 'totals' | 'readyAt'> }) {
  const t = useT();
  const order = { ...o, refunded: refundState(o) };
  if (order.status === 'cancelled') return <span className="badge cancelled">{t('Cancelled')}</span>;
  return (
    <span className="row badges">
      {order.refunded ? <span className="badge cancelled">{order.refunded === 'full' ? t('Refunded') : t('Partly refunded')}</span> : (
        <span className={`badge ${order.paymentStatus === 'paid' ? 'authorized' : 'pending'}`}>{order.paymentStatus === 'paid' ? t('Paid') : t('Unpaid')}</span>
      )}
      <span className={`badge ${order.fulfillmentStatus === 'fulfilled' ? 'authorized' : 'test'}`}>
        {order.fulfillmentStatus === 'fulfilled' ? (order.fulfillment === 'pickup' ? t('Picked up') : t('Delivered')) : o.readyAt ? (order.fulfillment === 'pickup' ? t('Ready for pickup') : t('Out for delivery')) : order.fulfillment === 'pickup' ? t('To pick up') : t('To deliver')}
      </span>
    </span>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Orders() {
  const t = useT();
  usePageTitle(t('Orders'));
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'to_do';
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [data, setData] = useState<{ data: Order[]; counts: { unpaid: number; unfulfilled: number } } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    if (view === 'unfinished' || view === 'buyers') return;
    void api<{ data: Order[]; counts: { unpaid: number; unfulfilled: number } }>(`/v1/orders?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setData).catch(setError);
  }, [view, q]);
  useEffect(load, [load]);
  // New orders arrive while the page is open.
  usePollWhile(true, load, 20_000);
  const { session } = useSession();

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Online store')}</span><h1>{t('Orders')}</h1></div>
        <span className="spacer" />
        <a className="button secondary" href={`/${session?.business.slug}/shop`} target="_blank" rel="noreferrer">{t('View store')}<span className="chip" aria-hidden="true">↗</span></a>
      </div>
      <div className="row">
        <Segmented switches
          label={t('Orders')}
          value={view}
          onChange={(v) => setParams(v === 'to_do' ? {} : { view: v }, { replace: true })}
          options={[
            ['to_do', t('To do')],
            ['unpaid', data?.counts.unpaid ? `${t('Unpaid')} · ${data.counts.unpaid}` : t('Unpaid')],
            ['unfulfilled', data?.counts.unfulfilled ? `${t('To deliver')} · ${data.counts.unfulfilled}` : t('To deliver')],
            ['done', t('Done')],
            ['cancelled', t('Cancelled')],
            ['all', t('All')],
            ['unfinished', t('Unfinished')],
            ['buyers', t('Buyers')],
          ]}
        />
        <span className="spacer" />
        {view !== 'unfinished' && <input type="search" placeholder={view === 'buyers' ? t('Name, email or phone') : t('Order number, name or phone')} aria-label={view === 'buyers' ? t('Search buyers') : t('Search orders')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />}
      </div>
      <ErrorText error={error} />
      {view === 'unfinished' ? <UnfinishedCheckouts /> : view === 'buyers' ? <BuyerAccounts q={q} /> : (
      <section className="card">
        {data === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : data.data.length === 0 ? (
          <div className="empty">{view === 'to_do' ? t('Nothing to do. New orders from your store appear here.') : t('No orders here.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Order')}</th><th scope="col">{t('Date')}</th><th scope="col">{t('Customer')}</th><th scope="col">{t('Payment')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Status')}</th></tr></thead>
              <tbody>
                {data.data.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`, { viewTransition: true })}>
                    <td data-label={t('Order')}><Link to={`/orders/${o.id}`} viewTransition onClick={(e) => e.stopPropagation()} className="num">#{o.number}</Link></td>
                    <td data-label={t('Date')} className="small">{when(o.createdAt)}</td>
                    <td data-label={t('Customer')}>{o.customer.name}<div className="small muted">{o.fulfillment === 'delivery' ? o.deliveryZone : t('Pickup')}</div></td>
                    <td data-label={t('Payment')} className="small">{t(PAYMENT_LABEL[o.paymentMethod])}</td>
                    <td data-label={t('Total')} className="right">{money(o.totals.total)}</td>
                    <td data-label={t('Status')}><OrderBadges order={o} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </div>
  );
}

/** Buyers with an account at the store: what they ordered and spent. */
function BuyerAccounts({ q }: { q: string }) {
  const t = useT();
  const [data, setData] = useState<StoreBuyer[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const timer = setTimeout(() => void api<{ data: StoreBuyer[] }>(`/v1/store-buyers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => setData(r.data)).catch(setError), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <section className="card stack">
      <p className="small muted" style={{ margin: 0 }}>{t('Buyers sign in at your store with a code sent to their email. Their orders include any they placed as a guest with the same email.')}</p>
      <ErrorText error={error} />
      {data === null ? <div className="skeleton" style={{ height: '4rem' }} /> : data.length === 0 ? (
        <div className="empty">{q ? t('No buyer matches your search.') : t('No buyer accounts yet. Buyers make one by signing in at your store (Account, at the top of the store).')}</div>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Buyer')}</th><th scope="col">{t('Phone')}</th><th scope="col" className="right">{t('Orders')}</th><th scope="col" className="right">{t('Spent')}</th><th scope="col">{t('Last order')}</th><th scope="col">{t('Since')}</th></tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td data-label={t('Buyer')}>{b.name ?? '—'}{b.business && <span className="small muted"> · {b.business}</span>}<div className="small"><a href={`mailto:${b.email}`}>{b.email}</a></div></td>
                  <td data-label={t('Phone')} className="small">{b.phone ?? '—'}</td>
                  <td data-label={t('Orders')} className="right">{b.orders > 0 ? <Link to={`/orders?view=all&q=${encodeURIComponent(b.email)}`}>{b.orders}</Link> : 0}</td>
                  <td data-label={t('Spent')} className="right num">{money(b.spent)}</td>
                  <td data-label={t('Last order')} className="small">{b.lastOrderAt ? when(b.lastOrderAt) : '—'}</td>
                  <td data-label={t('Since')} className="small">{new Date(b.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Checkouts where the buyer gave their email and left; and those a reminder brought back. */
function UnfinishedCheckouts() {
  const t = useT();
  const [which, setWhich] = useState<'open' | 'recovered'>('open');
  const [data, setData] = useState<{ data: StoreCheckout[]; summary: CheckoutSummary } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setData(null);
    void api<{ data: StoreCheckout[]; summary: CheckoutSummary }>(`/v1/store-checkouts?view=${which}`).then(setData).catch(setError);
  }, [which]);
  return (
    <section className="card stack">
      <div className="row">
        <p className="small muted" style={{ margin: 0 }}>
          {data && data.summary.reminded > 0 ? t('Last 30 days: {reminded} reminded, {recovered} came back and ordered ({amount}).', { reminded: data.summary.reminded, recovered: data.summary.recovered, amount: money(data.summary.recoveredTotal) }) : '\u00a0'}
        </p>
        <span className="spacer" />
        <Segmented label={t('Show')} value={which} onChange={setWhich} options={[['open', t('Waiting')], ['recovered', t('Came back')]]} />
      </div>
      <ErrorText error={error} />
      {data === null ? <div className="skeleton" style={{ height: '4rem' }} /> : data.data.length === 0 ? (
        <div className="empty">{which === 'open' ? t('No unfinished checkouts. When a buyer gives their email and leaves, they appear here, and get a reminder (Settings → Online store).') : t('No orders from reminders yet.')}</div>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Buyer')}</th><th scope="col">{t('Last seen')}</th><th scope="col" className="right">{t('Items')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Reminders')}</th></tr></thead>
            <tbody>
              {data.data.map((c) => (
                <tr key={c.id}>
                  <td data-label={t('Buyer')}>{c.name ?? '—'}<div className="small"><a href={`mailto:${c.email}`}>{c.email}</a></div></td>
                  <td data-label={t('Last seen')} className="small">{when(c.updatedAt)}</td>
                  <td data-label={t('Items')} className="right">{c.items}</td>
                  <td data-label={t('Total')} className="right">{c.order ? money(c.order.total) : c.total ? money(c.total) : '—'}</td>
                  <td data-label={t('Reminders')} className="small">
                    {c.order ? <Link to={`/orders/${c.order.id}`} viewTransition>{t('Ordered: #{n}', { n: c.order.number })}</Link> : c.remindersSent === 0 ? t('Not sent yet') : c.remindersSent === 1 ? t('1 sent') : t('{n} sent', { n: c.remindersSent })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function nextStep(t: T, o: Order): string | null {
  if (o.status === 'cancelled' || refundState(o) === 'full') return null;
  if (o.paymentStatus === 'unpaid') {
    return o.paymentMethod === 'bank_transfer'
      ? t('Check your bank for a transfer of {amount} with reference #{n}, then mark it paid.', { amount: money(o.totals.total), n: o.number })
      : o.paymentMethod === 'cash_on_delivery'
        ? t('Collect {amount} in cash on delivery, then mark it paid.', { amount: money(o.totals.total) })
        : t('Collect {amount} when the customer picks it up, then mark it paid.', { amount: money(o.totals.total) });
  }
  if (o.fulfillmentStatus === 'unfulfilled') return o.fulfillment === 'pickup' ? t('Paid. Mark it picked up when the customer collects it.') : t('Paid. Mark it delivered once it arrives.');
  return null;
}

export function OrderDetail() {
  const t = useT();
  const toast = useToast();
  const { id } = useParams();
  const { can } = useSession();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [refunding, setRefunding] = useState(false);
  usePageTitle(order ? t('Order #{n}', { n: order.number }) : t('Order'));
  const load = useCallback(() => api<Order>(`/v1/orders/${id}`).then(setOrder).catch(setError), [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, fn: () => Promise<Order & { emailed?: boolean }>, message: (o: Order & { emailed?: boolean }) => string) => {
    setBusy(name);
    setError(null);
    try {
      const o = await fn();
      setOrder(o);
      toast(message(o));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  if (!order) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '14rem' }} />;
  const o = order;
  const docOk = o.document && ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'].includes(o.document.status);
  const phone = whatsappNumber(o.customer.phone);
  const step = nextStep(t, o);
  const canRefund = o.paymentStatus === 'paid' && docOk && o.document?.status !== 'pending' && can('documents.adjust')
    && Boolean(o.refundable && (o.refundable.delivery || o.refundable.lines.some((l) => l.quantity > 0)));

  const cancel = (e: FormEvent) => {
    e.preventDefault();
    setCancelling(false);
    void act('cancel', () => api<Order>(`/v1/orders/${o.id}/cancel`, { method: 'POST', body: { reason } }), () => t('Order #{n} cancelled; its stock is back', { n: o.number }));
  };

  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/orders" viewTransition style={{ color: 'inherit' }}>{t('Orders')}</Link> / #{o.number}</span>
          <h1>{t('Order #{n}', { n: o.number })}</h1>
          <p className="muted">{when(o.createdAt)} · {o.customer.name}</p>
        </div>
        <span className="spacer" />
        <OrderBadges order={o} />
        {o.recoveredByReminder && <span className="badge authorized">{t('Came back after a reminder')}</span>}
      </div>
      {step && <div className="banner info" role="status"><div><strong>{t('Next step')}</strong>{step}</div></div>}
      {o.status === 'cancelled' && <div className="banner info"><div><strong>{t('Cancelled')}</strong>{o.cancelReason}</div></div>}
      <ErrorText error={error} />

      <div className="row actions-bar">
        {o.status === 'open' && o.paymentStatus === 'unpaid' && can('documents.issue') && (
          <button className="lime" disabled={busy !== null} onClick={() => void act('paid', () => api(`/v1/orders/${o.id}/paid`, { method: 'POST' }), (r) => (r.emailed ? t('Paid. The receipt was issued and emailed to {email}.', { email: r.customer.email ?? '' }) : t('Paid. The receipt was issued.')))}>
            {busy === 'paid' ? t('Issuing the receipt…') : t('Mark paid and issue receipt')}<span className="chip" aria-hidden="true">→</span>
          </button>
        )}
        {o.paymentStatus === 'paid' && !docOk && can('documents.issue') && (
          <button disabled={busy !== null} onClick={() => void act('paid', () => api(`/v1/orders/${o.id}/paid`, { method: 'POST' }), () => t('The receipt was issued again.'))}>{t('Issue the receipt again')}</button>
        )}
        {o.status === 'open' && o.fulfillmentStatus === 'unfulfilled' && !o.readyAt && can('orders.manage') && (
          <button className="secondary" disabled={busy !== null} onClick={() => void act('ready', () => api<Order & { emailed?: boolean }>(`/v1/orders/${o.id}/ready`, { method: 'POST' }), (r) => (r.emailed ? t('Marked ready; the customer was told by email.') : t('Marked ready.')))}>
            {o.fulfillment === 'pickup' ? t('Ready for pickup') : t('Out for delivery')}
          </button>
        )}
        {o.status === 'open' && o.fulfillmentStatus === 'unfulfilled' && can('orders.manage') && (
          <button className="secondary" disabled={busy !== null} onClick={() => void act('fulfilled', () => api(`/v1/orders/${o.id}/fulfilled`, { method: 'POST' }), () => (o.fulfillment === 'pickup' ? t('Marked picked up') : t('Marked delivered')))}>
            {o.fulfillment === 'pickup' ? t('Mark picked up') : t('Mark delivered')}
          </button>
        )}
        {phone && <a className="button secondary whatsapp" href={`https://wa.me/${phone}?text=${encodeURIComponent(t('Hello {name}, about your order #{n}:', { name: o.customer.name, n: o.number }))}`} target="_blank" rel="noreferrer">WhatsApp</a>}
        <span className="spacer" />
        {canRefund && <button className="secondary" disabled={busy !== null} onClick={() => setRefunding(true)}>{t('Refund')}</button>}
        {o.status === 'open' && o.paymentStatus === 'unpaid' && can('orders.manage') && <button className="danger" onClick={() => setCancelling(true)}>{t('Cancel order')}</button>}
      </div>

      {o.document && (
        <div className={`banner ${docOk ? 'ok' : 'bad'}`}>
          <div className="row" style={{ width: '100%' }}>
            <span><strong>{t(TYPE_NAMES[o.document.type] ?? 'Document')} {o.document.series}-{o.document.number}</strong>{docOk ? t('Issued for this order.') : t('BTS rejected it. Open it to see why, then issue it again.')}</span>
            <span className="spacer" />
            <StatusBadge status={o.document.status} />
            <Link to={`/documents/${o.document.id}`} viewTransition>{t('Open')} →</Link>
          </div>
        </div>
      )}

      <div className="grid two">
        <section className="card">
          <h2>{t('Items')}</h2>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Qty')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
              <tbody>
                {o.lines?.map((l) => (
                  <tr key={l.lineNumber}>
                    <td data-label={t('Item')}>{l.productTitle}{l.variantTitle && <span className="muted"> · {l.variantTitle}</span>}</td>
                    <td data-label={t('Qty')} className="right">{l.quantity}</td>
                    <td data-label={t('Total')} className="right">{money(l.total)}</td>
                  </tr>
                ))}
                {o.fulfillment === 'delivery' && <tr><td>{t('Delivery')}: {o.deliveryZone}</td><td /><td className="right muted">{t('in total')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="totals">
            <div><span>{t('Subtotal')}</span><span>{money(o.totals.lineExtension)}</span></div>
            <div><span>GST</span><span>{money(o.totals.gst)}</span></div>
            <div className="grand"><span>{t('Total')}</span><span>{money(o.totals.total)}</span></div>
            {o.giftCard && <div><span>{t('Paid with a gift card')}</span><span>−{money(o.giftCard.amount)}</span></div>}
            {o.giftCard && o.paymentMethod !== 'gift_card' && <div><span>{o.paymentStatus === 'paid' ? t('Paid the rest') : t('Still to collect')}</span><span>{money(o.amountDue ?? o.totals.total)}</span></div>}
            {toCents(o.totals.refunded ?? '0') > 0n && <div><span>{t('Refunded')}</span><span>−{money(o.totals.refunded)}</span></div>}
          </div>
        </section>
        <section className="card stack">
          <h2>{t('Customer')}</h2>
          <dl className="facts">
            <dt>{t('Name')}</dt><dd>{o.customer.name}</dd>
            <dt>{t('Telephone')}</dt><dd><a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a></dd>
            {o.customer.email && <><dt>{t('Email')}</dt><dd>{o.customer.email}</dd></>}
            <dt>{t('Payment')}</dt><dd>{o.giftCard && o.paymentMethod !== 'gift_card' ? `${t('Gift card')} + ${t(PAYMENT_LABEL[o.paymentMethod])}` : t(PAYMENT_LABEL[o.paymentMethod])}</dd>
            <dt>{o.fulfillment === 'pickup' ? t('Pickup') : t('Delivery')}</dt>
            <dd>{o.fulfillment === 'pickup' ? t('At your shop') : <>{o.deliveryZone}{o.address && <div className="small">{o.address.street}, {o.address.city}{o.address.districtName && `, ${o.address.districtName}`}</div>}</>}</dd>
            {o.business && <><dt>{t('Tax invoice for')}</dt><dd>{o.business.name} · TIN {o.business.tin}</dd></>}
            {o.note && <><dt>{t('Note')}</dt><dd>{o.note}</dd></>}
          </dl>
        </section>
      </div>

      {o.refunds && o.refunds.length > 0 && (
        <section className="card">
          <h2>{t('Refunds')}</h2>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('Reason')}</th><th scope="col">{t('Credit note')}</th><th scope="col" className="right">{t('Amount')}</th></tr></thead>
              <tbody>
                {o.refunds.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('Date')} className="small">{when(r.createdAt)}</td>
                    <td data-label={t('Reason')}>{r.reason}{r.restocked && <div className="small muted">{t('Back in stock')}</div>}</td>
                    <td data-label={t('Credit note')}>{r.document && <Link to={`/documents/${r.document.id}`} viewTransition className="num">{r.document.series}-{r.document.number}</Link>} {r.document && <StatusBadge status={r.document.status} />}</td>
                    <td data-label={t('Amount')} className="right">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {refunding && (
        <RefundDialog
          order={o}
          onClose={() => setRefunding(false)}
          onDone={(r) => {
            setRefunding(false);
            setOrder(r);
            toast([
              r.emailed ? t('Refunded {amount}. The credit note was issued and emailed to {email}.', { amount: money(r.refund.amount), email: r.customer.email ?? '' }) : t('Refunded {amount}. The credit note was issued.', { amount: money(r.refund.amount) }),
              r.refund.toGiftCard ? t('{amount} went back on the gift card.', { amount: money(r.refund.toGiftCard) }) : '',
            ].filter(Boolean).join(' '));
          }}
        />
      )}

      {cancelling && (
        <Modal title={t('Cancel order #{n}?', { n: o.number })} onClose={() => setCancelling(false)}>
          <p>{t('The items go back into stock. No document was issued, so there is nothing to cancel with BTS.')}</p>
          <form className="stack" onSubmit={cancel}>
            <Field label={t('Reason')}><input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setCancelling(false)}>{t('Keep it')}</button><button type="submit" className="danger">{t('Cancel order')}</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

type RefundResult = Order & { refund: { id: string; amount: string; toGiftCard?: string | null; documentId: string; status: string }; emailed: boolean };

/** Choose what to refund: quantities per line, the delivery fee, whether it goes back into stock. */
function RefundDialog({ order: o, onClose, onDone }: { order: Order; onClose: () => void; onDone: (r: RefundResult) => void }) {
  const t = useT();
  const left = new Map((o.refundable?.lines ?? []).map((l) => [l.lineNumber, l.quantity]));
  const lines = (o.lines ?? []).filter((l) => (left.get(l.lineNumber) ?? 0) > 0);
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(lines.map((l) => [l.lineNumber, left.get(l.lineNumber) ?? 0])));
  const [delivery, setDelivery] = useState(Boolean(o.refundable?.delivery));
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The amount, from each line's total (with GST) shared over its quantity; the server's figure is exact.
  const linesCents = (o.lines ?? []).reduce((sum, l) => sum + toCents(l.total), 0n);
  const deliveryCents = toCents(o.totals.total) - linesCents;
  const estimate = lines.reduce((sum, l) => sum + (toCents(l.total) * BigInt(qty[l.lineNumber] ?? 0)) / BigInt(Math.max(1, l.quantity)), 0n) + (delivery ? deliveryCents : 0n);
  const nothing = estimate <= 0n && !delivery && lines.every((l) => !qty[l.lineNumber]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<RefundResult>(`/v1/orders/${o.id}/refund`, {
        method: 'POST',
        body: { reason, lines: lines.map((l) => ({ lineNumber: l.lineNumber, quantity: qty[l.lineNumber] ?? 0 })), delivery, restock },
      });
      onDone(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Refund order #{n}', { n: o.number })} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="muted">{t('A refund is a credit note against the order’s receipt. It is sent to BTS and emailed to the customer.')}</p>
        {lines.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">{t('Item')}</th><th scope="col" className="right">{t('Refund')}</th></tr></thead>
              <tbody>
                {lines.map((l) => {
                  const max = left.get(l.lineNumber) ?? 0;
                  return (
                    <tr key={l.lineNumber}>
                      <td>{l.productTitle}{l.variantTitle && <span className="muted"> · {l.variantTitle}</span>}<div className="small muted">{t('{n} can be refunded', { n: max })}</div></td>
                      <td className="right">
                        <input
                          type="number" min={0} max={max} step={1} inputMode="numeric" style={{ width: '5.5rem' }}
                          aria-label={t('Quantity to refund: {item}', { item: l.productTitle })}
                          value={qty[l.lineNumber] ?? 0}
                          onChange={(e) => setQty({ ...qty, [l.lineNumber]: Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))) })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {o.refundable?.delivery && (
          <label className="row small"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> {t('Refund the delivery fee ({amount})', { amount: money(fromCents(deliveryCents)) })}</label>
        )}
        {lines.length > 0 && <label className="row small"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> {t('Put the items back in stock')}</label>}
        <Field label={t('Reason')}><input required autoFocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('For example: returned, damaged, wrong size')} /></Field>
        <ErrorText error={error} />
        <div className="row">
          <strong>{t('Refund total')}: {money(fromCents(estimate))}</strong>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Back')}</button>
          <button type="submit" className="danger" disabled={busy || nothing}>{busy ? t('Issuing the credit note…') : t('Refund {amount}', { amount: money(fromCents(estimate)) })}</button>
        </div>
      </form>
    </Modal>
  );
}
