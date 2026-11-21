import { type FormEvent, useEffect, useState } from 'react';
import { api, type Customer, type Page } from '../api';
import { DISTRICTS, ErrorText, Field, useDebounced } from '../ui';

export function Customers() {
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [list, setList] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '' });
  const [error, setError] = useState<unknown>(null);

  const load = async (after?: string) => {
    const r = await api<Page<Customer>>(`/v1/customers?limit=25${query ? `&q=${encodeURIComponent(query)}` : ''}${after ? `&cursor=${after}` : ''}`);
    setList(after ? [...list, ...r.data] : r.data);
    setCursor(r.nextCursor);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/v1/customers', {
        method: 'POST',
        body: {
          name: form.name,
          ...(form.tin && { tin: form.tin }),
          ...(form.street && form.city && { address: { street: form.street, city: form.city, districtCode: form.districtCode } }),
          ...((form.telephone || form.email) && { contact: { ...(form.telephone && { telephone: form.telephone }), ...(form.email && { email: form.email }) } }),
        },
      });
      setForm({ name: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '' });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">Directory</span><h1>Customers</h1></div>
        <span className="spacer" />
        <button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add customer'}</button>
      </div>
      {adding && (
        <form className="card stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label="Name"><input required value={form.name} onChange={set('name')} /></Field>
            <Field label="TIN" hint="If GST-registered."><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={form.tin} onChange={set('tin')} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Street"><input value={form.street} onChange={set('street')} /></Field>
            <Field label="City or town"><input value={form.city} onChange={set('city')} /></Field>
            <Field label="District"><select value={form.districtCode} onChange={set('districtCode')}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          </div>
          <div className="form-grid">
            <Field label="Telephone"><input type="tel" value={form.telephone} onChange={set('telephone')} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
          </div>
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="submit">Save customer</button></div>
        </form>
      )}
      <input placeholder="Search by name or TIN" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      <section className="card">
        {list.length === 0 ? <p className="muted">No customers{query ? ' match your search' : ' yet'}.</p> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th>Name</th><th>TIN</th><th>Address</th><th>Contact</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Name"><strong>{c.name}</strong></td>
                    <td data-label="TIN">{c.tin ?? '—'}</td>
                    <td data-label="Address">{c.address ? `${c.address.street}, ${c.address.city}` : '—'}</td>
                    <td data-label="Contact">{[c.contact.telephone, c.contact.email].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && <button className="secondary" onClick={() => void load(cursor)}>Load more</button>}
      </section>
    </div>
  );
}
