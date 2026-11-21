import { type FormEvent, useEffect, useState } from 'react';
import { api, type Item, type Page } from '../api';
import { ErrorText, Field, GST_CATEGORIES, money, UNITS } from '../ui';

export function Items() {
  const [list, setList] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', sellerCode: '', unitCode: 'H87', unitPrice: '', gstCategory: 'S', exemptionReasonCode: '' });
  const [error, setError] = useState<unknown>(null);

  const load = async (after?: string) => {
    const r = await api<Page<Item>>(`/v1/items?limit=50${after ? `&cursor=${after}` : ''}`);
    setList(after ? [...list, ...r.data] : r.data);
    setCursor(r.nextCursor);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/v1/items', {
        method: 'POST',
        body: {
          name: form.name,
          ...(form.description && { description: form.description }),
          ...(form.sellerCode && { sellerCode: form.sellerCode }),
          unitCode: form.unitCode,
          unitPrice: form.unitPrice,
          gstCategory: form.gstCategory,
          ...(form.gstCategory === 'E' && { exemptionReasonCode: form.exemptionReasonCode }),
        },
      });
      setForm({ name: '', description: '', sellerCode: '', unitCode: 'H87', unitPrice: '', gstCategory: 'S', exemptionReasonCode: '' });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  const unitName = (code: string) => UNITS.find(([c]) => c === code)?.[1] ?? code;
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">Catalog</span><h1>Items</h1></div>
        <span className="spacer" />
        <button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add item'}</button>
      </div>
      <p className="muted">Products and services you sell often. Pick them when issuing to fill in the price, unit and GST.</p>
      {adding && (
        <form className="card stack" onSubmit={submit}>
          <div className="form-grid">
            <Field label="Name"><input required value={form.name} onChange={set('name')} /></Field>
            <Field label="Description" hint="Printed on documents. Defaults to the name."><input value={form.description} onChange={set('description')} /></Field>
            <Field label="Your code" hint="SKU, optional."><input value={form.sellerCode} onChange={set('sellerCode')} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Unit"><select value={form.unitCode} onChange={set('unitCode')}>{UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
            <Field label="Price (BZ$, before GST)"><input required inputMode="decimal" pattern="\d+(\.\d{1,6})?" value={form.unitPrice} onChange={set('unitPrice')} /></Field>
            <Field label="GST"><select value={form.gstCategory} onChange={set('gstCategory')}>{GST_CATEGORIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
            {form.gstCategory === 'E' && <Field label="Exemption reason code"><input required value={form.exemptionReasonCode} onChange={set('exemptionReasonCode')} /></Field>}
          </div>
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="submit">Save item</button></div>
        </form>
      )}
      <section className="card">
        {list.length === 0 ? <p className="muted">No items yet.</p> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th>Item</th><th>Code</th><th>Unit</th><th className="right">Price</th><th>GST</th></tr></thead>
              <tbody>
                {list.map((it) => (
                  <tr key={it.id}>
                    <td data-label="Item"><strong>{it.name}</strong>{it.description !== it.name && <div className="small muted">{it.description}</div>}</td>
                    <td data-label="Code">{it.sellerCode ?? '—'}</td>
                    <td data-label="Unit">{unitName(it.unitCode)}</td>
                    <td data-label="Price" className="right">{money(it.unitPrice)}</td>
                    <td data-label="GST">{GST_CATEGORIES.find(([c]) => c === it.gstCategory)?.[1]}</td>
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
