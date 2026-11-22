/** Online orders: the to-do list, and one order with its actions (paid → receipt, delivered, cancel). */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Order } from '../api';
import { type T, useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money, Segmented, StatusBadge, TYPE_NAMES, usePageTitle, whatsappNumber } from '../ui';
import { usePollWhile } from './Dashboard';

export const PAYMENT_LABEL = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup' } as const;

export function OrderBadges({ order }: { order: Pick<Order, 'status' | 'paymentStatus' | 'fulfillmentStatus' | 'fulfillment'> }) {
  const t = useT();
  if (order.status === 'cancelled') return <span className="badge cancelled">{t('Cancelled')}</span>;
  return (
    <span className="row badges">
      <span className={`badge ${order.paymentStatus === 'paid' ? 'authorized' : 'pending'}`}>{order.paymentStatus === 'paid' ? t('Paid') : t('Unpaid')}</span>
      <span className={`badge ${order.fulfillmentStatus === 'fulfilled' ? 'authorized' : 'test'}`}>
        {order.fulfillmentStatus === 'fulfilled' ? (order.fulfillment === 'pickup' ? t('Picked up') : t('Delivered')) : order.fulfillment === 'pickup' ? t('To pick up') : t('To deliver')}
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
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ data: Order[]; counts: { unpaid: number; unfulfilled: number } } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
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
        <Segmented
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
          ]}
        />
        <span className="spacer" />
        <input type="search" placeholder={t('Order number, name or phone')} aria-label={t('Search orders')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
      </div>
      <ErrorText error={error} />
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
    </div>
  );
}

function nextStep(t: T, o: Order): string | null {
  if (o.status === 'cancelled') return null;
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
        {o.status === 'open' && o.fulfillmentStatus === 'unfulfilled' && can('orders.manage') && (
          <button className="secondary" disabled={busy !== null} onClick={() => void act('fulfilled', () => api(`/v1/orders/${o.id}/fulfilled`, { method: 'POST' }), () => (o.fulfillment === 'pickup' ? t('Marked picked up') : t('Marked delivered')))}>
            {o.fulfillment === 'pickup' ? t('Mark picked up') : t('Mark delivered')}
          </button>
        )}
        {phone && <a className="button secondary whatsapp" href={`https://wa.me/${phone}?text=${encodeURIComponent(t('Hello {name}, about your order #{n}:', { name: o.customer.name, n: o.number }))}`} target="_blank" rel="noreferrer">WhatsApp</a>}
        <span className="spacer" />
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
          </div>
        </section>
        <section className="card stack">
          <h2>{t('Customer')}</h2>
          <dl className="facts">
            <dt>{t('Name')}</dt><dd>{o.customer.name}</dd>
            <dt>{t('Telephone')}</dt><dd><a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a></dd>
            {o.customer.email && <><dt>{t('Email')}</dt><dd>{o.customer.email}</dd></>}
            <dt>{t('Payment')}</dt><dd>{t(PAYMENT_LABEL[o.paymentMethod])}</dd>
            <dt>{o.fulfillment === 'pickup' ? t('Pickup') : t('Delivery')}</dt>
            <dd>{o.fulfillment === 'pickup' ? t('At your shop') : <>{o.deliveryZone}{o.address && <div className="small">{o.address.street}, {o.address.city}{o.address.districtName && `, ${o.address.districtName}`}</div>}</>}</dd>
            {o.business && <><dt>{t('Tax invoice for')}</dt><dd>{o.business.name} · TIN {o.business.tin}</dd></>}
            {o.note && <><dt>{t('Note')}</dt><dd>{o.note}</dd></>}
          </dl>
        </section>
      </div>

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
