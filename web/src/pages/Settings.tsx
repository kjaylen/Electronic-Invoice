import { type FormEvent, useEffect, useState } from 'react';
import { api, type Invitation, type Role, type TeamMember } from '../api';
import { useI18n, useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, Segmented, usePageTitle } from '../ui';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Upload the BTS certificate (.pfx/.p12 and its password). Owners only; the server checks too. */
export function CertificateUpload({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const { refresh } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/certificate/pfx', { method: 'POST', body: { pfxBase64: await readAsBase64(file), password } });
      setDone(true);
      await refresh();
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="banner ok" role="status"><div><strong>{t('Certificate installed.')}</strong>{t('You can issue documents now.')}</div></div>;
  return (
    <form className="stack" onSubmit={submit}>
      <Field label={t('Certificate file')} hint={t('.pfx or .p12, from the BTS portal.')}>
        <input type="file" accept=".pfx,.p12,application/x-pkcs12" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label={t('Certificate password')}><input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorText error={error} />
      <button type="submit" disabled={busy || !file}>{busy ? t('Installing…') : t('Install certificate')}</button>
    </form>
  );
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function ApiKeys() {
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
    <div className="stack">
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
                  <td className="right">
                    {!k.revokedAt && <button className="link" onClick={() => void api(`/v1/api-keys/${k.id}`, { method: 'DELETE' }).then(load).catch(setError)}>{t('Revoke')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Team({ owner }: { owner: boolean }) {
  const t = useT();
  const toast = useToast();
  const { session, refresh } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState<{ email: string; role: Role }>({ email: '', role: 'member' });
  const [link, setLink] = useState<{ url: string; emailSent: boolean; email: string } | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<{ members: TeamMember[]; invitations: Invitation[] }>('/v1/team').then((r) => {
    setMembers(r.members);
    setInvitations(r.invitations);
  }).catch(setError);
  useEffect(() => {
    void load();
  }, []);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ inviteUrl: string; emailSent: boolean }>('/v1/team/invitations', { method: 'POST', body: invite });
      setLink({ url: r.inviteUrl, emailSent: r.emailSent, email: invite.email });
      setInvite({ email: '', role: 'member' });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (m: TeamMember, role: Role) => {
    setError(null);
    try {
      await api(`/v1/team/members/${m.userId}`, { method: 'PATCH', body: { role } });
      toast(t('{name} is now {role}', { name: m.name, role: role === 'owner' ? t('an owner') : t('a team member') }));
      await load();
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setError(null);
    try {
      await api(`/v1/team/members/${removing.userId}`, { method: 'DELETE' });
      const self = removing.userId === session?.user.id;
      setRemoving(null);
      if (self) return void refresh();
      toast(t('{name} removed', { name: removing.name }));
      await load();
    } catch (err) {
      setError(err);
      setRemoving(null);
    }
  };

  return (
    <div className="stack">
      <p className="muted small">{t('Owners manage the certificate, API keys and the team. Members issue and send documents.')}</p>
      <div className="table-wrap">
        <table className="responsive">
          <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Email')}</th><th scope="col">{t('Role')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td data-label={t('Name')}>{m.name}{m.userId === session?.user.id && <span className="small muted"> ({t('you')})</span>}</td>
                <td data-label={t('Email')}>{m.email}</td>
                <td data-label={t('Role')}>
                  {owner ? (
                    <select aria-label={t('Role of {name}', { name: m.name })} value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)} style={{ maxWidth: 160 }}>
                      <option value="owner">{t('Owner')}</option>
                      <option value="member">{t('Member')}</option>
                    </select>
                  ) : m.role === 'owner' ? t('Owner') : t('Member')}
                </td>
                <td className="right">
                  {(owner || m.userId === session?.user.id) && <button className="link" onClick={() => setRemoving(m)}>{m.userId === session?.user.id ? t('Leave') : t('Remove')}</button>}
                </td>
              </tr>
            ))}
            {invitations.map((i) => (
              <tr key={i.id} className="pending-row">
                <td data-label={t('Name')} className="muted">{t('Invited')}</td>
                <td data-label={t('Email')}>{i.email}</td>
                <td data-label={t('Role')}>{i.role === 'owner' ? t('Owner') : t('Member')}</td>
                <td className="right"><button className="link" onClick={() => void api(`/v1/team/invitations/${i.id}`, { method: 'DELETE' }).then(load).catch(setError)}>{t('Withdraw')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorText error={error} />
      {owner && <div><button onClick={() => { setLink(null); setInviting(true); }}>{t('Invite someone')}</button></div>}

      {inviting && (
        <Modal title={t('Invite someone to this business')} onClose={() => setInviting(false)}>
          {link ? (
            <div className="stack">
              <div className="banner ok" role="status"><div><strong>{link.emailSent ? t('Invitation sent to {email}', { email: link.email }) : t('Invitation ready')}</strong>{t('You can also share this link. It works once, for 7 days.')}</div></div>
              <div className="key-reveal mono">{link.url}</div>
              <div className="row">
                <button className="secondary" onClick={() => void navigator.clipboard.writeText(link.url).then(() => toast(t('Link copied')))}>{t('Copy link')}</button>
                <a className="button secondary whatsapp" href={`https://wa.me/?text=${encodeURIComponent(`${t('Join our business on eInvoicing:')} ${link.url}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
                <span className="spacer" />
                <button onClick={() => setInviting(false)}>{t('Done')}</button>
              </div>
            </div>
          ) : (
            <form className="stack" onSubmit={send}>
              <Field label={t('Email')}><input type="email" required autoFocus value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
              <Segmented label={t('Role')} value={invite.role} onChange={(role) => setInvite({ ...invite, role })} options={[['member', t('Member')], ['owner', t('Owner')]]} />
              <p className="small muted">{invite.role === 'owner' ? t('Owners can do everything, including managing the certificate and the team.') : t('Members can issue, send and cancel documents, and manage customers and items.')}</p>
              <ErrorText error={error} />
              <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setInviting(false)}>{t('Cancel')}</button><button type="submit" disabled={busy}>{busy ? t('Sending…') : t('Send invitation')}</button></div>
            </form>
          )}
        </Modal>
      )}
      {removing && (
        <Modal title={removing.userId === session?.user.id ? t('Leave this business?') : t('Remove {name}?', { name: removing.name })} onClose={() => setRemoving(null)}>
          <p>{removing.userId === session?.user.id ? t('You will lose access to this business until someone invites you again.') : t('They lose access to this business immediately. Documents they issued stay.')}</p>
          <div className="row"><span className="spacer" /><button className="secondary" onClick={() => setRemoving(null)}>{t('Cancel')}</button><button className="danger" onClick={() => void remove()}>{removing.userId === session?.user.id ? t('Leave') : t('Remove')}</button></div>
        </Modal>
      )}
    </div>
  );
}

function ChangePassword() {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast(t('Password changed. Other devices were signed out.'));
      setOpen(false);
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="secondary" onClick={() => setOpen(true)}>{t('Change password')}</button>
      {open && (
        <Modal title={t('Change password')} onClose={() => setOpen(false)}>
          <form className="stack" onSubmit={submit}>
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

export function Settings() {
  const { t, lang, setLang } = useI18n();
  usePageTitle(t('Settings'));
  const { me, session, role } = useSession();
  if (!me || !session) return null;
  const owner = role === 'owner';
  const cert = me.certificate;
  return (
    <div className="stack">
      <div><span className="kicker">{t('Business')}</span><h1>{t('Settings')}</h1></div>
      <div className="grid">
        <section className="card">
          <h2>{t('Business')}</h2>
          <p><strong>{me.legalName}</strong>{me.tradeName && <> · {me.tradeName}</>}</p>
          <p>TIN {me.tin}</p>
          <p>{t('BTS environment')}: <strong>{me.environment === 'test' ? t('Test (no fiscal value)') : t('Production')}</strong></p>
          {me.environment === 'test' && <p className="small muted">{t('Moving to production is done by our team once BTS has approved your business.')}</p>}
        </section>
        <section className="card stack">
          <h2>{t('Your account')}</h2>
          <div>
            <p>{session.user.name}</p>
            <p className="muted">{session.user.email}</p>
            <p className="small muted">{t('Role in this business')}: {owner ? t('Owner') : t('Member')}</p>
          </div>
          <Segmented label={t('Language')} value={lang} onChange={setLang} options={[['en', 'English'], ['es', 'Español']]} />
          <div><ChangePassword /></div>
        </section>
      </div>
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
        {owner ? (
          <details>
            <summary>{cert ? t('Replace or renew the certificate') : t('Install the certificate')}</summary>
            <div style={{ marginTop: '0.75rem' }}><CertificateUpload /></div>
          </details>
        ) : (
          <p className="small muted">{t('Only an owner can change the certificate.')}</p>
        )}
      </section>
      <section className="card stack">
        <h2>{t('Team')}</h2>
        <Team owner={owner} />
      </section>
      {owner && (
        <section className="card stack">
          <h2>{t('API keys')}</h2>
          <ApiKeys />
        </section>
      )}
    </div>
  );
}
