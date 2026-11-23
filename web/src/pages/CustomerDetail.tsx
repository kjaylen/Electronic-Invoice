/**
 * A customer at a glance: what they bought (all time, this year), what they owe and what is
 * overdue, their recent documents and favourite items, with the actions that go with them
 * (a new invoice for them, their statement, all their documents).
 */

import { useEffect, useState } from 'react';
import { useToast } from '../toast';
import { Link, useParams } from 'react-router';
import { api, type Customer, type DocStatus } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { DISTRICTS, ErrorText, Field, fromCents, Modal, money, StatusBadge, toCents, TYPE_NAMES, usePageTitle } from '../ui';
import { StatementModal } from './Receivables';

interface Summary {
  customer: Customer;
  key: string;
  sales: { lifetime: string; thisYear: string; documents: number; lastSale: string | null; firstSale: string | null };
  owed: { total: string; overdue: string; invoices: Array<{ id: string; number: string; dueDate: string; balance: string; daysOverdue: number }> };
  recent: Array<{ id: string; type: string; number: string; issueDate: string; total: string; status: DocStatus }>;
  topItems: Array<{ name: string; quantity: string; total: string }>;
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function CustomerDetail() {
  const t = useT();
  const { id } = useParams();
  const { can, me } = useSession();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [statement, setStatement] = useState(false);
  const [accountLink, setAccountLink] = useState(false);
  const [loyalty, setLoyalty] = useState<{ enabled: boolean; balance: number; value: string; entries: Array<{ id: string; points: number; reason: string; note: string | null; at: string; number: string | null; documentId: string | null }> } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const loadLoyalty = () => api<NonNullable<typeof loyalty>>(`/v1/customers/${id}/loyalty`).then(setLoyalty).catch(() => {});
  useEffect(() => {
    void loadLoyalty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  usePageTitle(s?.customer.name ?? t('Customer'));
  useEffect(() => {
    void api<Summary>(`/v1/customers/${id}/summary`).then(setS).catch(setError);
  }, [id]);

  if (error) return <div className="stack"><Link to="/customers" viewTransition>← {t('Customers')}</Link><div className="banner bad"><ErrorText error={error} /></div></div>;
  if (!s) return <div className="stack"><div className="skeleton" style={{ height: '4rem' }} /><div className="skeleton" style={{ height: '10rem' }} /></div>;
  const c = s.customer;
  const overLimit = Boolean(c.creditLimit) && toCents(s.owed.total) > toCents(c.creditLimit!);
  const district = c.address ? DISTRICTS.find(([code]) => code === c.address!.districtCode)?.[1] : null;

  return (
    <div className="stack">
      <Link to="/customers" className="back-link" viewTransition>← {t('Customers')}</Link>
      <div className="row customer-head">
        <div>
          <span className="kicker">{t('Customer')}</span>
          <h1>{c.name}{c.priceList === 'wholesale' && <span className="badge price-list">{t('Wholesale')}</span>}</h1>
          <p className="muted small">
            {[c.tin && `TIN ${c.tin}`, c.address && `${c.address.street}, ${c.address.city}${district ? `, ${district}` : ''}`, c.contact.telephone, c.contact.email].filter(Boolean).join(' · ') || t('No details yet.')}
          </p>
        </div>
        <span className="spacer" />
        <div className="row">
          {can('documents.issue') && me?.sells !== 'products' && <Link className="button secondary" to={`/work?customer=${c.id}`} viewTransition>{t('Log work')}</Link>}
          {can('documents.issue') && <Link className="button" to={`/documents/new?type=01&customer=${c.id}`} viewTransition>{t('New invoice')}</Link>}
          {can('payments.record') && <button type="button" className="secondary" onClick={() => setStatement(true)}>{t('Statement')}</button>}
          <Link className="button secondary" to={`/documents?customerId=${c.id}`} viewTransition>{t('All documents')}</Link>
          {(can('payments.record') || can('catalog.manage')) && <button type="button" className="secondary" onClick={() => setAccountLink(true)}>{t('Account link')}</button>}
        </div>
      </div>

      <div className="kpis">
        <div className="kpi card"><span className="kpi-head">{t('Bought this year')}</span><span className="kpi-value num">{money(s.sales.thisYear)}</span></div>
        <div className="kpi card"><span className="kpi-head">{t('Bought in all')}</span><span className="kpi-value num">{money(s.sales.lifetime)}</span><span className="small muted">{s.sales.documents === 1 ? t('1 document') : t('{n} documents', { n: s.sales.documents })}{s.sales.firstSale ? ` · ${t('since {date}', { date: longDate(s.sales.firstSale) })}` : ''}</span></div>
        <div className={`kpi card ${s.owed.overdue !== '0.00' || overLimit ? 'alert' : ''}`}>
          <span className="kpi-head">{t('Owes')}</span><span className="kpi-value num">{money(s.owed.total)}</span>
          {s.owed.overdue !== '0.00' && <span className="small overdue-text">{t('{amount} overdue', { amount: money(s.owed.overdue) })}</span>}
          {c.creditLimit && <span className={`small ${overLimit ? 'overdue-text' : 'muted'}`}>{overLimit ? t('Over their limit of {limit}', { limit: money(c.creditLimit) }) : t('{amount} left of a {limit} limit', { amount: money(fromCents(toCents(c.creditLimit) - toCents(s.owed.total))), limit: money(c.creditLimit) })}</span>}
        </div>
        <div className="kpi card"><span className="kpi-head">{t('Last purchase')}</span><span className="kpi-value">{s.sales.lastSale ? longDate(s.sales.lastSale) : '—'}</span></div>
      </div>

      <div className="grid two">
        <section className="card">
          <h2>{t('Recent documents')}</h2>
          {s.recent.length === 0 ? <div className="empty">{t('Nothing issued to this customer yet.')}</div> : (
            <div className="table-wrap">
              <table className="responsive">
                <thead><tr><th scope="col">{t('Document')}</th><th scope="col">{t('Date')}</th><th scope="col">{t('Status')}</th><th scope="col" className="right">{t('Total')}</th></tr></thead>
                <tbody>
                  {s.recent.map((d) => (
                    <tr key={d.id}>
                      <td data-label={t('Document')}><Link to={`/documents/${d.id}`} viewTransition>{t(TYPE_NAMES[d.type] ?? d.type)} {d.number}</Link></td>
                      <td data-label={t('Date')}>{longDate(d.issueDate)}</td>
                      <td data-label={t('Status')}><StatusBadge status={d.status} /></td>
                      <td data-label={t('Total')} className="right num">{d.type === '04' ? '−' : ''}{money(d.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="stack">
          <section className="card">
            <h2>{t('Open invoices')}</h2>
            {s.owed.invoices.length === 0 ? <div className="empty">{t('Nothing owed. All paid up.')}</div> : (
              <ul className="customer-open">
                {s.owed.invoices.map((i) => (
                  <li key={i.id}>
                    <Link to={`/documents/${i.id}`} viewTransition>{i.number}</Link>
                    <span className={i.daysOverdue > 0 ? 'overdue-text small' : 'muted small'}>{i.daysOverdue > 0 ? t('{n} days overdue', { n: i.daysOverdue }) : t('due {date}', { date: longDate(i.dueDate) })}</span>
                    <span className="spacer" />
                    <strong className="num">{money(i.balance)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>{t('What they buy most')}</h2>
            {s.topItems.length === 0 ? <div className="empty">{t('No purchases yet.')}</div> : (
              <ul className="customer-open">
                {s.topItems.map((i) => (
                  <li key={i.name}><span>{i.name}</span><span className="muted small">× {i.quantity}</span><span className="spacer" /><span className="num">{money(i.total)}</span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {statement && <StatementModal customerKey={s.key} onClose={() => setStatement(false)} />}
      {loyalty && (loyalty.enabled || loyalty.entries.length > 0) && (
        <section className="card stack">
          <div className="row">
            <h2>{t('Loyalty points')}</h2>
            <span className="spacer" />
            <strong className="num">{t('{n} points', { n: loyalty.balance })}</strong>
            <span className="muted small">({money(loyalty.value)})</span>
            {can('catalog.manage') && <button type="button" className="secondary" onClick={() => setAdjusting(true)}>{t('Give or take points')}</button>}
          </div>
          {loyalty.entries.length === 0 ? <p className="small muted">{t('No points yet. They earn points on what they buy.')}</p> : (
            <ul className="customer-open">
              {loyalty.entries.slice(0, 12).map((e) => (
                <li key={e.id}>
                  <span className="small muted">{e.at.slice(0, 10)}</span>
                  <span>{t(POINT_REASON[e.reason] ?? e.reason)}{e.number && e.documentId ? <> · <Link to={`/documents/${e.documentId}`} viewTransition>{e.number}</Link></> : ''}{e.note ? ` · ${e.note}` : ''}</span>
                  <span className="spacer" />
                  <strong className={`num ${e.points < 0 ? 'overdue-text' : ''}`}>{e.points > 0 ? `+${e.points}` : e.points}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {adjusting && <AdjustPoints customerId={c.id} onClose={() => setAdjusting(false)} onDone={() => { setAdjusting(false); void loadLoyalty(); }} />}
      {accountLink && <AccountLinkModal customer={c} onClose={() => setAccountLink(false)} />}
    </div>
  );
}

/** A private link to the customer's account page: copy it, or email it to them; or stop the old ones. */
function AccountLinkModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [to, setTo] = useState(customer.contact.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Account link for {name}', { name: customer.name })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{t('A private page where they see what they owe, pay online, and download their invoices and statement. It works for a year.')}</p>
        {url ? (
          <div className="row nowrap">
            <input readOnly value={url} aria-label={t('Account link')} onFocus={(e) => e.target.select()} />
            <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => toast(t('Link copied')))}>{t('Copy')}</button>
          </div>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => setUrl((await api<{ url: string }>(`/v1/customers/${customer.id}/account-link`, { method: 'POST' })).url))}>{t('Make a link to copy')}</button>
        )}
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ to: string }>(`/v1/customers/${customer.id}/account-link/send`, { method: 'POST', body: { to: to.trim() } }); toast(t('Sent to {email}', { email: r.to })); onClose(); }); }}>
          <input type="email" required placeholder={t('Their email')} value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('Their email')} />
          <button type="submit" disabled={busy || !to.trim()}>{t('Email it')}</button>
        </form>
        <ErrorText error={error} />
        <div className="row">
          <button type="button" className="link danger-link" disabled={busy} onClick={() => void run(async () => { const r = await api<{ revoked: number }>(`/v1/customers/${customer.id}/account-links`, { method: 'DELETE' }); setUrl(null); toast(t('{n} links stopped', { n: r.revoked })); })}>{t('Stop all their links')}</button>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Close')}</button>
        </div>
      </div>
    </Modal>
  );
}

const POINT_REASON: Record<string, string> = { earned: 'Earned', redeemed: 'Used', reversed: 'Undone (document cancelled)', adjusted: 'By hand' };

function AdjustPoints({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title={t('Give or take points')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api(`/v1/customers/${customerId}/loyalty/adjust`, { method: 'POST', body: { points: Number(points), note: note.trim() } }).then(onDone).catch((err) => { setError(err); setBusy(false); });
      }}>
        <div className="form-grid">
          <Field label={t('Points')} hint={t('Negative takes points away.')}><input required inputMode="numeric" pattern="-?\d{1,7}" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="50" /></Field>
          <Field label={t('Why')}><input required maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Welcome bonus')} /></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{t('Save')}</button></div>
      </form>
    </Modal>
  );
}

export default CustomerDetail;
