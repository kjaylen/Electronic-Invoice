/**
 * Settings, in tabs: your account; the business (details, address,
 * certificate); users (owners and admins); activity log; API keys.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Account, type AuditEvent, type BusinessProfile, type ManagedAccount, type Role } from '../api';
import { goToBusiness } from '../business';
import { type T, useI18n, useT } from '../i18n';
import { assignableRoles, ROLE_DESCRIPTION, ROLE_LABEL } from '../permissions';
import { useSession } from '../session';
import { useToast } from '../toast';
import { DISTRICTS, ErrorText, Field, Modal, Segmented, usePageTitle } from '../ui';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Submit handler with busy and error state. */
function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (...args: A) => {
    setBusy(true);
    setError(null);
    try {
      await fn(...args);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy, setError };
}

/** A readable temporary password: 12 characters without look-alikes (0/O, 1/l). */
function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// ---------- certificate ----------

/** Upload the BTS certificate (.pfx/.p12 and its password). The server checks the permission too. */
export function CertificateUpload({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const { refresh } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { run, error, busy } = useAction(async () => {
    if (!file) return;
    await api('/v1/certificate/pfx', { method: 'POST', body: { pfxBase64: await readAsBase64(file), password } });
    setDone(true);
    await refresh();
    onDone?.();
  });
  if (done) return <div className="banner ok" role="status"><div><strong>{t('Certificate installed.')}</strong>{t('You can issue documents now.')}</div></div>;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <Field label={t('Certificate file')} hint={t('.pfx or .p12, from the BTS portal.')}>
        <input type="file" accept=".pfx,.p12,application/x-pkcs12" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label={t('Certificate password')}><input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorText error={error} />
      <button type="submit" disabled={busy || !file}>{busy ? t('Installing…') : t('Install certificate')}</button>
    </form>
  );
}

// ---------- my account ----------

function ChangePassword() {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const { run, error, busy } = useAction(async () => {
    await api('/v1/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    toast(t('Password changed. Other devices were signed out.'));
    setOpen(false);
    setCurrent('');
    setNext('');
  });
  return (
    <>
      <button className="secondary" onClick={() => setOpen(true)}>{t('Change password')}</button>
      {open && (
        <Modal title={t('Change password')} onClose={() => setOpen(false)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(); }}>
            <Field label={t('Current password')}><input type="password" autoComplete="current-password" required autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field label={t('New password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <ErrorText error={error} />
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setOpen(false)}>{t('Cancel')}</button><button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Change password')}</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function AccountTab() {
  const { t, lang, setLang } = useI18n();
  const { session, logout } = useSession();
  const user = session!.user;
  const signOutAll = useAction(async () => {
    await api(`/v1/users/${user.id}/sign-out`, { method: 'POST' });
    await logout();
  });
  return (
    <div className="grid">
      <section className="card stack">
        <h2>{t('Your account')}</h2>
        <dl className="facts">
          <dt>{t('Name')}</dt><dd>{user.name}</dd>
          {user.email && <><dt>{t('Email')}</dt><dd>{user.email}</dd></>}
          {user.username && <><dt>{t('Username')}</dt><dd className="mono">{user.username}</dd></>}
          <dt>{t('Role')}</dt><dd>{t(ROLE_LABEL[user.role])}</dd>
        </dl>
        <p className="small muted">{t(ROLE_DESCRIPTION[user.role])}</p>
        <p className="small muted">{t('Your name, email and role are managed by an owner or admin of this business.')}</p>
      </section>
      <section className="card stack">
        <h2>{t('Security and language')}</h2>
        <Segmented label={t('Language')} value={lang} onChange={setLang} options={[['en', 'English'], ['es', 'Español']]} />
        <div className="row">
          <ChangePassword />
          <button className="secondary" disabled={signOutAll.busy} onClick={() => void signOutAll.run()}>{t('Sign out everywhere')}</button>
        </div>
        <ErrorText error={signOutAll.error} />
      </section>
    </div>
  );
}

// ---------- business ----------

function BusinessTab() {
  const t = useT();
  const toast = useToast();
  const { me, can, role, refresh, refreshMe } = useSession();
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [form, setForm] = useState<{ legalName: string; tradeName: string; street: string; city: string; districtCode: string; telephone: string; email: string; slug: string } | null>(null);
  const editable = can('business.manage');
  const load = useCallback(() => api<BusinessProfile>('/v1/business').then((b) => {
    setProfile(b);
    setForm({ legalName: b.legalName, tradeName: b.tradeName ?? '', street: b.address.street, city: b.address.city, districtCode: b.address.districtCode, telephone: b.contact.telephone, email: b.contact.email, slug: b.slug });
  }), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = useAction(async () => {
    if (!form || !profile) return;
    const saved = await api<BusinessProfile>('/v1/business', {
      method: 'PUT',
      body: {
        legalName: form.legalName,
        tradeName: form.tradeName || null,
        address: { street: form.street, city: form.city, districtCode: form.districtCode },
        contact: { telephone: form.telephone, email: form.email },
        ...(form.slug !== profile.slug && { slug: form.slug }),
      },
    });
    if (saved.slug !== profile.slug) return goToBusiness(saved.slug, '/settings?tab=business');
    toast(t('Business details saved'));
    await Promise.all([load(), refresh(), refreshMe()]);
  });
  if (!profile || !form) return <div className="skeleton" style={{ height: '12rem' }} />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const cert = me?.certificate;
  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="row">
          <h2>{t('Business details')}</h2>
          <span className="spacer" />
          <span className="small muted">TIN {profile.tin} · {profile.environment === 'test' ? t('Test (no fiscal value)') : t('Production')}</span>
        </div>
        <fieldset disabled={!editable} className="plain stack">
          <div className="form-grid">
            <Field label={t('Registered name')}><input required value={form.legalName} onChange={set('legalName')} /></Field>
            <Field label={t('Trade name')}><input value={form.tradeName} onChange={set('tradeName')} /></Field>
          </div>
          <div className="form-grid">
            <Field label={t('Street')}><input required value={form.street} onChange={set('street')} /></Field>
            <Field label={t('City or town')}><input required value={form.city} onChange={set('city')} /></Field>
            <Field label={t('District')}><select value={form.districtCode} onChange={set('districtCode')}>{DISTRICTS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          </div>
          <div className="form-grid">
            <Field label={t('Telephone')}><input required type="tel" value={form.telephone} onChange={set('telephone')} /></Field>
            <Field label={t('Billing email')}><input required type="email" value={form.email} onChange={set('email')} /></Field>
          </div>
          <Field label={t('Business address')} hint={role === 'owner' ? t('Where your team signs in. Changing it changes the link for everyone; old links stop working.') : t('Where your team signs in. Only an owner can change it.')}>
            <div className="slug-input">
              <span className="mono muted">{window.location.host}/</span>
              <input required disabled={role !== 'owner'} pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
            </div>
          </Field>
        </fieldset>
        <p className="small muted">{t('Changes apply to new documents. Documents already issued keep the details they were signed with. The TIN cannot change.')}</p>
        <ErrorText error={save.error} />
        {editable && <div className="row"><span className="spacer" /><button type="submit" disabled={save.busy}>{save.busy ? t('Saving…') : t('Save business details')}</button></div>}
      </form>
      <section className="card stack">
        <h2>{t('BTS certificate')}</h2>
        {cert ? (
          <div className={`banner ${cert.daysLeft < 30 ? 'warn' : 'ok'}`}>
            <div>
              <strong>{cert.daysLeft < 30 ? t('Expires in {n} days', { n: cert.daysLeft }) : t('Installed')}</strong>
              TIN {cert.tin} · {t('valid until {date}', { date: cert.validTo.slice(0, 10) })}
            </div>
          </div>
        ) : (
          <div className="banner bad"><div><strong>{t('No certificate installed.')}</strong>{t('You cannot issue documents until it is.')}</div></div>
        )}
        {editable ? (
          <details>
            <summary>{cert ? t('Replace or renew the certificate') : t('Install the certificate')}</summary>
            <div style={{ marginTop: '0.75rem' }}><CertificateUpload /></div>
          </details>
        ) : (
          <p className="small muted">{t('Only an owner or admin can change the certificate.')}</p>
        )}
        {profile.environment === 'test' && <p className="small muted">{t('Moving to production is done by our team once BTS has approved your business.')}</p>}
      </section>
    </div>
  );
}

// ---------- users ----------

const signIn = (u: Account) => u.email ?? u.username ?? '';

function RoleSelect({ value, onChange, actor, label }: { value: Role; onChange: (r: Role) => void; actor: Role; label: string }) {
  const t = useT();
  const roles = assignableRoles(actor);
  return (
    <Field label={label} hint={t(ROLE_DESCRIPTION[value])}>
      <select value={value} onChange={(e) => onChange(e.target.value as Role)}>
        {roles.map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}
      </select>
    </Field>
  );
}

/** What to tell the new person, after creating their account. */
function Handover({ result, onDone }: { result: { user: Account; welcomeUrl?: string; emailSent?: boolean; password?: string }; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const address = `${window.location.host}/${session!.business.slug}`;
  const message = result.welcomeUrl
    ? `${t('Your eInvoicing account is ready. Choose your password here:')} ${result.welcomeUrl}`
    : `${t('Your eInvoicing account is ready.')} ${t('Sign in at {address} as {login}.', { address, login: signIn(result.user) })}`;
  return (
    <div className="stack">
      <div className="banner ok" role="status">
        <div>
          <strong>{t('{name} can sign in now', { name: result.user.name })}</strong>
          {result.welcomeUrl
            ? result.emailSent ? t('We emailed them a link to choose their password (valid 7 days). You can also share it:') : t('Share this link with them to choose their password (valid 7 days):')
            : t('Give them these details. They choose their own password when they first sign in.')}
        </div>
      </div>
      {result.welcomeUrl ? (
        <div className="key-reveal mono">{result.welcomeUrl}</div>
      ) : (
        <dl className="facts handover">
          <dt>{t('Address')}</dt><dd className="mono">{address}</dd>
          <dt>{t('Sign-in')}</dt><dd className="mono">{signIn(result.user)}</dd>
          <dt>{t('Temporary password')}</dt><dd className="mono">{result.password}</dd>
        </dl>
      )}
      <div className="row">
        {result.welcomeUrl && <button className="secondary" onClick={() => void navigator.clipboard.writeText(result.welcomeUrl!).then(() => toast(t('Link copied')))}>{t('Copy link')}</button>}
        <a className="button secondary whatsapp" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">WhatsApp</a>
        <span className="spacer" />
        <button onClick={onDone}>{t('Done')}</button>
      </div>
    </div>
  );
}

function AddUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { role } = useSession();
  const [form, setForm] = useState({ name: '', email: '', username: '', role: 'cashier' as Role, how: 'temp' as 'temp' | 'link', password: temporaryPassword() });
  const [result, setResult] = useState<{ user: Account; welcomeUrl?: string; emailSent?: boolean; password?: string } | null>(null);
  const how = form.email ? form.how : 'temp';
  const { run, error, busy } = useAction(async () => {
    const r = await api<{ user: Account; welcomeUrl?: string; emailSent?: boolean }>('/v1/users', {
      method: 'POST',
      body: {
        name: form.name,
        role: form.role,
        ...(form.email && { email: form.email }),
        ...(form.username && { username: form.username }),
        ...(how === 'temp' && { password: form.password }),
      },
    });
    setResult({ ...r, ...(how === 'temp' && { password: form.password }) });
    onSaved();
  });
  return (
    <Modal wide title={result ? t('Account created') : t('Add a user')} onClose={onClose}>
      {result ? <Handover result={result} onDone={onClose} /> : (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(); }}>
          <div className="form-grid">
            <Field label={t('Name')}><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <RoleSelect label={t('Role')} value={form.role} actor={role!} onChange={(r) => setForm({ ...form, role: r })} />
          </div>
          <div className="form-grid">
            <Field label={t('Email')} hint={t('Optional. Lets them reset their own password.')}><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label={t('Username')} hint={t('Optional. For staff without email, e.g. till1.')}><input autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,39}" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
          </div>
          <div className="stack">
            <Segmented
              label={t('Password')}
              value={how}
              onChange={(v) => setForm({ ...form, how: v })}
              options={[['temp', t('Set a temporary password')], ...(form.email ? [['link', t('Email them a link')] as ['link', string]] : [])]}
            />
            {how === 'temp' ? (
              <Field label={t('Temporary password')} hint={t('They must choose their own when they first sign in.')}>
                <div className="row">
                  <input className="mono" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ maxWidth: 260 }} />
                  <button type="button" className="secondary" onClick={() => setForm({ ...form, password: temporaryPassword() })}>{t('New one')}</button>
                </div>
              </Field>
            ) : <p className="small muted">{t('They get an email with a link to choose their password (valid 7 days). You also get the link to share another way.')}</p>}
          </div>
          {!form.email && !form.username && <p className="small muted">{t('Give an email or a username: it is what they sign in with.')}</p>}
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy || (!form.email && !form.username)}>{busy ? t('Creating…') : t('Create account')}</button></div>
        </form>
      )}
    </Modal>
  );
}

function EditUser({ user, onClose, onSaved }: { user: ManagedAccount; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const { role } = useSession();
  const [form, setForm] = useState({ name: user.name, email: user.email ?? '', username: user.username ?? '', role: user.role });
  const { run, error, busy } = useAction(async () => {
    await api(`/v1/users/${user.id}`, {
      method: 'PATCH',
      body: { name: form.name, email: form.email || null, username: form.username || null, ...(form.role !== user.role && { role: form.role }) },
    });
    toast(t('{name} saved', { name: form.name }));
    onSaved();
    onClose();
  });
  return (
    <Modal wide title={t('Edit {name}', { name: user.name })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <div className="form-grid">
          <Field label={t('Name')}><input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <RoleSelect label={t('Role')} value={form.role} actor={role!} onChange={(r) => setForm({ ...form, role: r })} />
        </div>
        <div className="form-grid">
          <Field label={t('Email')}><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={t('Username')}><input autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save')}</button></div>
      </form>
    </Modal>
  );
}

function ResetUserPassword({ user, onClose }: { user: ManagedAccount; onClose: () => void }) {
  const t = useT();
  const [how, setHow] = useState<'temp' | 'link'>(user.email ? 'link' : 'temp');
  const [password, setPassword] = useState(temporaryPassword);
  const [result, setResult] = useState<{ link?: string; emailSent?: boolean; password?: string } | null>(null);
  const { run, error, busy } = useAction(async () => {
    const r = await api<{ link?: string; emailSent?: boolean }>(`/v1/users/${user.id}/password`, { method: 'POST', body: how === 'temp' ? { password } : { sendLink: true } });
    setResult(how === 'temp' ? { password } : r);
  });
  return (
    <Modal title={t('Reset the password of {name}', { name: user.name })} onClose={onClose}>
      {result ? <Handover result={{ user, ...(result.link && { welcomeUrl: result.link }), ...(result.emailSent !== undefined && { emailSent: result.emailSent }), ...(result.password && { password: result.password }) }} onDone={onClose} /> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <p className="small muted">{t('They are signed out everywhere until they set a new password.')}</p>
          <Segmented label={t('Password')} value={how} onChange={setHow} options={[['temp', t('Set a temporary password')], ...(user.email ? [['link', t('Email them a link')] as ['link', string]] : [])]} />
          {how === 'temp' && (
            <Field label={t('Temporary password')}>
              <div className="row">
                <input className="mono" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 260 }} />
                <button type="button" className="secondary" onClick={() => setPassword(temporaryPassword())}>{t('New one')}</button>
              </div>
            </Field>
          )}
          <ErrorText error={error} />
          <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{t('Reset password')}</button></div>
        </form>
      )}
    </Modal>
  );
}

function UsersTab() {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const [users, setUsers] = useState<ManagedAccount[] | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit' | 'password' | 'disable'; user: ManagedAccount } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: ManagedAccount[] }>('/v1/users').then((r) => setUsers(r.data)).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(null);
    try {
      await fn();
      toast(message);
      await load();
    } catch (e) {
      setError(e);
    }
  };
  if (!users) return <div className="skeleton" style={{ height: '10rem' }} />;
  const active = users.filter((u) => u.status === 'active').length;
  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Users')}</h2>
          <p className="small muted">{active === 1 ? t('1 active account.') : t('{n} active accounts.', { n: active })} {t('Accounts belong to this business. Deactivate instead of deleting, so the record of who did what stays complete.')}</p>
        </div>
        <span className="spacer" />
        <button onClick={() => setDialog({ kind: 'add' })}>{t('Add a user')}</button>
      </div>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table className="responsive users">
          <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Sign-in')}</th><th scope="col">{t('Role')}</th><th scope="col">{t('Last sign-in')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.status === 'disabled' ? 'disabled-row' : ''}>
                <td data-label={t('Name')}>
                  <strong>{u.name}</strong>{u.id === session!.user.id && <span className="small muted"> ({t('you')})</span>}
                  {u.status === 'disabled' && <span className="badge cancelled">{t('Deactivated')}</span>}
                  {u.mustChangePassword && u.status === 'active' && <span className="badge pending">{t('Temporary password')}</span>}
                </td>
                <td data-label={t('Sign-in')} className="mono small">{[u.email, u.username].filter(Boolean).join(' · ')}</td>
                <td data-label={t('Role')}><span className={`role-pill ${u.role}`}>{t(ROLE_LABEL[u.role])}</span></td>
                <td data-label={t('Last sign-in')} className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : t('Never')}{u.activeSessions > 0 && <span className="muted"> · {t('{n} signed in', { n: u.activeSessions })}</span>}</td>
                <td className="right actions">
                  {u.manageable && (
                    <>
                      <button className="link" onClick={() => setDialog({ kind: 'edit', user: u })}>{t('Edit')}</button>
                      {u.status === 'active' && <button className="link" onClick={() => setDialog({ kind: 'password', user: u })}>{t('Password')}</button>}
                      {u.status === 'active' && u.activeSessions > 0 && <button className="link" onClick={() => void act(() => api(`/v1/users/${u.id}/sign-out`, { method: 'POST' }), t('{name} was signed out everywhere', { name: u.name }))}>{t('Sign out')}</button>}
                      {u.status === 'active'
                        ? <button className="link danger-link" onClick={() => setDialog({ kind: 'disable', user: u })}>{t('Deactivate')}</button>
                        : <button className="link" onClick={() => void act(() => api(`/v1/users/${u.id}/enable`, { method: 'POST' }), t('{name} reactivated', { name: u.name }))}>{t('Reactivate')}</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="roles-help">
        <summary>{t('What each role can do')}</summary>
        <dl className="facts">
          {(['owner', 'admin', 'manager', 'cashier', 'accountant'] as Role[]).map((r) => <div key={r}><dt>{t(ROLE_LABEL[r])}</dt><dd>{t(ROLE_DESCRIPTION[r])}</dd></div>)}
        </dl>
      </details>

      {dialog?.kind === 'add' && <AddUser onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {dialog?.kind === 'edit' && <EditUser user={dialog.user} onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {dialog?.kind === 'password' && <ResetUserPassword user={dialog.user} onClose={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'disable' && (
        <Modal title={t('Deactivate {name}?', { name: dialog.user.name })} onClose={() => setDialog(null)}>
          <p>{t('They are signed out at once and cannot sign in until reactivated. Documents they issued stay, with their name.')}</p>
          <div className="row">
            <span className="spacer" />
            <button className="secondary" onClick={() => setDialog(null)}>{t('Cancel')}</button>
            <button className="danger" onClick={() => { const u = dialog.user; setDialog(null); void act(() => api(`/v1/users/${u.id}/disable`, { method: 'POST' }), t('{name} deactivated', { name: u.name })); }}>{t('Deactivate')}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------- activity ----------

function describe(t: T, e: AuditEvent): string {
  const target = e.target ?? '';
  const texts: Record<string, string> = {
    login: t('Signed in'),
    'login.failed': t('Failed sign-in as {target}', { target }),
    'business.created': t('Created the business'),
    'business.updated': t('Changed the business details'),
    'password.changed': t('Changed their password'),
    'password.reset_requested': t('Asked for a password reset link'),
    'password.reset': t('Set a password from a link'),
    'user.created': t('Created an account for {target}', { target }),
    'user.updated': t('Changed the account of {target}', { target }),
    'user.disabled': t('Deactivated {target}', { target }),
    'user.enabled': t('Reactivated {target}', { target }),
    'user.password_set': t('Set a temporary password for {target}', { target }),
    'user.password_link_sent': t('Sent a password link to {target}', { target }),
    'user.signed_out': t('Signed {target} out everywhere', { target }),
    'certificate.installed': t('Installed a BTS certificate'),
    'apikey.created': t('Created the API key "{target}"', { target }),
    'apikey.revoked': t('Revoked an API key'),
    'document.cancelled': t('Cancelled document {target}', { target }),
  };
  return texts[e.action] ?? e.action;
}

function changes(t: T, e: AuditEvent): string | null {
  if (!e.details) return null;
  if (e.action === 'document.cancelled') return String(e.details.reason ?? '');
  if (e.action === 'user.created') return t(ROLE_LABEL[e.details.role as Role] ?? '');
  const parts = Object.entries(e.details)
    .filter(([, v]) => v && typeof v === 'object' && 'from' in (v as object))
    .map(([k, v]) => {
      const { from, to } = v as { from: unknown; to: unknown };
      const show = (x: unknown) => (k === 'role' ? t(ROLE_LABEL[x as Role] ?? String(x)) : x === null || x === '' ? '—' : String(x));
      return `${k.replace(/_/g, ' ')}: ${show(from)} → ${show(to)}`;
    });
  return parts.length ? parts.join(' · ') : null;
}

function ActivityTab() {
  const t = useT();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = async (before?: number) => {
    try {
      const r = await api<{ data: AuditEvent[]; nextBefore: number | null }>(`/v1/audit?limit=50${before ? `&before=${before}` : ''}`);
      setEvents((prev) => (before ? [...(prev ?? []), ...r.data] : r.data));
      setNext(r.nextBefore);
    } catch (e) {
      setError(e);
      setEvents([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card stack">
      <div>
        <h2>{t('Activity')}</h2>
        <p className="small muted">{t('Sign-ins, account changes, the certificate, API keys and cancellations. This log cannot be edited or deleted.')}</p>
      </div>
      <ErrorText error={error} />
      {events === null ? <div className="skeleton" style={{ height: '8rem' }} /> : events.length === 0 ? <div className="empty">{t('Nothing yet.')}</div> : (
        <ol className="activity">
          {events.map((e) => (
            <li key={e.id} className={e.action === 'login.failed' ? 'warn' : ''}>
              <time dateTime={e.at} className="mono small muted">{new Date(e.at).toLocaleString()}</time>
              <div>
                <strong>{e.user?.name ?? t('Someone')}</strong> {describe(t, e).charAt(0).toLowerCase() + describe(t, e).slice(1)}
                {changes(t, e) && <div className="small muted">{changes(t, e)}</div>}
              </div>
              {e.ip && <span className="mono small muted ip">{e.ip}</span>}
            </li>
          ))}
        </ol>
      )}
      {next && <button className="secondary" onClick={() => void load(next)}>{t('Load more')}</button>}
    </section>
  );
}

// ---------- API keys ----------

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function ApiKeysTab() {
  const t = useT();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => api<{ data: ApiKeyRow[] }>('/v1/api-keys').then((r) => setKeys(r.data)).catch(setError);
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const k = await api<{ key: string }>('/v1/api-keys', { method: 'POST', body: { name } });
      setRevealed(k.key);
      setName('');
      await load();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card stack">
      <h2>{t('API keys')}</h2>
      <p className="muted small">{t('For your own software: a POS, or a connection to your accounting system. Each key acts as this business.')}</p>
      {revealed && (
        <div className="banner warn">
          <div style={{ width: '100%' }}>
            <strong>{t('Copy this key now. It will not be shown again.')}</strong>
            <div className="key-reveal mono">{revealed}</div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(revealed)}>{t('Copy')}</button>
              <button className="link" onClick={() => setRevealed(null)}>{t("I've saved it")}</button>
            </div>
          </div>
        </div>
      )}
      <form className="row" onSubmit={create}>
        <input placeholder={t('Name, e.g. Front counter POS')} aria-label={t('Key name')} required value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        <button type="submit">{t('Create key')}</button>
      </form>
      <ErrorText error={error} />
      {keys.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Key')}</th><th scope="col">{t('Last used')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-label={t('Name')}>{k.name}</td>
                  <td data-label={t('Key')} className="mono">etd_{k.prefix}_…</td>
                  <td data-label={t('Last used')}>{k.revokedAt ? t('Revoked') : k.lastUsedAt ? k.lastUsedAt.slice(0, 16).replace('T', ' ') : t('Never')}</td>
                  <td className="right">{!k.revokedAt && <button className="link" onClick={() => void api(`/v1/api-keys/${k.id}`, { method: 'DELETE' }).then(load).catch(setError)}>{t('Revoke')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- the page ----------

type Tab = 'account' | 'business' | 'users' | 'activity' | 'keys';

export function Settings() {
  const t = useT();
  usePageTitle(t('Settings'));
  const { session, can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs: Array<[Tab, string]> = [
    ['account', t('My account')],
    ['business', t('Business')],
    ...(can('users.manage') ? [['users', t('Users')] as [Tab, string]] : []),
    ...(can('audit.view') ? [['activity', t('Activity')] as [Tab, string]] : []),
    ...(can('apikeys.manage') ? [['keys', t('API keys')] as [Tab, string]] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = tabs.some(([k]) => k === requested) ? requested! : 'account';
  if (!session) return null;
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{session.business.tradeName ?? session.business.legalName}</span><h1>{t('Settings')}</h1></div>
        <span className="spacer" />
        <Segmented label={t('Settings')} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={tabs} />
      </div>
      {tab === 'account' && <AccountTab />}
      {tab === 'business' && <BusinessTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'keys' && <ApiKeysTab />}
    </div>
  );
}
