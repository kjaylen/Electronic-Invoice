import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type DocumentInfo, type Page } from '../api';
import { useSession } from '../session';
import { Crystals } from '../art';
import { belizeToday, fromCents, money, StatusBadge, toCents } from '../ui';

export function DocumentTable({ docs }: { docs: DocumentInfo[] }) {
  const navigate = useNavigate();
  if (docs.length === 0) return <div className="empty">Nothing here yet. Your documents will appear as you issue them.</div>;
  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr><th>Date</th><th>Document</th><th>Customer</th><th className="right">Total</th><th>Status</th></tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`, { viewTransition: true })}>
              <td data-label="Date">{d.issueDate}</td>
              <td data-label="Document"><Link to={`/documents/${d.id}`} viewTransition onClick={(e) => e.stopPropagation()}>{d.typeName}</Link> <span className="mono muted">{d.series}-{d.number}</span></td>
              <td data-label="Customer">{d.customer?.name ?? (d.customer?.tin ? `TIN ${d.customer.tin}` : 'Walk-in')}</td>
              <td data-label="Total" className="right">{money(d.totals.payable)}</td>
              <td data-label="Status"><StatusBadge status={d.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Dashboard() {
  const { me } = useSession();
  const [recent, setRecent] = useState<DocumentInfo[] | null>(null);
  const [attention, setAttention] = useState<DocumentInfo[]>([]);
  useEffect(() => {
    void api<Page<DocumentInfo>>('/v1/documents?limit=10').then((r) => setRecent(r.data));
    void Promise.all([
      api<Page<DocumentInfo>>('/v1/documents?status=rejected&limit=5'),
      api<Page<DocumentInfo>>('/v1/documents?status=pending&limit=5'),
    ]).then(([a, b]) => setAttention([...a.data, ...b.data]));
  }, []);
  if (!me) return null;

  const today = belizeToday();
  const todays = (recent ?? []).filter((d) => d.issueDate === today && (d.status === 'authorized' || d.status === 'authorized_with_alert' || d.status === 'contingency_pending'));
  const todayTotal = todays.reduce((sum, d) => sum + toCents(d.totals.payable), 0n);
  const hour = new Date(Date.now() - 6 * 3_600_000).getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="stack">
      <section className="hero">
        <Crystals count={3} />
        <span className="kicker">Overview · TIN {me.tin}</span>
        <h1>{me.tradeName ?? me.legalName}</h1>
        <p className="muted">{greeting}. {todays.length ? `${todays.length} document${todays.length === 1 ? '' : 's'} issued today.` : 'Ready when you are.'}</p>
        <div className="row" style={{ marginTop: '1rem' }}>
          <Link className="button big lime" to="/documents/new?type=01" viewTransition>New invoice<span className="chip">→</span></Link>
          <Link className="button secondary on-dark" to="/documents/new?type=02" viewTransition>New receipt</Link>
        </div>
      </section>

      {me.environment === 'test' && (
        <div className="banner info"><div><strong>Test environment</strong>Documents go to the BTS test system and have no fiscal value.</div></div>
      )}
      {!me.certificate && (
        <div className="banner bad"><div><strong>Install your BTS certificate to start issuing.</strong><Link to="/settings">Go to settings</Link></div></div>
      )}
      {me.certificate && me.certificate.daysLeft < 30 && (
        <div className="banner warn"><div><strong>Your BTS certificate expires in {me.certificate.daysLeft} days.</strong>Renew it in the BTS portal, then install it in <Link to="/settings">settings</Link>.</div></div>
      )}
      {me.contingency.active && (
        <div className="banner warn">
          <div>
            <strong>BTS cannot be reached right now.</strong>
            You can keep issuing: documents are marked "Pending of BTS authorization" and sent automatically when BTS is back.
            {me.contingency.queued > 0 && <> {me.contingency.queued} waiting.</>}
          </div>
        </div>
      )}

      <div className="grid">
        <div className="card stat"><div className="label">Issued today</div><div className="value num">{todays.length}</div></div>
        <div className="card stat"><div className="label">Total today</div><div className="value num">{money(fromCents(todayTotal))}</div></div>
        <div className="card stat"><div className="label">Need attention</div><div className="value num">{attention.length}</div></div>
      </div>

      {attention.length > 0 && (
        <section className="card">
          <h2>Need attention</h2>
          <DocumentTable docs={attention} />
        </section>
      )}
      <section className="card">
        <div className="row"><h2>Recent documents</h2><span className="spacer" /><Link to="/documents" viewTransition>See all →</Link></div>
        {recent === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <DocumentTable docs={recent} />}
      </section>
    </div>
  );
}
