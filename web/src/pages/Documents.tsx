import { useEffect, useState } from 'react';
import { api, type DocumentInfo, type Page } from '../api';
import { DocumentTable } from './Dashboard';

const FILTERS: Array<[string, string]> = [
  ['', 'All'],
  ['authorized', 'Authorized'],
  ['contingency_pending', 'Pending (outage)'],
  ['rejected', 'Rejected'],
  ['cancelled', 'Cancelled'],
];

export function Documents() {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const query = (after?: string) =>
    `/v1/documents?limit=25${status ? `&status=${status}` : ''}${type ? `&type=${type}` : ''}${after ? `&cursor=${after}` : ''}`;

  useEffect(() => {
    setLoading(true);
    void api<Page<DocumentInfo>>(query()).then((r) => {
      setDocs(r.data);
      setCursor(r.nextCursor);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, type]);

  const more = async () => {
    if (!cursor) return;
    const r = await api<Page<DocumentInfo>>(query(cursor));
    setDocs([...docs, ...r.data]);
    setCursor(r.nextCursor);
  };

  return (
    <div className="stack">
      <div><span className="kicker">Records</span><h1>Documents</h1></div>
      <div className="row">
        <div className="tabs" role="tablist">
          {FILTERS.map(([value, label]) => (
            <button key={value} role="tab" aria-selected={status === value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{label}</button>
          ))}
        </div>
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All types</option>
          <option value="01">Tax invoices</option>
          <option value="02">Tax receipts</option>
          <option value="03">Debit notes</option>
          <option value="04">Credit notes</option>
        </select>
      </div>
      <section className="card">
        {loading ? <p className="muted">Loading…</p> : <DocumentTable docs={docs} />}
        {cursor && <button className="secondary" onClick={() => void more()}>Load more</button>}
      </section>
    </div>
  );
}
