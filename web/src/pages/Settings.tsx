import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { ErrorText, Field } from '../ui';

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

  if (done) return <div className="banner ok"><div><strong>Certificate installed.</strong>You can issue documents now.</div></div>;
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Certificate file" hint=".pfx or .p12, from the BTS portal.">
        <input type="file" accept=".pfx,.p12,application/x-pkcs12" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Certificate password"><input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorText error={error} />
      <button type="submit" disabled={busy || !file}>{busy ? 'Installing…' : 'Install certificate'}</button>
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
      <p className="muted small">For your own software: a POS, or a connection to your accounting system. Each key acts as this business.</p>
      {revealed && (
        <div className="banner warn">
          <div style={{ width: '100%' }}>
            <strong>Copy this key now. It will not be shown again.</strong>
            <div className="key-reveal mono">{revealed}</div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(revealed)}>Copy</button>
              <button className="link" onClick={() => setRevealed(null)}>I've saved it</button>
            </div>
          </div>
        </div>
      )}
      <form className="row" onSubmit={create}>
        <input placeholder="Name, e.g. Front counter POS" required value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        <button type="submit">Create key</button>
      </form>
      <ErrorText error={error} />
      {keys.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-label="Name">{k.name}</td>
                  <td data-label="Key" className="mono">etd_{k.prefix}_…</td>
                  <td data-label="Last used">{k.revokedAt ? 'Revoked' : k.lastUsedAt ? k.lastUsedAt.slice(0, 16).replace('T', ' ') : 'Never'}</td>
                  <td className="right">
                    {!k.revokedAt && (
                      <button className="link" onClick={() => void api(`/v1/api-keys/${k.id}`, { method: 'DELETE' }).then(load).catch(setError)}>Revoke</button>
                    )}
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

export function Settings() {
  const { me, session } = useSession();
  if (!me || !session) return null;
  const owner = session.businesses.find((b) => b.id === session.currentBusinessId)?.role === 'owner';
  const cert = me.certificate;
  return (
    <div className="stack">
      <div><span className="kicker">Business</span><h1>Settings</h1></div>
      <div className="grid">
        <section className="card">
          <h2>Business</h2>
          <p><strong>{me.legalName}</strong>{me.tradeName && <> · {me.tradeName}</>}</p>
          <p>TIN {me.tin}</p>
          <p>BTS environment: <strong>{me.environment === 'test' ? 'Test (no fiscal value)' : 'Production'}</strong></p>
          {me.environment === 'test' && <p className="small muted">Moving to production is done by our team once BTS has approved your business.</p>}
        </section>
        <section className="card">
          <h2>Your account</h2>
          <p>{session.user.name}</p>
          <p className="muted">{session.user.email}</p>
          <p className="small muted">Role in this business: {owner ? 'Owner' : 'Member'}</p>
        </section>
      </div>
      <section className="card stack">
        <h2>BTS certificate</h2>
        {cert ? (
          <div className={`banner ${cert.daysLeft < 30 ? 'warn' : 'ok'}`}>
            <div>
              <strong>{cert.daysLeft < 30 ? `Expires in ${cert.daysLeft} days` : 'Installed'}</strong>
              TIN {cert.tin} · valid until {cert.validTo.slice(0, 10)}
            </div>
          </div>
        ) : (
          <div className="banner bad"><div><strong>No certificate installed.</strong>You cannot issue documents until it is.</div></div>
        )}
        {owner ? (
          <details>
            <summary>{cert ? 'Replace or renew the certificate' : 'Install the certificate'}</summary>
            <div style={{ marginTop: '0.75rem' }}><CertificateUpload /></div>
          </details>
        ) : (
          <p className="small muted">Only an owner can change the certificate.</p>
        )}
      </section>
      {owner && (
        <section className="card stack">
          <h2>API keys</h2>
          <ApiKeys />
        </section>
      )}
    </div>
  );
}
