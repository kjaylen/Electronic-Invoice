/** Settings → Developers → Webhooks: endpoints, their deliveries (each one in full), tests of any event, rotate, switch on or off. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal } from '../ui';

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: string;
  lastDeliveryAt: string | null;
}

interface Delivery {
  id: string;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

interface DeliveryDetail extends Delivery {
  responseBody: string | null;
  body: unknown;
}

interface EventSample {
  type: string;
  sample: unknown;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** One delivery in full: what was sent, and what the endpoint answered. */
function DeliveryView({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const [d, setD] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void api<DeliveryDetail>(`/v1/webhooks/deliveries/${id}`).then(setD).catch(setError);
  }, [id]);
  return (
    <Modal title={d ? d.type : t('Delivery')} onClose={onClose} wide>
      <ErrorText error={error} />
      {!d ? !error && <div className="skeleton" style={{ height: '12rem' }} /> : (
        <div className="stack">
          <dl className="guide-spec">
            <div><dt>{t('Result')}</dt><dd>{d.status === 'delivered' ? t('Delivered') : d.status === 'failed' ? t('Failed') : t('Retrying')}{d.responseStatus !== null && ` · ${d.responseStatus}`}{d.error && d.status !== 'delivered' && ` · ${d.error}`}</dd></div>
            <div><dt>{t('Attempts')}</dt><dd>{d.attempts}</dd></div>
            <div><dt>{t('Made')}</dt><dd>{when(d.createdAt)}</dd></div>
            {d.deliveredAt && <div><dt>{t('Delivered')}</dt><dd>{when(d.deliveredAt)}</dd></div>}
            {d.nextAttemptAt && <div><dt>{t('Next try')}</dt><dd>{when(d.nextAttemptAt)}</dd></div>}
          </dl>
          <div className="stack" style={{ gap: '0.35rem' }}>
            <strong className="small">{t('What was sent')}</strong>
            <pre className="guide-code" tabIndex={0}>{JSON.stringify(d.body, null, 2)}</pre>
          </div>
          <div className="stack" style={{ gap: '0.35rem' }}>
            <strong className="small">{t('What your endpoint answered')}</strong>
            <pre className="guide-code" tabIndex={0}>{d.responseBody || (d.responseStatus === null ? t('No answer.') : t('An empty answer.'))}</pre>
          </div>
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Done')}</button></div>
        </div>
      )}
    </Modal>
  );
}

/** Send a test: a ping, or the sample of any event, shown before it is sent. */
function TestDialog({ endpoint, onClose, onSent }: { endpoint: Endpoint; onClose: () => void; onSent: () => void }) {
  const t = useT();
  const [events, setEvents] = useState<EventSample[]>([]);
  const [event, setEvent] = useState('ping');
  const [result, setResult] = useState<{ ok: boolean; status: number | null; error: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ data: EventSample[] }>('/v1/webhooks/events').then((r) => setEvents(r.data)).catch(setError);
  }, []);
  const sample = events.find((e) => e.type === event)?.sample;
  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api(`/v1/webhooks/${endpoint.id}/test`, { method: 'POST', body: event === 'ping' ? {} : { event } }));
      onSent();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Send a test')} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('Sent now to {url}, signed like a real delivery. A test of an event carries its sample and "test": true, so your code can tell it from the real thing.', { url: endpoint.url })}</p>
        <Field label={t('What to send')}>
          <select value={event} onChange={(e) => { setEvent(e.target.value); setResult(null); }}>
            <option value="ping">ping</option>
            {events.map((e) => <option key={e.type} value={e.type}>{e.type}</option>)}
          </select>
        </Field>
        {sample !== undefined && <pre className="guide-code" tabIndex={0}>{JSON.stringify({ ...(sample as object), test: true }, null, 2)}</pre>}
        <ErrorText error={error} />
        {result && <div className={`banner ${result.ok ? 'info' : 'warn'}`} role="status"><div><strong>{result.ok ? t('Your endpoint answered {status}', { status: result.status ?? 'OK' }) : t('It did not work: {error}', { error: result.error ?? String(result.status) })}</strong></div></div>}
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Done')}</button><button type="button" disabled={busy} onClick={() => void send()}>{busy ? t('Sending…') : t('Send')}</button></div>
      </div>
    </Modal>
  );
}

function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="banner warn">
      <div style={{ width: '100%' }}>
        <strong>{t('Copy this signing secret now. It will not be shown again.')}</strong>
        <div className="key-reveal mono">{secret}</div>
        <p className="small">{t('Use it to check the X-Floreo-Signature header of each delivery (see the API reference).')}</p>
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button className="secondary" onClick={() => void navigator.clipboard?.writeText(secret).then(() => toast(t('Secret copied')))}>{t('Copy')}</button>
          <button className="link" onClick={onDone}>{t("I've saved it")}</button>
        </div>
      </div>
    </div>
  );
}

function Deliveries({ endpoint }: { endpoint: Endpoint }) {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useCallback(() => api<{ data: Delivery[] }>(`/v1/webhooks/${endpoint.id}/deliveries`).then((r) => setRows(r.data)).catch(setError), [endpoint.id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!rows) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '4rem' }} />;
  if (!rows.length) return <p className="small muted">{t('No deliveries yet.')}</p>;
  return (
    <div className="table-wrap">
      <table className="responsive deliveries">
        <thead><tr><th scope="col">{t('Event')}</th><th scope="col">{t('When')}</th><th scope="col">{t('Result')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td data-label={t('Event')} className="mono small">{d.type}</td>
              <td data-label={t('When')} className="small">{when(d.createdAt)}</td>
              <td data-label={t('Result')} className="small">
                {d.status === 'delivered' ? <span className="badge authorized">{d.responseStatus ?? 'OK'}</span>
                  : d.status === 'failed' ? <span className="badge rejected">{t('Failed')}</span>
                    : <span className="badge pending">{t('Retrying')}</span>}
                {d.error && d.status !== 'delivered' && <div className="muted">{d.error}{d.nextAttemptAt && ` · ${t('next try {when}', { when: when(d.nextAttemptAt) })}`}</div>}
                {d.attempts > 1 && <div className="muted">{t('{n} attempts', { n: d.attempts })}</div>}
              </td>
              <td className="right">
                <span className="row small dev-actions">
                  <button className="link" onClick={() => setViewing(d.id)}>{t('View')}</button>
                  {d.status === 'failed' && d.type !== 'ping' && <button className="link" onClick={() => void api(`/v1/webhooks/deliveries/${d.id}/retry`, { method: 'POST' }).then(() => { toast(t('Sending again shortly')); void load(); }).catch(setError)}>{t('Send again')}</button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText error={error} />
      {viewing && <DeliveryView id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

export function WebhooksPanel() {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState<{ data: Endpoint[]; events: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState<Endpoint | null>(null);
  const [form, setForm] = useState<{ url: string; description: string; all: boolean; events: string[] }>({ url: '', description: '', all: true, events: [] });
  const load = useCallback(() => api<{ data: Endpoint[]; events: string[] }>('/v1/webhooks').then(setData).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError(null);
    try {
      await fn();
      if (message) toast(message);
      await load();
    } catch (e) {
      setError(e);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    await act(async () => {
      const r = await api<Endpoint & { secret: string }>('/v1/webhooks', { method: 'POST', body: { url: form.url.trim(), events: form.all ? ['*'] : form.events, ...(form.description.trim() && { description: form.description.trim() }) } });
      setSecret(r.secret);
      setAdding(false);
      setForm({ url: '', description: '', all: true, events: [] });
    });
  };
  if (!data) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '8rem' }} />;
  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Webhooks')}</h2>
          <p className="muted small">{t('Your systems are told as soon as something happens (an order placed or paid, a payment that failed, a product or its stock changing, a document authorized), with a signed HTTPS request. An endpoint must be on the internet over https: while you build, point it at a tunnel to your computer.')}</p>
        </div>
        <span className="spacer" />
        <button onClick={() => setAdding(true)}>{t('Add endpoint')}</button>
      </div>
      {secret && <SecretReveal secret={secret} onDone={() => setSecret(null)} />}
      <ErrorText error={error} />
      {data.data.length === 0 ? <div className="empty">{t('No endpoints yet.')}</div> : (
        <ul className="endpoints">
          {data.data.map((ep) => (
            <li key={ep.id} className={ep.enabled ? '' : 'off'}>
              <div className="row">
                <div style={{ minWidth: 0 }}>
                  <div className="mono endpoint-url">{ep.url}</div>
                  <div className="small muted">
                    {ep.description && `${ep.description} · `}
                    {ep.events.includes('*') ? t('All events') : ep.events.join(', ')}
                    {ep.lastDeliveryAt && ` · ${t('last delivered {when}', { when: when(ep.lastDeliveryAt) })}`}
                  </div>
                  {ep.disabledReason && <div className="small" style={{ color: 'var(--coral-ink)' }}>{ep.disabledReason}</div>}
                  {ep.enabled && ep.consecutiveFailures > 0 && <div className="small" style={{ color: 'var(--ochre)' }}>{t('{n} failed deliveries in a row', { n: ep.consecutiveFailures })}</div>}
                </div>
                <span className="spacer" />
                <span className={`badge ${ep.enabled ? 'authorized' : 'cancelled'}`}>{ep.enabled ? t('On') : t('Off')}</span>
              </div>
              <div className="row small endpoint-actions">
                <button className="link" onClick={() => setOpen(open === ep.id ? null : ep.id)}>{open === ep.id ? t('Hide deliveries') : t('Deliveries')}</button>
                {ep.enabled && <button className="link" onClick={() => setTesting(ep)}>{t('Send a test')}</button>}
                <button className="link" onClick={() => void act(() => api(`/v1/webhooks/${ep.id}`, { method: 'PATCH', body: { enabled: !ep.enabled } }), ep.enabled ? t('Endpoint switched off') : t('Endpoint switched on'))}>{ep.enabled ? t('Switch off') : t('Switch on')}</button>
                <button className="link" onClick={() => void act(async () => setSecret((await api<{ secret: string }>(`/v1/webhooks/${ep.id}/rotate-secret`, { method: 'POST' })).secret))}>{t('New secret')}</button>
                <button className="link danger-link" onClick={() => void act(() => api(`/v1/webhooks/${ep.id}`, { method: 'DELETE' }), t('Endpoint removed'))}>{t('Remove')}</button>
              </div>
              {open === ep.id && <Deliveries endpoint={ep} />}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted"><a href="/docs#webhooks" target="_blank" rel="noreferrer">{t('How to check signatures and handle retries')} ↗</a></p>
      {testing && <TestDialog endpoint={testing} onClose={() => setTesting(null)} onSent={() => void load()} />}

      {adding && (
        <Modal title={t('Add a webhook endpoint')} onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={(e) => void create(e)}>
            <Field label={t('URL')} hint={t('Must start with https:// and be reachable on the internet.')}><input type="url" required autoFocus placeholder="https://erp.example.bz/floreo" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
            <Field label={t('Description')}><input value={form.description} maxLength={200} placeholder={t('For example: our ERP')} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <fieldset className="plain stack">
              <legend>{t('Events')}</legend>
              <label className="row small"><input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} /> {t('All events, including ones added later')}</label>
              {!form.all && (
                <div className="event-grid">
                  {data.events.map((ev) => (
                    <label key={ev} className="row small mono">
                      <input type="checkbox" checked={form.events.includes(ev)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} /> {ev}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <ErrorText error={error} />
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setAdding(false)}>{t('Cancel')}</button><button type="submit" disabled={!form.all && form.events.length === 0}>{t('Add endpoint')}</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}
