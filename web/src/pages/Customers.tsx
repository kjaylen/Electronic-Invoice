import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link, type Customer, type Page } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { DISTRICTS, ErrorText, Field, Modal, Select, useDebounced, usePageTitle, Pager, usePages } from '../ui';
import { ImportDialog } from './ImportDialog';

type Form = { name: string; tin: string; street: string; city: string; districtCode: string; telephone: string; email: string; priceList: 'retail' | 'wholesale'; creditLimit: string; withholdsContractTax: boolean };
const EMPTY: Form = { name: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '', priceList: 'retail', creditLimit: '', withholdsContractTax: false };

const toForm = (c: Customer): Form => ({
  name: c.name,
  tin: c.tin ?? '',
  street: c.address?.street ?? '',
  city: c.address?.city ?? '',
  districtCode: c.address?.districtCode ?? '1',
  telephone: c.contact.telephone ?? '',
  email: c.contact.email ?? '',
  priceList: c.priceList ?? 'retail',
  creditLimit: c.creditLimit ?? '',
  withholdsContractTax: Boolean(c.withholdsContractTax),
});

export const customerBody = (f: Form) => ({
  name: f.name.trim(),
  ...(f.tin && { tin: f.tin }),
  ...(f.street && f.city && { address: { street: f.street, city: f.city, districtCode: f.districtCode } }),
  ...((f.telephone || f.email) && { contact: { ...(f.telephone && { telephone: f.telephone }), ...(f.email && { email: f.email }) } }),
  priceList: f.priceList,
  creditLimit: f.creditLimit.trim() || null,
  withholdsContractTax: f.withholdsContractTax,
});

/** Add or edit a customer. */
function CustomerForm(props: { initial?: Customer; onSaved: (c: Customer) => void; onCancel: () => void }) {
  const t = useT();
  const [form, setForm] = useState<Form>(props.initial ? toForm(props.initial) : EMPTY);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = props.initial
        ? await api<Customer>(`/v1/customers/${props.initial.id}`, { method: 'PUT', body: customerBody(form) })
        : await api<Customer>('/v1/customers', { method: 'POST', body: customerBody(form) });
      props.onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label={t('Name')}><input required autoFocus value={form.name} onChange={set('name')} /></Field>
        <Field label="TIN" hint={t('If GST-registered.')}><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={form.tin} onChange={set('tin')} /></Field>
      </div>
      <div className="form-grid">
        <Field label={t('Street')}><input value={form.street} onChange={set('street')} /></Field>
        <Field label={t('City or town')}><input value={form.city} onChange={set('city')} /></Field>
        <Field label={t('District')}><Select value={form.districtCode} onChange={set('districtCode')}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
      </div>
      <div className="form-grid">
        <Field label={t('Telephone')} hint={t('Used to send documents by WhatsApp.')}><input type="tel" value={form.telephone} onChange={set('telephone')} /></Field>
        <Field label={t('Email')}><input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label={t('Prices')} hint={t('Wholesale customers pay items\' wholesale prices.')}>
          <Select value={form.priceList} onChange={(e) => setForm({ ...form, priceList: e.target.value as Form['priceList'] })}>
            <option value="retail">{t('Retail')}</option>
            <option value="wholesale">{t('Wholesale')}</option>
          </Select>
        </Field>
        <Field label={t('Credit limit (BZ$)')} hint={t('The most they may owe on invoices. Empty: no limit.')}>
          <input inputMode="decimal" pattern="\d{1,10}(\.\d{1,2})?" placeholder={t('No limit')} value={form.creditLimit} onChange={set('creditLimit')} />
        </Field>
      </div>
      <label className="row small">
        <input type="checkbox" checked={form.withholdsContractTax} onChange={(e) => setForm({ ...form, withholdsContractTax: e.target.checked })} />
        <span>{t('Withholds contract tax (6% of the amount before GST)')} <span className="muted">· {t('Government, statutory bodies and companies that deduct it when they pay you. Their invoices say so, and the balance is what they pay.')}</span></span>
      </label>
      {props.initial && <p className="small muted">{t('Documents already issued keep the details they were issued with.')}</p>}
      <ErrorText error={error} />
      <div className="row">
        <span className="spacer" />
        <button type="button" className="secondary" onClick={props.onCancel}>{t('Cancel')}</button>
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save customer')}</button>
      </div>
    </form>
  );
}

export function Customers() {
  const t = useT();
  usePageTitle(t('Customers'));
  const toast = useToast();
  const { can } = useSession();
  const manage = can('catalog.manage');
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);

  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState<Customer | null>(null);
  const [error, setError] = useState<unknown>(null);

  // One page at a time; a new search starts again at the first.
  const pages = usePages<Customer>(async (cursor) => {
    const r = await api<Page<Customer>>(`/v1/customers?limit=25${query ? `&q=${encodeURIComponent(query)}` : ''}${cursor ? `&cursor=${cursor}` : ''}`);
    return { data: r.data, next: r.nextCursor };
  }, query);
  const list = pages.rows;
  const load = pages.reload;

  const archive = async () => {
    if (!archiving) return;
    try {
      await api(`/v1/customers/${archiving.id}`, { method: 'DELETE' });
      toast(t('{name} archived', { name: archiving.name }));
      setArchiving(null);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Directory')}</span><h1>{t('Customers')}</h1></div>
        <span className="spacer" />
        {manage && <a className="button secondary" href={link('/v1/customers/export.csv')} download>{t('Export')}</a>}
        {manage && <button type="button" className="secondary" onClick={() => setImporting(true)}>{t('Import')}</button>}
        {manage && <button onClick={() => setEditing('new')}>{t('Add customer')}</button>}
      </div>
      <input type="search" placeholder={t('Search by name, TIN, phone or email')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search customers')} />
      <ErrorText error={error ?? pages.error} />
      <section className="card">
        {list === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : list.length === 0 ? <div className="empty">{query ? t('No customers match your search.') : t('No customers yet. Add the ones you invoice often.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Name')}</th><th scope="col">TIN</th><th scope="col">{t('Address')}</th><th scope="col">{t('Contact')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td data-label={t('Name')}><Link to={`/customers/${c.id}`} className="strong-link" viewTransition>{c.name}</Link>{c.priceList === 'wholesale' && <span className="badge price-list">{t('Wholesale')}</span>}</td>
                    <td data-label="TIN">{c.tin ?? '—'}</td>
                    <td data-label={t('Address')}>{c.address ? `${c.address.street}, ${c.address.city}` : '—'}</td>
                    <td data-label={t('Contact')}>{[c.contact.telephone, c.contact.email].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="right actions">
                      <Link to={`/documents?customerId=${c.id}`} viewTransition>{t('Documents')}</Link>
                      {manage && <button className="link" onClick={() => setEditing(c)}>{t('Edit')}</button>}
                      {manage && <button className="link" onClick={() => setArchiving(c)}>{t('Archive')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager pages={pages} />
      </section>

      {importing && <ImportDialog kind="customers" onClose={() => setImporting(false)} onDone={() => void load()} />}
      {editing && (
        <Modal wide title={editing === 'new' ? t('Add customer') : t('Edit {name}', { name: editing.name })} onClose={() => setEditing(null)}>
          <CustomerForm
            {...(editing !== 'new' && { initial: editing })}
            onCancel={() => setEditing(null)}
            onSaved={(c) => {
              toast(editing === 'new' ? t('{name} added', { name: c.name }) : t('{name} saved', { name: c.name }));
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      )}
      {archiving && (
        <Modal title={t('Archive {name}?', { name: archiving.name })} onClose={() => setArchiving(null)}>
          <p>{t('They disappear from your customer list and search. Documents already issued to them are not affected.')}</p>
          <div className="row">
            <span className="spacer" />
            <button className="secondary" onClick={() => setArchiving(null)}>{t('Keep')}</button>
            <button className="danger" onClick={() => void archive()}>{t('Archive')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
