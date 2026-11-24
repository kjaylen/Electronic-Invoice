/** Settings → Online store, the extras: taking payments online, discount codes, the store on its own domain. */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, apiShared } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money, Select } from '../ui';

// ---------- PayPal ----------

export interface Accounts {
  paypal: { connected: boolean; clientId: string | null; mode: 'sandbox' | 'live' };
  belizebank: { connected: boolean; userName: string | null; mode: 'sandbox' | 'live' };
  ekyash: { connected: boolean; sid: string | null; mode: 'sandbox' | 'live'; available: { sandbox: boolean; live: boolean }; callbackUrl: string | null };
  test: { available: boolean };
}

// ---------- Belize Bank: cards on the bank's page, and E-Kyash ----------

export function BelizeBankConnect({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ userName: '', password: '', mode: 'sandbox' as 'sandbox' | 'live' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiShared<Accounts>('/v1/payment-accounts').then((a) => {
    setAccounts(a);
    setForm((f) => ({ ...f, userName: a.belizebank.userName ?? '', mode: a.belizebank.mode }));
  }).catch(setError), []);
  useEffect(() => void load(), [load]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/payment-accounts/belizebank', { method: 'PUT', body: { userName: form.userName, mode: form.mode, ...(form.password && { password: form.password }) } });
      toast(t('Belize Bank connected'));
      setEditing(false);
      setForm((f) => ({ ...f, password: '' }));
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!accounts) return error ? <ErrorText error={error} /> : null;
  const a = accounts.belizebank;
  return (
    <div className="stack paypal-box">
      <div className="row">
        <strong>{t('Belize Bank cards')}</strong>
        <span className="spacer" />
        {a.connected ? <span className="badge authorized">{a.mode === 'live' ? t('Connected') : t('Connected (sandbox)')}</span> : <span className="badge test">{t('Not connected')}</span>}
      </div>
      <p className="small muted">{t('Visa and Mastercard on Belize Bank’s secure payment page, charged in Belize dollars. Needs a merchant account with Belize Bank.')}</p>
      {!editing ? (
        <div className="row">
          <button type="button" className="secondary" onClick={() => setEditing(true)}>{a.connected ? t('Change') : t('Connect Belize Bank')}</button>
          {a.connected && <button type="button" className="link danger-link" onClick={() => void api('/v1/payment-accounts/belizebank', { method: 'DELETE' }).then(() => { toast(t('Belize Bank disconnected')); void load(); onChanged(); }).catch(setError)}>{t('Disconnect')}</button>}
        </div>
      ) : (
        <div className="stack">
          <p className="small">{t('Enter the payment gateway user name and password the bank gave you. Test in the sandbox first; the bank switches you to live after a successful test.')}</p>
          <div className="form-grid">
            <Field label={t('User name')}><input required value={form.userName} onChange={(e) => setForm({ ...form, userName: e.target.value.trim() })} autoComplete="off" /></Field>
            <Field label={t('Password')} hint={a.connected ? t('Leave empty to keep the current one.') : undefined}><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          </div>
          <Field label={t('Mode')}>
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'sandbox' | 'live' })}>
              <option value="sandbox">{t('Sandbox (test money)')}</option>
              <option value="live">{t('Live (real money)')}</option>
            </Select>
          </Field>
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setEditing(false)}>{t('Cancel')}</button><button type="button" disabled={busy || !form.userName} onClick={() => void save()}>{busy ? t('Checking with the bank…') : t('Save')}</button></div>
        </div>
      )}
    </div>
  );
}

export function EKyashConnect({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ sid: '', pinHash: '', apiKey: '', apiPassword: '', mode: 'sandbox' as 'sandbox' | 'live' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiShared<Accounts>('/v1/payment-accounts').then((a) => {
    setAccounts(a);
    setForm((f) => ({ ...f, sid: a.ekyash.sid ?? '', mode: a.ekyash.mode }));
  }).catch(setError), []);
  useEffect(() => void load(), [load]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/v1/payment-accounts/ekyash', {
        method: 'PUT',
        body: { sid: form.sid, mode: form.mode, ...(form.pinHash && { pinHash: form.pinHash }), ...(form.apiKey && { apiKey: form.apiKey }), ...(form.apiPassword && { apiPassword: form.apiPassword }) },
      });
      toast(t('E-Kyash connected'));
      setEditing(false);
      setForm((f) => ({ ...f, pinHash: '', apiKey: '', apiPassword: '' }));
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!accounts) return error ? <ErrorText error={error} /> : null;
  const a = accounts.ekyash;
  if (!a.available.sandbox && !a.available.live && !a.connected) return null;
  const keep = a.connected ? t('Leave empty to keep the current one.') : undefined;
  return (
    <div className="stack paypal-box">
      <div className="row">
        <strong>E-Kyash</strong>
        <span className="spacer" />
        {a.connected ? <span className="badge authorized">{a.mode === 'live' ? t('Connected') : t('Connected (sandbox)')}</span> : <span className="badge test">{t('Not connected')}</span>}
      </div>
      <p className="small muted">{t('Customers pay from the E-Kyash app: they scan a QR code, or tap a button on their phone. In Belize dollars.')}</p>
      {a.connected && a.callbackUrl && (
        <p className="small">{t('Give Belize Bank this address for E-Kyash notifications:')} <code className="copyable">{a.callbackUrl}</code></p>
      )}
      {!editing ? (
        <div className="row">
          <button type="button" className="secondary" onClick={() => setEditing(true)}>{a.connected ? t('Change') : t('Connect E-Kyash')}</button>
          {a.connected && <button type="button" className="link danger-link" onClick={() => void api('/v1/payment-accounts/ekyash', { method: 'DELETE' }).then(() => { toast(t('E-Kyash disconnected')); void load(); onChanged(); }).catch(setError)}>{t('Disconnect')}</button>}
        </div>
      ) : (
        <div className="stack">
          <p className="small">{t('Enter the merchant details Belize Bank gave you for E-Kyash.')}</p>
          <div className="form-grid">
            <Field label={t('Merchant ID (SID)')}><input required inputMode="numeric" value={form.sid} onChange={(e) => setForm({ ...form, sid: e.target.value.replace(/\D/g, '') })} autoComplete="off" /></Field>
            <Field label={t('PIN hash')} hint={keep}><input autoComplete="off" spellCheck={false} value={form.pinHash} onChange={(e) => setForm({ ...form, pinHash: e.target.value.trim() })} /></Field>
            <Field label={t('API key')} hint={keep}><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value.trim() })} /></Field>
            <Field label={t('API password')} hint={keep}><input type="password" autoComplete="new-password" value={form.apiPassword} onChange={(e) => setForm({ ...form, apiPassword: e.target.value.trim() })} /></Field>
          </div>
          <Field label={t('Mode')}>
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'sandbox' | 'live' })}>
              {a.available.sandbox && <option value="sandbox">{t('Sandbox (test money)')}</option>}
              {a.available.live && <option value="live">{t('Live (real money)')}</option>}
            </Select>
          </Field>
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setEditing(false)}>{t('Cancel')}</button><button type="button" disabled={busy || !form.sid} onClick={() => void save()}>{busy ? t('Checking with E-Kyash…') : t('Save')}</button></div>
        </div>
      )}
    </div>
  );
}

export function PayPalConnect({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ clientId: '', secret: '', mode: 'sandbox' as 'sandbox' | 'live' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiShared<Accounts>('/v1/payment-accounts').then((a) => {
    setAccounts(a);
    setForm((f) => ({ ...f, clientId: a.paypal.clientId ?? '', mode: a.paypal.mode }));
  }).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/payment-accounts/paypal', { method: 'PUT', body: { clientId: form.clientId, mode: form.mode, ...(form.secret && { secret: form.secret }) } });
      toast(t('PayPal connected'));
      setEditing(false);
      setForm((f) => ({ ...f, secret: '' }));
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!accounts) return error ? <ErrorText error={error} /> : null;
  return (
    <div className="stack paypal-box">
      <div className="row">
        <strong>PayPal</strong>
        <span className="spacer" />
        {accounts.paypal.connected ? <span className="badge authorized">{accounts.paypal.mode === 'live' ? t('Connected') : t('Connected (sandbox)')}</span> : <span className="badge test">{t('Not connected')}</span>}
      </div>
      <p className="small muted">{t('Buyers pay by card or with their PayPal account. PayPal does not take Belize dollars, so the charge is in US dollars at the fixed rate of BZ$2 = US$1; the receipt stays in BZ$.')}</p>
      {!editing ? (
        <div className="row">
          <button type="button" className="secondary" onClick={() => setEditing(true)}>{accounts.paypal.connected ? t('Change') : t('Connect PayPal')}</button>
          {accounts.paypal.connected && <button type="button" className="link danger-link" onClick={() => void api('/v1/payment-accounts/paypal', { method: 'DELETE' }).then(() => { toast(t('PayPal disconnected')); void load(); onChanged(); }).catch(setError)}>{t('Disconnect')}</button>}
        </div>
      ) : (
        <div className="stack">
          <p className="small">{t('In the PayPal Developer Dashboard, create an app (Apps & Credentials) and copy its client ID and secret here. Try it in sandbox first.')}</p>
          <div className="form-grid">
            <Field label={t('Client ID')}><input required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value.trim() })} /></Field>
            <Field label={t('Secret')} hint={accounts.paypal.connected ? t('Leave empty to keep the current one.') : undefined}><input type="password" autoComplete="off" required={!accounts.paypal.connected} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value.trim() })} /></Field>
          </div>
          <Field label={t('Mode')}>
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'sandbox' | 'live' })}>
              <option value="sandbox">{t('Sandbox (test money)')}</option>
              <option value="live">{t('Live (real money)')}</option>
            </Select>
          </Field>
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setEditing(false)}>{t('Cancel')}</button><button type="button" disabled={busy} onClick={(e) => void save(e as unknown as FormEvent)}>{busy ? t('Checking with PayPal…') : t('Save')}</button></div>
        </div>
      )}
    </div>
  );
}

// ---------- discount codes ----------

interface Discount {
  id: string;
  code: string;
  kind: 'percent' | 'amount' | 'free_delivery';
  value: string;
  minSubtotal: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
}

export function DiscountCodes() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<Discount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: '', kind: 'percent' as Discount['kind'], value: '10', minSubtotal: '', endsAt: '', maxUses: '' });
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: Discount[] }>('/v1/discounts').then((r) => setRows(r.data)).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/v1/discounts', {
        method: 'POST',
        body: {
          code: form.code, kind: form.kind,
          ...(form.kind !== 'free_delivery' && { value: form.value }),
          ...(form.minSubtotal && { minSubtotal: form.minSubtotal }),
          ...(form.endsAt && { endsAt: new Date(`${form.endsAt}T23:59:59-06:00`).toISOString() }),
          ...(form.maxUses && { maxUses: Number(form.maxUses) }),
        },
      });
      toast(t('Discount code {code} created', { code: form.code.toUpperCase() }));
      setAdding(false);
      setForm({ code: '', kind: 'percent', value: '10', minSubtotal: '', endsAt: '', maxUses: '' });
      await load();
    } catch (err) {
      setError(err);
    }
  };
  const describe = (d: Discount) => (d.kind === 'percent' ? t('{n}% off', { n: d.value }) : d.kind === 'amount' ? t('{amount} off', { amount: money(d.value) }) : t('Free delivery'));
  return (
    <section className="card stack">
      <div className="row">
        <div><h2>{t('Discount codes')}</h2><p className="small muted">{t('Buyers type a code at checkout. The discount shows on their receipt, before GST, as BTS expects.')}</p></div>
        <span className="spacer" />
        <button type="button" onClick={() => setAdding(true)}>{t('New code')}</button>
      </div>
      <ErrorText error={!adding ? error : null} />
      {rows && rows.length === 0 && <div className="empty">{t('No discount codes yet.')}</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Code')}</th><th scope="col">{t('Discount')}</th><th scope="col">{t('Used')}</th><th scope="col">{t('Ends')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className={d.active ? '' : 'disabled-row'}>
                  <td data-label={t('Code')} className="mono"><strong>{d.code}</strong>{!d.active && <span className="badge cancelled">{t('Off')}</span>}</td>
                  <td data-label={t('Discount')}>{describe(d)}{d.minSubtotal && <div className="small muted">{t('orders from {amount}', { amount: money(d.minSubtotal) })}</div>}</td>
                  <td data-label={t('Used')}>{d.uses}{d.maxUses !== null && ` / ${d.maxUses}`}</td>
                  <td data-label={t('Ends')} className="small">{d.endsAt ? new Date(d.endsAt).toLocaleDateString() : t('Never')}</td>
                  <td className="right"><button type="button" className="link" onClick={() => void api(`/v1/discounts/${d.id}`, { method: 'PATCH', body: { active: !d.active } }).then(load).catch(setError)}>{d.active ? t('Switch off') : t('Switch on')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <Modal title={t('New discount code')} onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={(e) => void create(e)}>
            <Field label={t('Code')} hint={t('What buyers type, e.g. REEF10. Letters, digits and dashes.')}><input required autoFocus minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]+" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></Field>
            <div className="form-grid">
              <Field label={t('Kind')}>
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Discount['kind'] })}>
                  <option value="percent">{t('Percent off')}</option>
                  <option value="amount">{t('BZ$ off (GST included)')}</option>
                  <option value="free_delivery">{t('Free delivery')}</option>
                </Select>
              </Field>
              {form.kind !== 'free_delivery' && <Field label={form.kind === 'percent' ? t('Percent') : t('Amount (BZ$)')}><input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>}
            </div>
            <div className="form-grid">
              <Field label={t('Minimum order (BZ$)')} hint={t('Optional.')}><input inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })} /></Field>
              <Field label={t('Last day')} hint={t('Optional.')}><input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
              <Field label={t('Uses')} hint={t('Optional limit.')}><input type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} /></Field>
            </div>
            <ErrorText error={error} />
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setAdding(false)}>{t('Cancel')}</button><button type="submit">{t('Create code')}</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}

// ---------- custom domains ----------

interface Domain {
  domain: string;
  verified: boolean;
  records: Array<{ type: string; name: string; value: string }>;
  url: string;
}

export function StoreDomains() {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState<{ data: Domain[]; target: string | null } | null>(null);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => api<{ data: Domain[]; target: string | null }>('/v1/store-domains').then(setData).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast(message);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  if (!data) return null;
  return (
    <section className="card stack">
      <h2>{t('Your own domain')}</h2>
      <p className="small muted">{t('Show your store at your own address, like shop.yourbusiness.bz. You need access to the domain\'s DNS settings.')}</p>
      {data.data.map((d) => (
        <div key={d.domain} className="domain-box stack">
          <div className="row">
            <strong className="mono">{d.domain}</strong>
            <span className="spacer" />
            {d.verified ? <a className="badge authorized" href={d.url} target="_blank" rel="noreferrer">{t('Live')} ↗</a> : <span className="badge pending">{t('Waiting for DNS')}</span>}
          </div>
          {!d.verified && (
            <>
              <p className="small">{t('Add these two records at your domain provider, then press Verify. DNS changes can take up to an hour.')}</p>
              <div className="table-wrap">
                <table className="dns-records">
                  <thead><tr><th scope="col">{t('Type')}</th><th scope="col">{t('Name')}</th><th scope="col">{t('Value')}</th></tr></thead>
                  <tbody>{d.records.map((r) => <tr key={r.type}><td className="mono">{r.type}</td><td className="mono small">{r.name}</td><td className="mono small">{r.value}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
          <div className="row">
            {!d.verified && <button type="button" disabled={busy !== null} onClick={() => void act(d.domain, () => api(`/v1/store-domains/${encodeURIComponent(d.domain)}/verify`, { method: 'POST' }), t('{domain} is live', { domain: d.domain }))}>{busy === d.domain ? t('Checking…') : t('Verify')}</button>}
            <span className="spacer" />
            <button type="button" className="link danger-link" onClick={() => void act(`rm-${d.domain}`, () => api(`/v1/store-domains/${encodeURIComponent(d.domain)}`, { method: 'DELETE' }), t('Domain removed'))}>{t('Remove')}</button>
          </div>
        </div>
      ))}
      <div className="row">
        <input aria-label={t('Domain')} placeholder="shop.yourbusiness.bz" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ maxWidth: 320 }} />
        <button type="button" className="secondary" disabled={!domain.trim() || busy !== null} onClick={() => void act('add', () => api('/v1/store-domains', { method: 'POST', body: { domain } }).then(() => setDomain('')), t('Domain added'))}>{t('Add domain')}</button>
      </div>
      <ErrorText error={error} />
    </section>
  );
}
