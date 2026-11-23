/** Settings → Developers → Webhooks: endpoints, their deliveries, test, rotate, switch on or off. */

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

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

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
              <td className="right">{d.status === 'failed' && d.type !== 'ping' && <button className="link" onClick={() => void api(`/v1/webhooks/deliveries/${d.id}/retry`, { method: 'POST' }).then(() => { toast(t('Sending again shortly')); void load(); }).catch(setError)}>{t('Send again')}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText error={error} />
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
  const test = (ep: Endpoint) => act(async () => {
    const r = await api<{ ok: boolean; status: number | null; error: string | null }>(`/v1/webhooks/${ep.id}/test`, { method: 'POST' });
    toast(r.ok ? t('Your endpoint answered {status}', { status: r.status ?? 'OK' }) : t('It did not work: {error}', { error: r.error ?? String(r.status) }), r.ok ? 'ok' : 'info');
  });
  if (!data) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '8rem' }} />;
  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Webhooks')}</h2>
          <p className="muted small">{t('Your systems are told as soon as a document is authorized or rejected, or an online order changes, with a signed HTTPS request.')}</p>
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
                {ep.enabled && <button className="link" onClick={() => void test(ep)}>{t('Send a test')}</button>}
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
