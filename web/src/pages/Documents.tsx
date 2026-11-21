import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Customer, type DocumentInfo, type Page } from '../api';
import { useT } from '../i18n';
import { belizeDate, belizeToday, Field, Segmented, useDebounced, usePageTitle } from '../ui';
import { DocumentTable, usePollWhile } from './Dashboard';

const PAGE = 25;

/** Records, with search and filters kept in the address bar so a filtered list can be bookmarked or shared. */
export function Documents() {
  const t = useT();
  usePageTitle(t('Documents'));
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const customerId = params.get('customerId') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = useDebounced(q, 300);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState<Customer | null>(null);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if ((params.get('q') ?? '') !== query) update('q', query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => {
    if (!customerId) return setCustomer(null);
    void api<Customer>(`/v1/customers/${customerId}`).then(setCustomer).catch(() => setCustomer(null));
  }, [customerId]);

  const url = useCallback((after?: string) => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (status) p.set('status', status);
    if (type) p.set('type', type);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (customerId) p.set('customerId', customerId);
    if (query.trim()) p.set('q', query.trim());
    if (after) p.set('cursor', after);
    return `/v1/documents?${p}`;
  }, [status, type, from, to, customerId, query]);

  const load = useCallback(() => {
    void api<Page<DocumentInfo>>(url()).then((r) => {
      setDocs(r.data);
      setCursor(r.nextCursor);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [url]);
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);
  usePollWhile(docs.some((d) => d.status === 'pending' || d.status === 'contingency_pending'), load, 10_000);

  const more = async () => {
    if (!cursor) return;
    const r = await api<Page<DocumentInfo>>(url(cursor));
    setDocs([...docs, ...r.data]);
    setCursor(r.nextCursor);
  };
  const filtered = Boolean(status || type || from || to || customerId || query);

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Records')}</span><h1>{t('Documents')}</h1></div>
        <span className="spacer" />
        <a className="button secondary" href={`/v1/reports/documents?from=${from || belizeDate(-365)}&to=${to || belizeToday()}`} download>{t('Download CSV')}</a>
      </div>
      <div className="card stack filters">
        <div className="form-grid">
          <Field label={t('Search')} className="grow">
            <input type="search" placeholder={t('Number, customer name or TIN')} value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label={t('From')}><input type="date" value={from} onChange={(e) => update('from', e.target.value)} /></Field>
          <Field label={t('To')}><input type="date" value={to} onChange={(e) => update('to', e.target.value)} /></Field>
          <Field label={t('Type')}>
            <select value={type} onChange={(e) => update('type', e.target.value)}>
              <option value="">{t('All types')}</option>
              <option value="01">{t('Tax invoices')}</option>
              <option value="02">{t('Tax receipts')}</option>
              <option value="03">{t('Debit notes')}</option>
              <option value="04">{t('Credit notes')}</option>
            </select>
          </Field>
        </div>
        <div className="row">
          <Segmented
            label={t('Status')}
            value={status}
            onChange={(v) => update('status', v)}
            options={[['', t('All')], ['authorized', t('Authorized')], ['contingency_pending', t('Pending (outage)')], ['rejected', t('Rejected')], ['cancelled', t('Cancelled')]]}
          />
          {customer && (
            <span className="chip-filter">{t('Customer')}: <strong>{customer.name}</strong> <button className="link" aria-label={t('Remove filter')} onClick={() => update('customerId', '')}>×</button></span>
          )}
          <span className="spacer" />
          {filtered && <button className="link" onClick={() => { setQ(''); setParams({}, { replace: true }); }}>{t('Clear filters')}</button>}
        </div>
      </div>
      <section className="card" aria-busy={loading}>
        {loading ? <div className="stack"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <DocumentTable docs={docs} {...(filtered && { empty: t('No documents match these filters.') })} />}
        {cursor && <button className="secondary" onClick={() => void more()}>{t('Load more')}</button>}
      </section>
    </div>
  );
}
