/**
 * Tills in the web app: add one and pair the app with a code (or its QR
 * code), see what each till runs and has plugged in, rename or move it to
 * another cash drawer, remove it. And PINs: your own, and your team's.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Account } from '../api';
import { useSession } from '../session';
import { useT } from '../i18n';
import { qrSvg } from '../pos/ticket';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, Select } from '../ui';

interface TillHardware {
  device?: string;
  printers?: Array<{ name: string; connection: string; where?: string; paperWidth?: number; drawer?: boolean; receipts?: boolean }>;
  scanner?: { keyboard?: boolean; camera?: boolean };
  customerDisplay?: boolean;
}

interface Till {
  id: string;
  name: string;
  register: { id: string; name: string };
  status: 'waiting' | 'paired' | 'removed';
  platform: string | null;
  appVersion: string | null;
  hardware: TillHardware | null;
  createdAt: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  openShift: { number: number; openedBy: string; openedAt: string } | null;
  signedIn: string[];
}

interface Pairing { code: string; expiresAt: string }

const PLATFORM: Record<string, string> = { ios: 'iPhone / iPad', android: 'Android', desktop: 'Desktop app', web: 'Browser' };
const CONNECTION: Record<string, string> = { network: 'network', bluetooth: 'Bluetooth', system: 'USB / installed', browser: 'browser' };

function ago(t: (s: string, v?: Record<string, string | number>) => string, iso: string | null): string {
  if (!iso) return t('never');
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 2) return t('just now');
  if (min < 60) return t('{n} minutes ago', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('{n} hours ago', { n: h });
  return new Date(iso).toLocaleDateString();
}

/** How selling at the counter and on tills works: a cashier's discount limit, US$ totals, a service charge, tips. */
function CounterSettingsCard() {
  const t = useT();
  const toast = useToast();
  const { me, refreshMe } = useSession();
  const current = me?.counter?.cashierDiscountLimit ?? null;
  const [limit, setLimit] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setLimit(current ?? ''), [current]);
  const valid = limit === '' || (/^\d{1,3}(\.\d{1,2})?$/.test(limit) && Number(limit) <= 100);
  // For shops that sell to visitors, and for bars and restaurants.
  const saved = { showUsd: Boolean(me?.counter?.showUsd), service: me?.counter?.serviceChargePercent ?? '', tips: Boolean(me?.counter?.tips) };
  const [showUsd, setShowUsd] = useState(saved.showUsd);
  const [service, setService] = useState(saved.service);
  const [tips, setTips] = useState(saved.tips);
  useEffect(() => {
    setShowUsd(saved.showUsd);
    setService(saved.service);
    setTips(saved.tips);
  }, [saved.showUsd, saved.service, saved.tips]);
  const serviceValid = service === '' || (/^\d{1,2}(\.\d{1,2})?$/.test(service) && Number(service) > 0 && Number(service) <= 30);
  const extrasChanged = showUsd !== saved.showUsd || service !== saved.service || tips !== saved.tips;
  const saveExtras = async (e: FormEvent) => {
    e.preventDefault();
    if (!serviceValid) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/counter-settings', { method: 'PUT', body: { showUsd, serviceChargePercent: service === '' ? null : service, tips } });
      await refreshMe();
      toast(t('Counter settings saved. Tills pick them up within a few minutes.'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/counter-settings', { method: 'PUT', body: { cashierDiscountLimit: limit === '' ? null : limit } });
      await refreshMe();
      toast(limit === '' ? t('Cashiers can give any discount.') : t('Cashiers can take up to {n}% off.', { n: limit }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <div>
        <h2>{t('Counter')}</h2>
        <p className="small muted">{t('Discounts at the counter and on the tills. Managers, admins and owners can always give any discount; every discount shows on the receipt and in the shift report.')}</p>
      </div>
      <form className="row counter-settings" onSubmit={save}>
        <Field label={t('Most a cashier can take off a line (%)')} hint={t('Empty: no limit')}>
          <input inputMode="decimal" placeholder={t('No limit')} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
        <button type="submit" disabled={!valid || busy || limit === (current ?? '')}>{busy ? t('Saving…') : t('Save')}</button>
      </form>
      {!valid && <p className="form-error">{t('0 to 100, or empty')}</p>}
      <form className="stack counter-extras" onSubmit={saveExtras}>
        <label className="check">
          <input type="checkbox" checked={showUsd} onChange={(e) => setShowUsd(e.target.checked)} />
          <span>
            <strong>{t('Show totals in US dollars too')}</strong>
            <span className="small muted">{t('For shops that sell to visitors: the total in US$ (BZ$2 to US$1) on the till, the customer display and the printed receipt.')}</span>
          </span>
        </label>
        <Field label={t('Service charge (%)')} hint={t('For bars and restaurants, usually 10. A cashier adds it to a sale with one tap; it is on the receipt, and GST applies to it. Empty: none.')}>
          <input inputMode="decimal" placeholder={t('None')} value={service} onChange={(e) => setService(e.target.value)} className="narrow-input" />
        </Field>
        {!serviceValid && <p className="form-error">{t('Up to 30, or empty')}</p>}
        <label className="check">
          <input type="checkbox" checked={tips} onChange={(e) => setTips(e.target.checked)} />
          <span>
            <strong>{t('Take tips with card and wallet payments')}</strong>
            <span className="small muted">{t('The cashier types the tip the customer adds. It is never on the receipt or in your sales; the shift report says how much to pay out to staff.')}</span>
          </span>
        </label>
        <div><button type="submit" disabled={!serviceValid || busy || !extrasChanged}>{busy ? t('Saving…') : t('Save')}</button></div>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

export function TillsTab() {
  return (
    <div className="stack">
      <CounterSettingsCard />
      <TillsCard />
    </div>
  );
}

function TillsCard() {
  const t = useT();
  const toast = useToast();
  const [tills, setTills] = useState<Till[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'code'; till: Till; pairing: Pairing } | { kind: 'edit' | 'remove'; till: Till } | null>(null);
  const load = useCallback(() => api<{ data: Till[] }>('/v1/pos/devices').then((r) => setTills(r.data)).catch(setError), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);
  const newCode = async (till: Till) => {
    try {
      const r = await api<{ device: Till; pairing: Pairing }>(`/v1/pos/devices/${till.id}/code`, { method: 'POST' });
      setDialog({ kind: 'code', till: r.device, pairing: r.pairing });
    } catch (e) {
      setError(e);
    }
  };
  const remove = async (till: Till) => {
    setDialog(null);
    try {
      await api(`/v1/pos/devices/${till.id}`, { method: 'DELETE' });
      toast(t('{name} removed', { name: till.name }));
      void load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Tills')}</h2>
          <p className="small muted">{t('The till apps for iPhone, iPad, Android, Windows, Mac and Linux. Each till has its own cash drawer; people sign in on it with their PIN. Add a till here, then pair the app with the code.')}</p>
        </div>
        <span className="spacer" />
        <button type="button" onClick={() => setDialog({ kind: 'add' })}>{t('Add a till')}</button>
      </div>
      <p className="small">{t('No app at hand? Any browser works as a till:')} <a href="/pos" target="_blank" rel="noreferrer" className="mono">{window.location.origin}/pos</a></p>
      <ErrorText error={error} />
      {tills && tills.length === 0 && <p className="muted">{t('No tills yet.')}</p>}
      <ul className="till-admin-list">
        {tills?.map((d) => (
          <li key={d.id} className="card-inset stack">
            <div className="row">
              <div>
                <strong>{d.name}</strong>
                <span className="small muted"> · {t('Cash drawer')}: {d.register.name}</span>
              </div>
              <span className="spacer" />
              {d.status === 'waiting'
                ? <span className="badge pending">{t('Waiting to pair')}</span>
                : <span className={`badge ${d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 15 * 60_000 ? 'authorized' : 'cancelled'}`}>{t('Seen {when}', { when: ago(t, d.lastSeenAt) })}</span>}
            </div>
            {d.status === 'paired' && (
              <p className="small">
                {d.platform && <>{t(PLATFORM[d.platform] ?? d.platform)}{d.appVersion && d.appVersion !== 'web' ? ` ${d.appVersion}` : ''} · </>}
                {d.openShift ? t('Shift #{n} open by {name}', { n: d.openShift.number, name: d.openShift.openedBy }) : t('No shift open')}
                {d.signedIn.length > 0 && <> · {t('Signed in: {names}', { names: d.signedIn.join(', ') })}</>}
              </p>
            )}
            {d.hardware && (
              <p className="small muted">
                {d.hardware.printers?.length
                  ? d.hardware.printers.map((p) => `${p.name} (${t(CONNECTION[p.connection] ?? p.connection)}${p.paperWidth ? `, ${p.paperWidth} mm` : ''}${p.drawer ? `, ${t('cash drawer')}` : ''})`).join(' · ')
                  : t('No receipt printer set up')}
                {d.hardware.scanner && (d.hardware.scanner.keyboard || d.hardware.scanner.camera) && <> · {t('Scanner')}: {[d.hardware.scanner.keyboard && t('USB/Bluetooth'), d.hardware.scanner.camera && t('camera')].filter(Boolean).join(', ')}</>}
                {d.hardware.customerDisplay && <> · {t('Customer display')}</>}
              </p>
            )}
            <div className="row">
              <button type="button" className={d.status === 'waiting' ? 'small-button' : 'secondary small-button'} onClick={() => void newCode(d)}>{d.status === 'waiting' ? t('Show pairing code') : t('Pair again')}</button>
              <button type="button" className="link" onClick={() => setDialog({ kind: 'edit', till: d })}>{t('Rename or move')}</button>
              <button type="button" className="link danger-link" onClick={() => setDialog({ kind: 'remove', till: d })}>{t('Remove')}</button>
            </div>
          </li>
        ))}
      </ul>

      {dialog?.kind === 'add' && <AddTill tills={tills ?? []} onClose={() => setDialog(null)} onAdded={(till, pairing) => { void load(); setDialog({ kind: 'code', till, pairing }); }} />}
      {dialog?.kind === 'code' && <PairingCode till={dialog.till} pairing={dialog.pairing} onClose={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'edit' && <EditTill till={dialog.till} tills={tills ?? []} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'remove' && (
        <Modal title={t('Remove {name}?', { name: dialog.till.name })} onClose={() => setDialog(null)}>
          <div className="stack">
            <p>{t('The app on it stops working at once and everyone signed in on it is signed out. Its sales and shifts stay. To use the device again, add it as a new till.')}</p>
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setDialog(null)}>{t('Cancel')}</button><button type="button" className="danger" onClick={() => void remove(dialog.till)}>{t('Remove')}</button></div>
          </div>
        </Modal>
      )}
    </section>
  );
}

interface Register { id: string; name: string }

function RegisterSelect({ value, onChange, tills, current }: { value: string; onChange: (v: string) => void; tills: Till[]; current?: string }) {
  const t = useT();
  const [registers, setRegisters] = useState<Register[]>([]);
  useEffect(() => void api<{ data: Register[] }>('/v1/registers').then((r) => setRegisters(r.data)).catch(() => {}), []);
  const taken = new Set(tills.filter((x) => x.register.id !== current).map((x) => x.register.id));
  return (
    <Field label={t('Cash drawer')} hint={t('Each till sells into its own drawer, counted at the end of each shift.')}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{current ? t('Keep the current drawer') : t('A new drawer named like the till')}</option>
        {registers.filter((r) => !taken.has(r.id) && r.id !== current).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
    </Field>
  );
}

function AddTill({ tills, onClose, onAdded }: { tills: Till[]; onClose: () => void; onAdded: (till: Till, pairing: Pairing) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [registerId, setRegisterId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ device: Till; pairing: Pairing }>('/v1/pos/devices', { method: 'POST', body: { name: name.trim(), ...(registerId && { registerId }) } });
      onAdded(r.device, r.pairing);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Add a till')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Field label={t('Name')}><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Front counter, Bar, Tablet 2')} autoFocus /></Field>
        <RegisterSelect value={registerId} onChange={setRegisterId} tills={tills} />
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !name.trim()}>{t('Add and get a pairing code')}</button></div>
      </form>
    </Modal>
  );
}

function PairingCode({ till, pairing, onClose }: { till: Till; pairing: Pairing; onClose: () => void }) {
  const t = useT();
  const link = `${window.location.origin}/pos?pair=${pairing.code}`;
  return (
    <Modal title={t('Pair {name}', { name: till.name })} onClose={onClose}>
      <div className="stack pairing">
        <p>{t('In the till app, tap "Scan the QR code", or type the code. The code works once, for 30 minutes.')}</p>
        <div className="pairing-box">
          <div className="pairing-qr" dangerouslySetInnerHTML={{ __html: qrSvg(link, 44) }} role="img" aria-label={t('QR code to pair the till')} />
          <div className="stack">
            <span className="kicker">{t('Pairing code')}</span>
            <div className="pairing-code mono">{pairing.code}</div>
            <span className="small muted">{t('Until {time}', { time: new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>
          </div>
        </div>
        <p className="small muted">{t('On a computer or tablet without the app, open this link in its browser:')} <span className="mono">{link}</span></p>
        <div className="row"><span className="spacer" /><button type="button" onClick={onClose}>{t('Done')}</button></div>
      </div>
    </Modal>
  );
}

function EditTill({ till, tills, onClose, onSaved }: { till: Till; tills: Till[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState(till.name);
  const [registerId, setRegisterId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/pos/devices/${till.id}`, { method: 'PATCH', body: { name: name.trim(), ...(registerId && { registerId }) } });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Rename or move {name}', { name: till.name })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <Field label={t('Name')}><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <RegisterSelect value={registerId} onChange={setRegisterId} tills={tills} current={till.register.id} />
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !name.trim()}>{t('Save')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- PINs ----------

const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);

/** Set a PIN (yours with no user, or someone's). */
function PinForm({ user, onDone, onCancel }: { user?: Account & { hasPin?: boolean }; onDone: () => void; onCancel?: () => void }) {
  const t = useT();
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const path = user ? `/v1/users/${user.id}/pin` : '/v1/me/pin';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pin !== again) return setError(new Error(t('The two PINs are not the same')));
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'PUT', body: { pin } });
      toast(user ? t('PIN set for {name}', { name: user.name }) : t('Your PIN is set'));
      setPin('');
      setAgain('');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="form-grid">
        <Field label={t('New PIN')} hint={t('4 to 8 digits, not 1234 or 1111.')}><input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(digits(e.target.value))} required minLength={4} /></Field>
        <Field label={t('PIN again')}><input type="password" inputMode="numeric" autoComplete="off" value={again} onChange={(e) => setAgain(digits(e.target.value))} required minLength={4} /></Field>
      </div>
      <ErrorText error={error} />
      <div className="row">
        {onCancel && <button type="button" className="secondary" onClick={onCancel}>{t('Cancel')}</button>}
        <span className="spacer" />
        <button disabled={busy || pin.length < 4}>{t('Set PIN')}</button>
      </div>
    </form>
  );
}

/** "My account": the PIN for signing in on tills. */
export function PinCard({ hasPin, onChanged }: { hasPin: boolean; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  return (
    <section className="card stack">
      <h2>{t('Till PIN')}</h2>
      <p className="small muted">{hasPin ? t('You have a PIN for signing in on this business’s tills. Changing it signs you out of every till.') : t('Set a PIN to sign in on this business’s tills (the iOS, Android and desktop apps).')}</p>
      {editing ? <PinForm onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /> : (
        <div className="row">
          <button type="button" className={hasPin ? 'secondary' : ''} onClick={() => setEditing(true)}>{hasPin ? t('Change PIN') : t('Set a PIN')}</button>
          {hasPin && <button type="button" className="link danger-link" onClick={() => void api('/v1/me/pin', { method: 'DELETE' }).then(() => { toast(t('PIN removed')); onChanged(); })}>{t('Remove PIN')}</button>}
        </div>
      )}
    </section>
  );
}

/** Users: set or remove someone's PIN. */
export function UserPinDialog({ user, onClose }: { user: Account & { hasPin?: boolean }; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title={t('Till PIN for {name}', { name: user.name })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{user.hasPin ? t('They have a PIN. Set a new one if they forgot it; they are signed out of every till.') : t('Set a PIN for them, or let them set their own on a till with their password.')}</p>
        <PinForm user={user} onDone={onClose} onCancel={onClose} />
        {user.hasPin && (
          <button type="button" className="link danger-link" onClick={() => void api(`/v1/users/${user.id}/pin`, { method: 'DELETE' }).then(() => { toast(t('PIN removed for {name}', { name: user.name })); onClose(); }).catch(setError)}>
            {t('Remove their PIN')}
          </button>
        )}
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}
