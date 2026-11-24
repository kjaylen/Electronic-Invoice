/**
 * Email, for a business (Settings → Email) and for the platform's staff
 * (console → Email). The same four parts, over the same API shape:
 *
 *   Sending          the mail server email goes out through: a preset, the
 *                    details, a password that is only ever shown as "saved",
 *                    and a test that says exactly what the server answered
 *   Email log        every email: who, what, when, how it went; send again
 *   Do-not-send      addresses a server said do not exist, and people who opted out
 *   Deliverability   SPF, DKIM and DMARC in plain words, and a check of the domain
 *
 * A business's own server is optional: without one its email goes from the
 * platform's address under the business's name.
 */

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Segmented, Select, useDebounced } from '../ui';
import { CopyButton, Step } from './NetSuiteAddons';

type Scope = 'business' | 'platform';
type Security = 'none' | 'starttls' | 'tls';

interface Saved {
  host: string; port: number; security: Security; username: string; passwordSet: boolean; fromName: string; fromAddress: string; replyTo: string; enabled: boolean;
  verifiedAt: string | null; lastError: string | null; lastErrorAt: string | null; pausedUntil: string | null; updatedAt: string;
}
interface Preset { key: string; name: string; host: string; port: number; security: Security; username: string; note: string; appPassword: boolean }
interface View {
  settings: Saved | null;
  presets: Preset[];
  types: Array<{ key: string; label: string }>;
  limits: { perHour: number; perDay: number; maxAttempts: number; logDays: number; contentDays: number };
  /** A business: where its email goes without a server of its own. */
  platform?: { available: boolean; fromAddress: string | null; fromName: string; replyTo: string };
  /** The platform: what is used while nothing is saved. */
  route?: { source: 'saved' | 'environment' | 'outbox' | 'none'; host: string | null; from: { name: string; address: string } | null };
  warnings?: string[];
}
interface TestResult { ok: boolean; response?: string; error?: { kind: string; detail: string; hint: string }; from: string; to: string }
interface Message {
  id: string; tenantId: string | null; tenantName: string | null; type: string; typeLabel: string; to: string; subject: string; status: 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed'; attempts: number;
  via: 'business' | 'platform' | null; from: string | null; error: string | null; note: string | null; serverResponse: string | null; attachments: number;
  createdAt: string; sentAt: string | null; failedAt: string | null; nextAttemptAt: string | null; resendOf: string | null; canResend: boolean;
}
interface Suppression { id: string; email: string; reason: 'bounced' | 'unsubscribed' | 'manual'; detail: string | null; createdAt: string }
interface DnsCheck { record: 'spf' | 'dkim' | 'dmarc'; status: 'ok' | 'warning' | 'missing' | 'unknown'; name: string; found: string | null; message: string; suggestion: string | null }
interface Deliverability { sendsFrom: 'own' | 'platform' | 'none'; domain: string | null; provider: string | null; checks: DnsCheck[] }

const SECURITY: Array<[Security, string]> = [['starttls', 'STARTTLS'], ['tls', 'SSL/TLS'], ['none', 'None']];
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError && e.code === 'invalid_mail_settings' ? ((e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}) : {});

// ---------- sending ----------

/** A real message through the server, and exactly what came back. */
function TestEmail({ base, settings, defaultTo, onDone }: { base: string; settings?: Record<string, unknown>; defaultTo: string; onDone?: () => void }) {
  const t = useT();
  const [to, setTo] = useState(defaultTo);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<TestResult>(`${base}/settings/test`, { method: 'POST', body: { to, ...(settings && { settings }) } }));
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mail-test stack">
      <form className="row mail-test-row" onSubmit={(e) => void send(e)}>
        <Field label={t('Send a test email to')}>
          <input type="email" required value={to} onChange={(e) => setTo(e.target.value)} autoComplete="email" />
        </Field>
        <button type="submit" className="secondary" disabled={busy}>{busy ? t('Sending…') : t('Send test email')}</button>
      </form>
      <ErrorText error={error} />
      {result?.ok && (
        <div className="mail-result ok" role="status">
          <strong>{t('The mail server accepted it.')}</strong>
          <span>{t('Sent to {to} from {from}. Check the inbox, and the spam folder.', { to: result.to, from: result.from })}</span>
          <span className="small muted">{t('The server answered:')} <code>{result.response}</code></span>
        </div>
      )}
      {result && !result.ok && result.error && (
        <div className="mail-result failed" role="alert">
          <strong>{t('The test email was not sent.')}</strong>
          <span>{t(result.error.hint)}</span>
          <span className="small muted">{t('The server said:')} <code>{result.error.detail}</code></span>
        </div>
      )}
    </div>
  );
}

function SettingsForm({ scope, base, view, defaultTo, onSaved, onCancel }: { scope: Scope; base: string; view: View; defaultTo: string; onSaved: (v: View) => void; onCancel?: () => void }) {
  const t = useT();
  const toast = useToast();
  const s = view.settings;
  const business = scope === 'business';
  const [preset, setPreset] = useState(() => view.presets.find((p) => p.host === s?.host)?.key ?? (s ? 'other' : ''));
  const [host, setHost] = useState(s?.host ?? '');
  const [port, setPort] = useState(String(s?.port ?? 587));
  const [security, setSecurity] = useState<Security>(s?.security ?? 'starttls');
  const [username, setUsername] = useState(s?.username ?? '');
  const [password, setPassword] = useState('');
  const [replacing, setReplacing] = useState(!s?.passwordSet);
  const [fromName, setFromName] = useState(s?.fromName ?? view.platform?.fromName ?? view.route?.from?.name ?? '');
  const [fromAddress, setFromAddress] = useState(s?.fromAddress ?? '');
  const [replyTo, setReplyTo] = useState(s?.replyTo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [savedNow, setSavedNow] = useState(false);
  const chosen = view.presets.find((p) => p.key === preset);

  const choose = (key: string) => {
    setPreset(key);
    const p = view.presets.find((x) => x.key === key);
    if (!p) return;
    setHost(p.host);
    setPort(String(p.port));
    setSecurity(p.security);
  };
  // What the form holds. The password goes only when one was typed; a cleared username clears it.
  const body = () => ({
    host, port: /^\d+$/.test(port.trim()) ? Number(port.trim()) : port, security, username, fromName, fromAddress, replyTo,
    ...(replacing && password ? { password } : !username.trim() ? { password: null } : {}),
  });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setProblems({});
    try {
      const saved = await api<View>(`${base}/settings`, { method: 'PUT', body: body() });
      setWarnings(saved.warnings ?? []);
      setPassword('');
      setReplacing(!saved.settings?.passwordSet);
      toast(t('Email settings saved'));
      setSavedNow(true);
      onSaved(saved);
    } catch (err) {
      const fields = fieldErrors(err);
      setProblems(fields);
      if (!Object.keys(fields).length) setError(err);
    } finally {
      setBusy(false);
    }
  };
  const problem = (name: string) => problems[name] && <span className="field-problem" role="alert">{t(problems[name]!)}</span>;

  // The test box is a form of its own, so it sits beside this one, not inside it.
  return (
    <div className="stack mail-form">
    <form className="stack" onSubmit={(e) => void save(e)} noValidate>
      <Field label={t('Mail provider')} hint={t('Choosing one fills in the server, port and encryption.')}>
        <Select value={preset} onChange={(e) => choose(e.target.value)}>
          <option value="" disabled>{t('Choose…')}</option>
          {view.presets.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          <option value="other">{t('Another mail server')}</option>
        </Select>
      </Field>
      {chosen && (
        <div className="mail-note">
          <strong>{chosen.appPassword ? t('{provider} needs an app password', { provider: chosen.name }) : t('Before you start with {provider}', { provider: chosen.name })}</strong>
          <span>{t(chosen.note)}</span>
        </div>
      )}
      <div className="grid mail-grid">
        <Field label={t('Server')} hint={t('Like smtp.gmail.com')} className="span-2">
          <input value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(problems.host)} />
          {problem('host')}
        </Field>
        <Field label={t('Port')}>
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" autoComplete="off" aria-invalid={Boolean(problems.port)} />
          {problem('port')}
        </Field>
        <Field label={t('Encryption')}>
          <Select value={security} onChange={(e) => setSecurity(e.target.value as Security)}>
            {SECURITY.map(([k, label]) => <option key={k} value={k}>{k === 'none' ? t(label) : label}</option>)}
          </Select>
          {problem('security')}
        </Field>
        <Field label={t('Username')} hint={chosen ? t(chosen.username) : t('Often your full email address. Leave empty if the server needs no sign-in.')} className="span-2">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(problems.username)} />
          {problem('username')}
        </Field>
        <div className="field span-2">
          <span className="field-label" id="mail-password-label">{t('Password')}</span>
          {replacing ? (
            <input type="password" aria-labelledby="mail-password-label" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-invalid={Boolean(problems.password)} />
          ) : (
            <div className="row mail-secret">
              <span className="mail-secret-set" aria-labelledby="mail-password-label">•••••••••••• <span className="badge authorized">{t('Saved')}</span></span>
              <button type="button" className="secondary small-button" onClick={() => setReplacing(true)}>{t('Replace')}</button>
            </div>
          )}
          <span className="hint">{replacing && s?.passwordSet ? t('Leave empty to keep the saved password.') : t('Stored encrypted. It is never shown again, here or anywhere.')}</span>
          {problem('password')}
        </div>
        <Field label={t('From name')} hint={business ? t('What your customers see as the sender.') : t('What people see as the sender of the platform’s own emails.')} className="span-2">
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} autoComplete="organization" aria-invalid={Boolean(problems.fromName)} />
          {problem('fromName')}
        </Field>
        <Field label={t('From address')} hint={t('Usually the address of the account you sign in with.')} className="span-2">
          <input type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(problems.fromAddress)} />
          {problem('fromAddress')}
        </Field>
        <Field label={t('Reply-to (optional)')} hint={t('Where replies go, if not to the from address.')} className="span-2">
          <input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(problems.replyTo)} />
          {problem('replyTo')}
        </Field>
      </div>
      <ErrorText error={error} />
      {warnings.map((w) => <p key={w} className="mail-warning" role="status">{t(w)}</p>)}
      <div className="row mail-actions">
        <button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save')}</button>
        <button type="button" className="secondary" onClick={() => setTesting((v) => !v)} aria-expanded={testing}>{t('Send test email')}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>{savedNow ? t('Close') : t('Cancel')}</button>}
        <span className="spacer" />
      </div>
    </form>
      {testing && (
        <>
          <p className="small muted">{t('The test uses what is in the form now, saved or not.')}</p>
          <TestEmail base={base} settings={body()} defaultTo={defaultTo} />
        </>
      )}
    </div>
  );
}

function Sending({ scope, base, defaultTo }: { scope: Scope; base: string; defaultTo: string }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const business = scope === 'business';
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = useCallback(() => api<View>(`${base}/settings`).then(setView).catch(setError), [base]);
  useEffect(() => void load(), [load]);
  if (!view) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '14rem' }} />;
  const s = view.settings;
  const paused = Boolean(s?.pausedUntil);
  const remove = async () => {
    const ok = await confirm(business
      ? { title: t('Stop sending from your own address?'), body: t('Your emails will go out from {address} under your business’s name. The server’s details and its password are erased.', { address: view.platform?.fromAddress ?? '' }), confirm: t('Remove'), danger: true }
      : { title: t('Remove the saved mail server?'), body: t('The platform goes back to what the server’s environment sets (SMTP_URL), or to no email at all if that is not set.'), confirm: t('Remove'), danger: true });
    if (!ok) return;
    try {
      setView(await api<View>(`${base}/settings`, { method: 'DELETE' }));
      setEditing(false);
      toast(t('Mail server removed'));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <section className="card stack">
        <div className="row">
          <div>
            <h2>{business ? t('How your email is sent') : t('The platform’s mail server')}</h2>
            <p className="muted small">
              {business
                ? t('Invoices, receipts, order confirmations and reminders to your customers. Set up your own mail server to send them from your own address; it is optional.')
                : t('Every email goes through it: sign-in links, invitations, notices, and the email of every business that has no server of its own.')}
            </p>
          </div>
          <span className="spacer" />
          {s && <span className={`badge ${s.lastError ? 'rejected' : s.verifiedAt ? 'authorized' : 'pending'}`}>{s.lastError ? (paused ? t('Paused') : t('Having trouble')) : s.verifiedAt ? t('Working') : t('Not tested yet')}</span>}
        </div>
        <ErrorText error={error} />

        {s ? (
          <dl className="mail-summary">
            <div><dt>{t('From')}</dt><dd>{s.fromName} &lt;{s.fromAddress}&gt;</dd></div>
            <div><dt>{t('Through')}</dt><dd>{s.host}, {t('port')} {s.port}, {s.security === 'tls' ? 'SSL/TLS' : s.security === 'starttls' ? 'STARTTLS' : t('no encryption')}</dd></div>
            {s.replyTo && <div><dt>{t('Replies to')}</dt><dd>{s.replyTo}</dd></div>}
            <div><dt>{t('Last accepted a message')}</dt><dd>{s.verifiedAt ? when(s.verifiedAt) : t('Not yet')}</dd></div>
          </dl>
        ) : business ? (
          view.platform?.available
            ? <p>{t('Your emails go out from {address} under the name “{name}”. Replies go to {reply}.', { address: view.platform.fromAddress ?? '', name: view.platform.fromName, reply: view.platform.replyTo })}</p>
            : <p className="mail-warning">{t('Email is not set up on this server yet, so nothing can be sent. You can still set up your own mail server here.')}</p>
        ) : (
          <p className={view.route?.source === 'none' ? 'mail-warning' : undefined}>
            {view.route?.source === 'environment' && t('Nothing is saved here. Email goes through {host}, from {address}, as set in the server’s environment (SMTP_URL and MAIL_FROM). Settings saved here take over from it.', { host: view.route.host ?? '', address: view.route.from?.address ?? '' })}
            {view.route?.source === 'outbox' && t('Nothing is saved here. Email is written to a folder on the server instead of being sent (development). Settings saved here take over from it.')}
            {view.route?.source === 'none' && t('No mail server is set up: password resets, invitations and emailed documents are off for every business. Fill in the details below.')}
          </p>
        )}

        {s?.lastError && (
          <div className="mail-result failed" role="alert">
            <strong>{paused
              ? (business ? t('Your mail server refused several emails in a row. Your emails are going out from our address meanwhile, so nothing is lost.') : t('The mail server refused several emails in a row.'))
              : (business ? t('Your mail server refused the last email. It went out from our address instead.') : t('The mail server refused the last email. It stays in the queue and is tried again.'))}
            </strong>
            <span>{s.lastError}</span>
            {s.lastErrorAt && <span className="small muted">{when(s.lastErrorAt)}</span>}
          </div>
        )}

        {s && !editing && (
          <div className="row mail-actions">
            <button type="button" className="secondary" onClick={() => setEditing(true)}>{t('Change')}</button>
            <button type="button" className="secondary" onClick={() => setTesting((v) => !v)} aria-expanded={testing}>{t('Send test email')}</button>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => void remove()}>{t('Remove')}</button>
          </div>
        )}
        {s && !editing && testing && <TestEmail base={base} defaultTo={defaultTo} onDone={() => void load()} />}
        {!s && !editing && business && <div><button type="button" onClick={() => setEditing(true)}>{t('Send from your own address')}</button></div>}
        {!s && !editing && !business && view.route?.source !== 'none' && (
          <div className="row mail-actions">
            <button type="button" onClick={() => setEditing(true)}>{t('Set up a mail server here')}</button>
            <button type="button" className="secondary" onClick={() => setTesting((v) => !v)} aria-expanded={testing}>{t('Send test email')}</button>
          </div>
        )}
        {!s && !editing && !business && view.route?.source !== 'none' && testing && <TestEmail base={base} defaultTo={defaultTo} />}
      </section>

      {(editing || (!s && !business && view.route?.source === 'none')) && (
        <section className="card stack">
          <h2>{s ? t('Mail server details') : t('Set up a mail server')}</h2>
          <SettingsForm
            scope={scope} base={base} view={view} defaultTo={defaultTo}
            onSaved={(v) => {
              setView(v);
              setEditing(true);
            }}
            {...(s || business || view.route?.source !== 'none' ? { onCancel: () => setEditing(false) } : {})}
          />
        </section>
      )}

      <p className="small muted">
        {business
          ? t('Up to {hour} emails an hour and {day} a day; more wait their turn. An email that cannot be delivered is tried {n} times over about three hours. The log is kept {days} days.', { hour: view.limits.perHour, day: view.limits.perDay, n: view.limits.maxAttempts, days: view.limits.logDays })
          : t('Each business may send {hour} emails an hour and {day} a day; more wait their turn. An email that cannot be delivered is tried {n} times over about three hours. The log is kept {days} days, message bodies {content}.', { hour: view.limits.perHour, day: view.limits.perDay, n: view.limits.maxAttempts, days: view.limits.logDays, content: view.limits.contentDays })}
      </p>
    </>
  );
}

// ---------- the log ----------

const STATUS: Record<Message['status'], [string, string]> = {
  queued: ['Waiting', 'pending'], sending: ['Sending', 'pending'], sent: ['Sent', 'authorized'], failed: ['Failed', 'rejected'], suppressed: ['Not sent', 'cancelled'],
};

function Log({ scope, base }: { scope: Scope; base: string }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Message[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [types, setTypes] = useState<Array<{ key: string; label: string }>>([]);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = useCallback((before?: string) => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (type) p.set('type', type);
    if (search.trim()) p.set('q', search.trim());
    if (before) p.set('before', before);
    return api<{ data: Message[]; nextBefore: string | null }>(`${base}/messages?${p.toString()}`);
  }, [base, status, type, search]);
  const load = useCallback(() => query().then((r) => {
    setRows(r.data);
    setNext(r.nextBefore);
    setError(null);
  }).catch(setError), [query]);
  useEffect(() => void load(), [load]);
  useEffect(() => void api<View>(`${base}/settings`).then((v) => setTypes(v.types)).catch(() => {}), [base]);
  const older = async () => {
    if (!next) return;
    try {
      const r = await query(next);
      setRows((have) => [...(have ?? []), ...r.data]);
      setNext(r.nextBefore);
    } catch (err) {
      setError(err);
    }
  };
  const resend = async (m: Message) => {
    if (!(await confirm({ title: t('Send this email again?'), body: t('“{subject}” to {to}, exactly as it was.', { subject: m.subject, to: m.to }), confirm: t('Send again') }))) return;
    setBusy(m.id);
    try {
      await api(`${base}/messages/${m.id}/resend`, { method: 'POST', body: {} });
      toast(t('Sent again to {to}', { to: m.to }));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Email log')}</h2>
          <p className="muted small">{scope === 'business' ? t('Every email sent for your business, newest first.') : t('Every email the platform sent, for every business, newest first.')}</p>
        </div>
        <span className="spacer" />
        <button type="button" className="secondary small-button" onClick={() => void load()}>{t('Refresh')}</button>
      </div>
      <div className="row mail-filters">
        <Field label={t('Search')}><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Address or subject')} /></Field>
        <Field label={t('Status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('All')}</option>
            <option value="sent">{t('Sent')}</option>
            <option value="queued">{t('Waiting')}</option>
            <option value="failed">{t('Failed')}</option>
            <option value="suppressed">{t('Not sent')}</option>
          </Select>
        </Field>
        <Field label={t('Kind')}>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t('All')}</option>
            {types.map((x) => <option key={x.key} value={x.key}>{t(x.label)}</option>)}
          </Select>
        </Field>
      </div>
      <ErrorText error={error} />
      {!rows ? !error && <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? <div className="empty">{status || type || search.trim() ? t('No emails match.') : t('No emails yet.')}</div> : (
        <div className="table-wrap">
          <table className="responsive mail-log">
            <thead>
              <tr>
                <th scope="col">{t('When')}</th>
                {scope === 'platform' && <th scope="col">{t('Business')}</th>}
                <th scope="col">{t('To')}</th>
                <th scope="col">{t('Email')}</th>
                <th scope="col">{t('Status')}</th>
                <th scope="col"><span className="sr-only">{t('Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td data-label={t('When')} className="small nowrap">{when(m.createdAt)}</td>
                  {scope === 'platform' && <td data-label={t('Business')} className="small">{m.tenantName ?? <span className="muted">{t('Platform')}</span>}</td>}
                  <td data-label={t('To')} className="small mail-to">{m.to}</td>
                  <td data-label={t('Email')} className="small">
                    {m.subject}
                    <div className="muted">{t(m.typeLabel)}{m.attachments > 0 && ` · ${m.attachments === 1 ? t('1 attachment') : t('{n} attachments', { n: m.attachments })}`}{m.resendOf && ` · ${t('sent again')}`}</div>
                  </td>
                  <td data-label={t('Status')} className="small">
                    <span className={`badge ${STATUS[m.status][1]}`}>{t(STATUS[m.status][0])}</span>
                    {m.status === 'sent' && m.sentAt && <div className="muted">{when(m.sentAt)}{m.via === 'business' ? ` · ${t('your server')}` : ''}</div>}
                    {m.status === 'queued' && m.nextAttemptAt && m.attempts > 0 && <div className="muted">{t('Tried {n} times; next try {when}', { n: m.attempts, when: when(m.nextAttemptAt) })}</div>}
                    {m.error && <div className="mail-problem">{m.error}</div>}
                    {m.note && <div className="muted">{m.note}</div>}
                  </td>
                  <td className="right">
                    {m.canResend && <button type="button" className="secondary small-button" disabled={busy === m.id} onClick={() => void resend(m)}>{t('Send again')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <div><button type="button" className="secondary" onClick={() => void older()}>{t('Older')}</button></div>}
    </section>
  );
}

// ---------- the do-not-send list ----------

function Suppressions({ scope, base }: { scope: Scope; base: string }) {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<{ data: Suppression[] }>(`${base}/suppressions`).then((r) => setRows(r.data)).catch(setError), [base]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setRows((await api<{ data: Suppression[] }>(`${base}/suppressions`, { method: 'POST', body: { email } })).data);
      setEmail('');
    } catch (err) {
      setError(err);
    }
  };
  const remove = async (s: Suppression) => {
    setError(null);
    try {
      setRows((await api<{ data: Suppression[] }>(`${base}/suppressions/${s.id}`, { method: 'DELETE' })).data);
      toast(t('{email} can be written to again', { email: s.email }));
    } catch (err) {
      setError(err);
    }
  };
  const why = (s: Suppression): ReactNode => (s.reason === 'bounced' ? t('An email to it came back: the mailbox does not exist') : s.reason === 'unsubscribed' ? t('Asked not to get emails they did not ask for') : t('Added by hand'));
  return (
    <section className="card stack">
      <div>
        <h2>{t('Do-not-send list')}</h2>
        <p className="muted small">
          {scope === 'business'
            ? t('Addresses your business does not write to. An address goes on it when a mail server says the mailbox does not exist, or when someone presses “Stop getting these emails”. Writing to dead addresses is what gets a sender marked as spam.')
            : t('Addresses the platform’s own emails are not sent to. Each business has a list of its own.')}
        </p>
      </div>
      <form className="row mail-test-row" onSubmit={(e) => void add(e)}>
        <Field label={t('Add an address')}><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
        <button type="submit" className="secondary">{t('Add')}</button>
      </form>
      <ErrorText error={error} />
      {!rows ? !error && <div className="skeleton" style={{ height: '5rem' }} /> : rows.length === 0 ? <div className="empty">{t('No addresses on the list.')}</div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Address')}</th><th scope="col">{t('Why')}</th><th scope="col">{t('Since')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td data-label={t('Address')} className="small mail-to">{s.email}</td>
                  <td data-label={t('Why')} className="small">{why(s)}{s.reason === 'bounced' && s.detail && <div className="muted">{s.detail}</div>}</td>
                  <td data-label={t('Since')} className="small nowrap">{when(s.createdAt)}</td>
                  <td className="right"><button type="button" className="secondary small-button" onClick={() => void remove(s)}>{t('Take off the list')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- deliverability ----------

const RECORD: Record<DnsCheck['record'], { title: string; what: string }> = {
  spf: { title: 'SPF: who may send for your domain', what: 'A list, published by your domain, of the mail servers allowed to send email in its name. A receiver that sees your email arrive from a server not on the list treats it as forged.' },
  dkim: { title: 'DKIM: a signature on every email', what: 'Your mail server signs each email, and your domain publishes the key to check the signature. It proves the email was not changed on the way and really comes from you.' },
  dmarc: { title: 'DMARC: what to do with forgeries', what: 'Tells receivers what to do with email that fails both checks above, and where to send reports. Gmail and Yahoo expect it from anyone who sends regularly.' },
};
const DNS_STATUS: Record<DnsCheck['status'], [string, string]> = { ok: ['In place', 'authorized'], warning: ['Needs fixing', 'pending'], missing: ['Missing', 'rejected'], unknown: ['Could not tell', 'cancelled'] };

function DeliverabilityGuide({ scope, base }: { scope: Scope; base: string }) {
  const t = useT();
  const [result, setResult] = useState<Deliverability | null>(null);
  const [selector, setSelector] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = useCallback(async (sel = '') => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Deliverability>(`${base}/deliverability${sel.trim() ? `?selector=${encodeURIComponent(sel.trim())}` : ''}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [base]);
  useEffect(() => void check(), [check]);
  const of = (record: DnsCheck['record']) => result?.checks.find((c) => c.record === record);

  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Deliverability')}</h2>
          <p className="muted small">{t('Whether your email lands in the inbox or in spam depends mostly on three records in your domain’s DNS. You add them once, where you manage your domain (the company you bought it from).')}</p>
        </div>
        <span className="spacer" />
        {result?.sendsFrom === 'own' && <button type="button" className="secondary small-button" disabled={busy} onClick={() => void check(selector)}>{busy ? t('Checking…') : t('Check again')}</button>}
      </div>
      <ErrorText error={error} />
      {!result ? !error && <div className="skeleton" style={{ height: '12rem' }} /> : result.sendsFrom === 'platform' ? (
        <div className="mail-result ok">
          <strong>{t('Nothing for you to set up.')}</strong>
          <span>{t('Your email goes out from our address ({domain}), and we look after its records. If you set up your own mail server under Sending, this page checks your own domain.', { domain: result.domain ?? '' })}</span>
        </div>
      ) : result.sendsFrom === 'none' ? (
        <p className="muted">{scope === 'platform' ? t('Once a mail server is set up under Sending, this page checks the domain of its from address.') : t('Set up a mail server under Sending first.')}</p>
      ) : (
        <>
          <p>{t('Checking {domain}, the domain of your from address.', { domain: result.domain ?? '' })}</p>
          <ol className="guide">
            {(['spf', 'dkim', 'dmarc'] as const).map((record, i) => {
              const c = of(record);
              return (
                <Step key={record} n={i + 1} title={t(RECORD[record].title)} done={c?.status === 'ok'}>
                  <p className="small muted">{t(RECORD[record].what)}</p>
                  {c && (
                    <div className={`mail-dns ${c.status}`}>
                      <div className="row"><span className={`badge ${DNS_STATUS[c.status][1]}`}>{t(DNS_STATUS[c.status][0])}</span><code className="small">{c.name}</code></div>
                      <span>{c.message}</span>
                      {c.found && <code className="mail-record">{c.found}</code>}
                      {c.suggestion && (
                        <div className="row mail-suggest">
                          <span className="small muted">{c.found ? t('Add to it:') : t('Add a TXT record with this value:')}</span>
                          <code className="mail-record">{c.suggestion}</code>
                          <CopyButton text={c.suggestion} label={t('Copy')} />
                        </div>
                      )}
                      {record === 'dkim' && c.status !== 'ok' && (
                        <form className="row mail-test-row" onSubmit={(e) => { e.preventDefault(); void check(selector); }}>
                          <Field label={t('DKIM selector')} hint={t('The first word of the record’s name your mail provider gives you, before “._domainkey”.')}>
                            <input value={selector} onChange={(e) => setSelector(e.target.value)} autoComplete="off" spellCheck={false} />
                          </Field>
                          <button type="submit" className="secondary" disabled={busy}>{t('Check')}</button>
                        </form>
                      )}
                    </div>
                  )}
                </Step>
              );
            })}
          </ol>
          <p className="small muted">{t('New records can take an hour or so to be seen. Send yourself a test email afterwards and open its details in your mail app: it should say SPF, DKIM and DMARC all passed.')}</p>
        </>
      )}
    </section>
  );
}

// ---------- the two pages ----------

type Part = 'sending' | 'log' | 'blocked' | 'deliverability';

function EmailParts({ scope, base, defaultTo, tab }: { scope: Scope; base: string; defaultTo: string; tab?: string }) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const parts: Array<[Part, string]> = [['sending', t('Sending')], ['log', t('Email log')], ['blocked', t('Do-not-send list')], ['deliverability', t('Deliverability')]];
  const asked = params.get('part') as Part | null;
  const part: Part = parts.some(([k]) => k === asked) ? asked! : 'sending';
  return (
    <div className="stack">
      <div className="row dev-head">
        <Segmented label={t('Email')} value={part} switches onChange={(v) => setParams({ ...(tab && { tab }), part: v }, { replace: true })} options={parts} />
      </div>
      {part === 'sending' && <Sending scope={scope} base={base} defaultTo={defaultTo} />}
      {part === 'log' && <Log scope={scope} base={base} />}
      {part === 'blocked' && <Suppressions scope={scope} base={base} />}
      {part === 'deliverability' && <DeliverabilityGuide scope={scope} base={base} />}
    </div>
  );
}

/** Settings → Email, for a business's owners and admins. */
export function EmailTab({ defaultTo }: { defaultTo: string }) {
  return <EmailParts scope="business" base="/v1/mail" defaultTo={defaultTo} tab="email" />;
}

/** The platform console's Email page, for staff. */
export function ConsoleEmail({ defaultTo }: { defaultTo: string }) {
  const t = useT();
  return (
    <>
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Email')}</h1></div>
      <EmailParts scope="platform" base="/v1/platform/mail" defaultTo={defaultTo} />
    </>
  );
}
