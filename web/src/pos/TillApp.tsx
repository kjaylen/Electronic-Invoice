/**
 * The till: pair it once with a code from the web app, then people sign in
 * with a PIN and sell. It locks itself after a few idle minutes. Runs in the
 * iOS, Android and desktop apps and in a browser at /pos.
 *
 * Offline first (pos/offline): the till sells from its own copy of the
 * catalog, makes each Tax Receipt on the device and sends it to the server
 * when it can. It needs the internet once, when it is set up; after that a
 * lost connection only shows in the indicator at the top.
 */

import { createContext, type FormEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, apiBlob, type Account, type Me, type Permission, type Role, setTillTransport, UNAUTHORIZED_EVENT } from '../api';
import { LanguagePicker, useT } from '../i18n';
import { VenueFloor } from '../venue/Floor';
import { KitchenScreen } from '../venue/Kitchen';
import { SessionContext, type SessionState } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, usdOf } from '../ui';
import { HardwareSettings } from './Devices';
import { type HardwareConfig, hardwareReport, HardwareError, loadHardware, openDrawer as kickDrawer, type PrinterConfig, printTicket as sendTicket, saveHardware } from './hardware';
import { browserCanScan, type Platform, platform as getPlatform } from './platform';
import { Sales } from './Sales';
import { Sell } from './Sell';
import { ShiftPanel } from './ShiftPanel';
import { type DocumentView, documentTicket, type Ticket } from './ticket';
import { ticketLogo } from './logo';
import { CameraScanner } from './CameraScanner';
import { ConnectivityContext } from '../connectivity';
import { Banner, Icon, useNow } from './design/components';
import { feedback } from './design/feedback';
import type { PosIconName } from './design/icons';
import { offlineTill, type OfflineTill, type SignedInInfo } from './offline/till';
import { type TillUpdate, useTillUpdate } from './updates';
import { SyncIndicator, SyncScreen, useSyncState } from './offline/status';
import type { Snapshot } from './offline/types';

export interface TillInfo {
  business: { slug: string; name: string; tin: string; environment: string };
  device: { id: string; name: string; register: { id: string; name: string } };
  users: Array<{ id: string; name: string; role: Role; hasPin: boolean }>;
}

type SignedIn = SignedInInfo;

interface TillContextValue {
  platform: Platform;
  server: string;
  till: TillInfo;
  hardware: HardwareConfig;
  setHardware: (h: HardwareConfig) => Promise<void>;
  user: SignedIn['user'];
  can: (p: Permission) => boolean;
  /** Owners, admins and managers set up the till's hardware. */
  isManager: boolean;
  receiptPrinter: PrinterConfig | null;
  printDocument: (id: string, options?: { copy?: boolean; openDrawer?: boolean }) => Promise<void>;
  printTicket: (ticket: Ticket, options?: { openDrawer?: boolean; title?: string }) => Promise<void>;
  openDrawer: () => Promise<void>;
  lock: () => void;
  unpair: () => Promise<void>;
  /** The till's offline side (null where the device cannot keep data). */
  offline: OfflineTill | null;
  /** Read a barcode with the camera, where the device has one. */
  scanWithCamera: (() => Promise<string | null>) | null;
  /** A newer till app, ready to install (desktop) or to download (Android). */
  update: TillUpdate;
  /** Asks first, then restarts into the update (desktop) or opens the download (Android). */
  offerUpdate: () => void;
}

const TillContext = createContext<TillContextValue | null>(null);
export const useTill = () => {
  const v = useContext(TillContext);
  if (!v) throw new Error('useTill outside the till');
  return v;
};

const SERVER = 'till.server';
const TOKEN = 'till.token';

/** "app.example.bz" -> "https://app.example.bz" */
function normalizeServer(s: string): string {
  const v = s.trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** A pairing QR code holds the till page's address with the code: https://app.example.bz/pos?pair=ABCD-EFGH */
function readPairingLink(text: string): { server: string; code: string } | null {
  try {
    const u = new URL(text.trim());
    const code = u.searchParams.get('pair');
    return code ? { server: u.origin, code } : null;
  } catch {
    return null;
  }
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'pair'; server: string }
  | { kind: 'unreachable'; server: string; token: string; error: unknown }
  /** Removed from the business with sales not sent yet: they wait here until it is paired again. */
  | { kind: 'removed'; server: string; unsent: number }
  | { kind: 'lock'; server: string; token: string; till: TillInfo }
  | { kind: 'till'; server: string; token: string; till: TillInfo; session: SignedIn };

const tillFrom = (s: Snapshot): TillInfo => ({
  business: { slug: s.business.slug, name: s.business.name, tin: s.business.tin, environment: s.business.environment },
  device: s.device,
  users: s.users.map((u) => ({ id: u.id, name: u.name, role: u.role, hasPin: u.hasPin })),
});

/** The till's token: in the platform's secure storage where there is one (moved there from plain storage once). */
async function savedToken(pl: Platform): Promise<string | null> {
  const plain = await pl.getItem(TOKEN);
  if (!pl.secret) return plain;
  const kept = await pl.secret.get(TOKEN).catch(() => null);
  if (kept) return kept;
  if (plain) {
    await pl.secret.set(TOKEN, plain);
    if ((await pl.secret.get(TOKEN)) === plain && pl.kind !== 'desktop') await pl.removeItem(TOKEN);
  }
  return plain;
}
const saveToken = async (pl: Platform, token: string) => (pl.secret ? pl.secret.set(TOKEN, token) : pl.setItem(TOKEN, token));
const removeToken = async (pl: Platform) => {
  await pl.secret?.remove(TOKEN).catch(() => {});
  await pl.removeItem(TOKEN);
};

export function TillApp() {
  const t = useT();
  const toast = useToast();
  const [p, setPlatform] = useState<Platform | null>(null);
  const [hardware, setHardwareState] = useState<HardwareConfig | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [offline, setOffline] = useState<OfflineTill | null>(null);
  const session = useRef<string | null>(null);
  const device = useRef<string | null>(null);
  // Signed in without the server: the PIN, in memory only, to sign in with the server when it is back.
  const pinForUpgrade = useRef<string | null>(null);
  const sync = useSyncState(offline);

  // Every call goes to the till's own API first (offline first), then the till's server:
  // as the person once signed in, as the till before.
  const useServer = useCallback((server: string, token: string | null, ot: OfflineTill | null) => {
    device.current = token;
    setTillTransport({ baseUrl: server, token: () => session.current || device.current, ...(ot && { local: (path, options) => ot.local.handle(path, options) }) });
  }, []);

  /** Removed from the business: start again, unless sales are still waiting to be sent (they are never thrown away). */
  const removed = useCallback(async (server: string, ot: OfflineTill | null) => {
    const pl = await getPlatform();
    const left = ot ? await ot.unsent() : { pending: 0, failed: 0 };
    if (left.pending + left.failed > 0) return setPhase({ kind: 'removed', server, unsent: left.pending + left.failed });
    await removeToken(pl);
    if (ot) await ot.wipe().catch(() => {});
    toast(t('This till was removed or paired again. Pair it with a new code.'), 'bad');
    setPhase({ kind: 'pair', server });
  }, [t, toast]);

  const loadTill = useCallback(async (server: string, token: string, ot: OfflineTill | null) => {
    useServer(server, token, ot);
    if (ot) {
      await ot.attach(server, token);
      // Sells from its own copy at once; a fresh one comes in the background.
      if (ot.snapshot) {
        setPhase({ kind: 'lock', server, token, till: tillFrom(ot.snapshot) });
        void ot.refresh().then((s) => setPhase((ph) => (ph.kind === 'lock' ? { ...ph, till: tillFrom(s) } : ph))).catch((e) => {
          if (e instanceof ApiError && e.status === 401) void removed(server, ot);
        });
        return;
      }
      try {
        setPhase({ kind: 'lock', server, token, till: tillFrom(await ot.refresh()) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) await removed(server, ot);
        else setPhase({ kind: 'unreachable', server, token, error: e });
      }
      return;
    }
    try {
      const till = await api<TillInfo>('/v1/pos/till', { token });
      setPhase({ kind: 'lock', server, token, till });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await removed(server, null);
      else setPhase({ kind: 'unreachable', server, token, error: e });
    }
  }, [removed, useServer]);

  useEffect(() => {
    void (async () => {
      const pl = await getPlatform();
      setPlatform(pl);
      setHardwareState(await loadHardware(pl));
      // The device's own database; a device that cannot keep one works online only, as before.
      const ot = await offlineTill(pl).catch((e) => {
        console.error('The till cannot keep sales on this device', e);
        return null;
      });
      setOffline(ot);
      const fromLink = pl.kind === 'web' ? new URLSearchParams(window.location.search).get('pair') : null;
      const saved = normalizeServer((await pl.getItem(SERVER)) ?? '');
      const token = await savedToken(pl);
      const server = pl.kind === 'web' ? window.location.origin : saved || normalizeServer(import.meta.env.VITE_TILL_SERVER ?? '');
      if (token && !fromLink) await loadTill(server, token, ot);
      else setPhase({ kind: 'pair', server });
    })();
  }, [loadTill]);

  // The server says the till was removed: stop, keep what is unsent.
  useEffect(() => {
    if (sync?.unpaired && (phase.kind === 'lock' || phase.kind === 'till')) {
      session.current = null;
      offline?.signedIn(null);
      void removed(phase.server, offline);
    }
  }, [sync?.unpaired, phase, offline, removed]);

  const lock = useCallback(() => {
    const token = session.current;
    session.current = null;
    offline?.signedIn(null);
    if (token) void api('/v1/pos/sign-out', { method: 'POST', token }).catch(() => {});
    setPhase((ph) => (ph.kind === 'till' ? { kind: 'lock', server: ph.server, token: ph.token, till: ph.till } : ph));
  }, [offline]);

  // Signed out by the server (session expired, PIN changed, till removed): back to the lock screen.
  useEffect(() => {
    const onOut = () => lock();
    window.addEventListener(UNAUTHORIZED_EVENT, onOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onOut);
  }, [lock]);

  // Tell the server what this till runs and what is plugged in: now, and every 5 minutes.
  const tillToken = phase.kind === 'lock' || phase.kind === 'till' ? phase.token : null;
  useEffect(() => {
    if (!tillToken || !p || !hardware) return;
    const beat = () => void api('/v1/pos/heartbeat', { method: 'POST', token: tillToken, body: { platform: p.kind, appVersion: p.appVersion.slice(0, 30), hardware: hardwareReport(hardware, p) } }).catch(() => {});
    beat();
    const timer = setInterval(beat, 5 * 60_000);
    return () => clearInterval(timer);
  }, [tillToken, p, hardware]);

  if (!p || !hardware || phase.kind === 'loading') return <div className="till-loading" aria-busy="true">{t('Loading…')}</div>;

  if (phase.kind === 'pair') {
    return (
      <Pair
        platform={p}
        initialServer={phase.server}
        onPaired={async (server, token) => {
          await p.setItem(SERVER, server);
          await saveToken(p, token);
          if (p.kind === 'web' && window.location.search) window.history.replaceState(null, '', window.location.pathname);
          await loadTill(server, token, offline);
        }}
      />
    );
  }

  if (phase.kind === 'unreachable') {
    return (
      <div className="till-center">
        <div className="card stack till-card">
          <h1>{offline ? t('Connect this till once') : t('Cannot reach the server')}</h1>
          <p className="muted">{phase.server}</p>
          <ErrorText error={phase.error} />
          <p className="small muted">{offline
            ? t('The first time, the till needs the internet to download the items and prices and get its own receipt numbers. After that it sells without a connection.')
            : t('Selling needs the internet: every receipt is signed and sent to BTS. Check the connection and try again.')}</p>
          <button type="button" className="big" onClick={() => void loadTill(phase.server, phase.token, offline)}>{t('Try again')}</button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'removed') {
    return (
      <div className="till-center">
        <div className="card stack till-card">
          <h1>{t('This till was removed')}</h1>
          <p>{t('{n} sales made on this till have not reached the server yet. They are kept here.', { n: phase.unsent })}</p>
          <p className="small muted">{t('Ask a manager for a new pairing code (Settings → Tills) and pair this till again: the sales are sent as soon as it is paired.')}</p>
          <button type="button" className="big" onClick={() => setPhase({ kind: 'pair', server: phase.server })}>{t('Pair again')}</button>
        </div>
      </div>
    );
  }

  const unpair = async () => {
    // Never with sales still on the till: they would be lost.
    const left = offline ? await offline.unsent() : { pending: 0, failed: 0 };
    if (left.pending + left.failed > 0) {
      toast(t('{n} sales have not reached the server yet. Connect the till and wait until they are sent (Sync) before removing it.', { n: left.pending + left.failed }), 'bad');
      return;
    }
    await api('/v1/pos/unpair', { method: 'POST', token: phase.token }).catch(() => {});
    session.current = null;
    offline?.signedIn(null);
    await offline?.wipe().catch(() => {});
    await removeToken(p);
    setPhase({ kind: 'pair', server: phase.server });
  };

  if (phase.kind === 'lock') {
    return (
      <Lock
        till={phase.till}
        deviceToken={phase.token}
        offline={offline}
        status={sync ? <SyncIndicator state={sync} /> : null}
        onRefresh={() => void loadTill(phase.server, phase.token, offline)}
        onSignedIn={(s, pin) => {
          session.current = s.offline ? null : s.token;
          offline?.signedIn(s);
          pinForUpgrade.current = s.offline ? pin : null;
          setPhase({ kind: 'till', server: phase.server, token: phase.token, till: phase.till, session: s });
        }}
      />
    );
  }

  return (
    <SignedInTill
      key={`${phase.session.user.id}-${phase.session.token}`}
      offline={offline}
      deviceToken={phase.token}
      pinForUpgrade={pinForUpgrade}
      onUpgraded={(token) => {
        session.current = token;
        offline?.upgraded(token);
      }}
      platform={p}
      server={phase.server}
      till={phase.till}
      session={phase.session}
      hardware={hardware}
      setHardware={async (h) => {
        await saveHardware(p, h);
        setHardwareState(h);
      }}
      lock={lock}
      unpair={unpair}
    />
  );
}

// ---------- pairing ----------

function Pair({ platform, initialServer, onPaired }: { platform: Platform; initialServer: string; onPaired: (server: string, token: string) => Promise<void> }) {
  const t = useT();
  const inBrowser = platform.kind === 'web';
  const [server, setServer] = useState(initialServer);
  const [code, setCode] = useState(() => (inBrowser ? new URLSearchParams(window.location.search).get('pair') ?? '' : ''));
  const [editServer, setEditServer] = useState(!inBrowser && !initialServer);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);

  const pair = async (s: string, c: string) => {
    const base = normalizeServer(s);
    if (!base) return setError(new ApiError(0, 'server', t('Enter the address of your Floreo server')));
    setBusy(true);
    setError(null);
    setTillTransport({ baseUrl: base, token: () => null });
    try {
      const r = await api<{ token: string }>('/v1/pos/pair', { method: 'POST', token: null, body: { code: c.trim(), platform: platform.kind, appVersion: platform.appVersion.slice(0, 30) } });
      await onPaired(base, r.token);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  // Opened from the pairing QR code in a browser: pair straight away.
  const autoPaired = useRef(false);
  useEffect(() => {
    if (inBrowser && code && !autoPaired.current) {
      autoPaired.current = true;
      void pair(server, code);
    }
  });

  const scanned = (text: string | null) => {
    setCamera(false);
    if (!text) return;
    const link = readPairingLink(text);
    if (!link) return setError(new ApiError(0, 'qr', t('That is not a pairing code from Floreo')));
    setServer(link.server);
    setCode(link.code);
    void pair(link.server, link.code);
  };
  const scan = async () => {
    if (platform.scanBarcode) scanned(await platform.scanBarcode().catch(() => null));
    else setCamera(true);
  };

  return (
    <div className="till-center">
      <form className="card stack till-card" onSubmit={(e) => { e.preventDefault(); void pair(server, code); }}>
        <span className="kicker">{t('Set up this till')}</span>
        <h1>{t('Pair with your business')}</h1>
        <p className="muted">{t('In the web app, a manager opens Settings → Tills, adds this till and gets a pairing code. Scan its QR code or type the code here.')}</p>
        {(platform.scanBarcode || browserCanScan()) && <button type="button" className="big secondary" onClick={() => void scan()}>{t('Scan the QR code')}</button>}
        {editServer ? (
          <Field label={t('Server address')} hint={t('The address you sign in to Floreo at, e.g. app.example.bz')}>
            <input inputMode="url" autoCapitalize="off" autoCorrect="off" value={server} onChange={(e) => setServer(e.target.value)} required />
          </Field>
        ) : (
          <p className="small muted">{t('Server')}: {server || '—'} {!inBrowser && <button type="button" className="link" onClick={() => setEditServer(true)}>{t('Change')}</button>}</p>
        )}
        <Field label={t('Pairing code')}>
          <input className="pair-code" autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH" value={code}
            onChange={(e) => {
              const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
              setCode(raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw);
            }} required autoFocus={!editServer} />
        </Field>
        <ErrorText error={error} />
        <button className="big" disabled={busy || code.replace('-', '').length !== 8}>{busy ? t('Pairing…') : t('Pair this till')}</button>
        <div className="row"><span className="spacer" /><LanguagePicker /></div>
      </form>
      {camera && <CameraScanner onClose={() => setCamera(false)} onScan={scanned} />}
    </div>
  );
}

// ---------- the lock screen: who are you, your PIN ----------

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

function Lock({ till, deviceToken, offline, status, onSignedIn, onRefresh }: { till: TillInfo; deviceToken: string; offline: OfflineTill | null; status: React.ReactNode; onSignedIn: (s: SignedIn, pin: string) => void; onRefresh: () => void }) {
  const t = useT();
  const [who, setWho] = useState<TillInfo['users'][number] | null>(till.users.length === 1 && till.users[0]!.hasPin ? till.users[0]! : null);
  const [setup, setSetup] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const withPin = till.users.filter((u) => u.hasPin);

  if (setup) return <SetPin deviceToken={deviceToken} onDone={() => { setSetup(false); onRefresh(); }} onCancel={() => setSetup(false)} />;
  return (
    <div className="till-lock">
      <header className="till-lock-head status-bar">
        <div className="where">
          <strong>{till.business.name}</strong>
          <span>{till.device.name}{till.business.environment !== 'production' && ` · ${t('Test')}`}</span>
        </div>
        <div className="pills">
          {status}
          <time className="status-clock till-clock num" dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      </header>
      {who ? (
        <PinPad user={who} deviceToken={deviceToken} offline={offline} onBack={() => setWho(null)} onSignedIn={onSignedIn} />
      ) : (
        <main className="till-people">
          <h1>{t('Who is selling?')}</h1>
          {withPin.length === 0 && <p className="muted">{t('Nobody has a PIN yet. Each person sets one once: tap "Set up my PIN" and sign in with your password.')}</p>}
          <div className="people-grid">
            {withPin.map((u) => (
              <button key={u.id} type="button" className="person" onClick={() => { feedback('tap'); setWho(u); }}>
                <span className="pos-avatar lg" aria-hidden="true">{initials(u.name)}</span>
                <span className="person-name">{u.name}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={() => setSetup(true)}>{t('Set up my PIN')}</button>
            <button type="button" className="link" onClick={onRefresh}>{t('Refresh')}</button>
            <span className="spacer" />
            <LanguagePicker />
          </div>
        </main>
      )}
    </div>
  );
}

function PinPad({ user, deviceToken, offline, onBack, onSignedIn }: { user: TillInfo['users'][number]; deviceToken: string; offline: OfflineTill | null; onBack: () => void; onSignedIn: (s: SignedIn, pin: string) => void }) {
  const t = useT();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // With the server when it can be reached (and remembered for later); without it, the PIN remembered on this till.
      const withServer = async () => {
        const s = await api<SignedIn>('/v1/pos/sign-in', { method: 'POST', token: deviceToken, body: { userId: user.id, pin: value }, signal: AbortSignal.timeout(8000) });
        await offline?.rememberPin(value, s).catch(() => {});
        return s;
      };
      const unreachable = (e: unknown) => (e instanceof ApiError && e.status === 0) || (e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError';
      let signed: SignedIn;
      if (!offline) {
        signed = await withServer();
      } else if (offline.sync.online) {
        try {
          signed = await withServer();
        } catch (e) {
          if (!unreachable(e)) throw e;
          signed = await offline.signInOffline(user.id, value);
        }
      } else {
        try {
          signed = await offline.signInOffline(user.id, value);
        } catch (e) {
          // Not remembered here, or too long ago: the connection may be back before the till has noticed. Ask the server.
          const code = e instanceof ApiError ? e.code : '';
          if ((code !== 'not_remembered' && code !== 'offline_expired') || navigator.onLine === false) throw e;
          try {
            signed = await withServer();
          } catch (again) {
            throw unreachable(again) ? e : again;
          }
        }
      }
      onSignedIn(signed, value);
    } catch (e) {
      setError(e);
      setPin('');
      setBusy(false);
    }
  }, [busy, deviceToken, offline, onSignedIn, user.id]);
  const press = (d: string) => setPin((v) => (v.length < 8 ? v + d : v));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((v) => v.slice(0, -1));
      else if (e.key === 'Enter') void submit(pin);
      else if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pin, submit, onBack]);
  return (
    <main className="pin-screen">
      <div className="pin-who">
        <span className="pos-avatar lg" aria-hidden="true">{initials(user.name)}</span>
        <h1>{user.name}</h1>
        <p className="muted">{t('Enter your PIN')}</p>
        <div className={`pin-dots${error ? ' shake' : ''}`} aria-label={t('{n} digits entered', { n: pin.length })} role="status">
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
        </div>
        <ErrorText error={error} />
      </div>
      <div className="pin-keys">
        <div className="pin-pad pos-numpad" role="group" aria-label={t('PIN')}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" onClick={() => { feedback('tap'); press(d); }} disabled={busy}>{d}</button>)}
          <button type="button" className="soft" onClick={onBack} aria-label={t('Back')}><Icon name="back" /></button>
          <button type="button" onClick={() => { feedback('tap'); press('0'); }} disabled={busy}>0</button>
          <button type="button" className={`accent${busy ? ' is-busy' : ''}`} onClick={() => void submit(pin)} disabled={busy || pin.length < 4} aria-label={t('Sign in')}>{busy ? '…' : <Icon name="check" />}</button>
        </div>
        <button type="button" className="pos-btn quiet block" onClick={() => setPin((v) => v.slice(0, -1))} disabled={!pin}><Icon name="backspace" />{t('Delete a digit')}</button>
      </div>
    </main>
  );
}

function SetPin({ deviceToken, onDone, onCancel }: { deviceToken: string; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pin !== again) return setError(new ApiError(0, 'mismatch', t('The two PINs are not the same')));
    setBusy(true);
    setError(null);
    try {
      await api('/v1/pos/pin', { method: 'POST', token: deviceToken, body: { login: login.trim(), password, pin } });
      toast(t('PIN set. Tap your name to sign in.'));
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 8);
  return (
    <div className="till-center">
      <form className="card stack till-card" onSubmit={(e) => void submit(e)}>
        <h1>{t('Set up my PIN')}</h1>
        <p className="muted">{t('Sign in with your email or username and password once, and choose a PIN of 4 to 8 digits for this business’s tills.')}</p>
        <Field label={t('Email or username')}><input autoCapitalize="off" autoCorrect="off" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus /></Field>
        <Field label={t('Password')}><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <div className="form-grid">
          <Field label={t('New PIN')}><input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(digits(e.target.value))} required minLength={4} /></Field>
          <Field label={t('PIN again')}><input type="password" inputMode="numeric" autoComplete="off" value={again} onChange={(e) => setAgain(digits(e.target.value))} required minLength={4} /></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onCancel}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || pin.length < 4}>{t('Set PIN')}</button></div>
      </form>
    </div>
  );
}

// ---------- signed in ----------

type Tab = 'floor' | 'kitchen' | 'sell' | 'sales' | 'shift' | 'devices' | 'sync';

/** Table service on a till: the floor, paid at this till's counter, tickets on this till's printer. */
function TillFloor() {
  const till = useTill();
  const printer = useRef(till.printTicket);
  printer.current = till.printTicket;
  const print = useCallback((ticket: Ticket, title: string) => printer.current(ticket, { title }), []);
  return <VenueFloor touch counter={<Sell />} print={print} />;
}

/** A logo from the snapshot (data: URL, printed offline) or the server. */
function logoBlob(url: string): Promise<Blob> {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
  if (!m) return apiBlob(url);
  return Promise.resolve(new Blob([Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0))], { type: m[1] }));
}

function SignedInTill(props: {
  offline: OfflineTill | null;
  deviceToken: string;
  pinForUpgrade: React.MutableRefObject<string | null>;
  onUpgraded: (token: string) => void;
  platform: Platform;
  server: string;
  till: TillInfo;
  session: SignedIn;
  hardware: HardwareConfig;
  setHardware: (h: HardwareConfig) => Promise<void>;
  lock: () => void;
  unpair: () => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const { platform: p, till, session, hardware, lock } = props;
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('sell');
  const [legacyOnline, setLegacyOnline] = useState(() => navigator.onLine);
  const [camera, setCamera] = useState<((code: string | null) => void) | null>(null);
  const [hasSession, setHasSession] = useState(!session.offline);
  const { update, install: installUpdate } = useTillUpdate(p, props.server);
  const [askUpdate, setAskUpdate] = useState(false);
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions]);
  const isManager = ['owner', 'admin', 'manager'].includes(session.user.role);
  const sync = useSyncState(props.offline);
  const online = sync ? sync.phase !== 'offline' : legacyOnline;

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/v1/me'));
      setLegacyOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setLegacyOnline(false);
    }
  }, []);
  useEffect(() => {
    void refreshMe();
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshMe(), 30_000);
    const up = () => void refreshMe();
    const down = () => setLegacyOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [refreshMe]);

  // Signed in without the server, and it is back: sign in with it too (the PIN is checked again there),
  // so gift cards, points and email work. A PIN changed meanwhile locks the till.
  const { pinForUpgrade, onUpgraded, deviceToken } = props;
  useEffect(() => {
    if (hasSession || !online || !pinForUpgrade.current) return;
    let live = true;
    void api<SignedInInfo>('/v1/pos/sign-in', { method: 'POST', token: deviceToken, body: { userId: session.user.id, pin: pinForUpgrade.current } })
      .then(async (s) => {
        if (!live) return;
        await props.offline?.rememberPin(pinForUpgrade.current!, s).catch(() => {});
        pinForUpgrade.current = null;
        onUpgraded(s.token);
        setHasSession(true);
        void refreshMe();
      })
      .catch((e) => {
        if (live && e instanceof ApiError && (e.status === 401 || e.status === 429)) {
          pinForUpgrade.current = null;
          toast(t('Your PIN was changed. Sign in again.'), 'bad');
          lock();
        }
      });
    return () => {
      live = false;
    };
  }, [hasSession, online, pinForUpgrade, deviceToken, session.user.id, onUpgraded, lock, toast, t, refreshMe, props.offline]);

  // Lock after a few minutes without use.
  useEffect(() => {
    if (!hardware.lockAfterMinutes) return;
    let last = Date.now();
    const seen = () => {
      last = Date.now();
    };
    const timer = setInterval(() => {
      if (Date.now() - last > hardware.lockAfterMinutes * 60_000) lock();
    }, 10_000);
    for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, seen, true);
    return () => {
      clearInterval(timer);
      for (const ev of ['pointerdown', 'keydown'] as const) window.removeEventListener(ev, seen, true);
    };
  }, [hardware.lockAfterMinutes, lock]);

  const receiptPrinter = hardware.printers.find((x) => x.id === hardware.receiptPrinter) ?? hardware.printers[0] ?? null;
  const fallbackPrinter: PrinterConfig | null = p.kind === 'web'
    ? { id: 'browser', name: t('This browser'), connection: 'browser', paperWidth: 80, codepage: 'ascii', qr: 'native', cut: false, drawer: false }
    : null;

  const printTicket = useCallback(async (ticket: Ticket, options: { openDrawer?: boolean; title?: string } = {}) => {
    const printer = receiptPrinter ?? fallbackPrinter;
    if (!printer) throw new HardwareError(t('Add a receipt printer under Devices first'));
    await sendTicket(p, printer, ticket, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, receiptPrinter, t]);

  const value: TillContextValue = {
    platform: p,
    server: props.server,
    till,
    hardware,
    setHardware: props.setHardware,
    user: session.user,
    can: (x) => permissions.has(x),
    isManager,
    receiptPrinter,
    printTicket,
    printDocument: async (id, options = {}) => {
      const view = await api<DocumentView>(`/v1/documents/${id}/view`);
      if (!view.printed.printable) throw new HardwareError(t('This document has no valid printed copy'));
      // The business's logo on top (fetched once; printed without it if it cannot be had).
      const logo = view.logo ? await ticketLogo(view.logo, logoBlob).catch(() => null) : null;
      // For visitors: the total in US dollars, in the receipt's message space (the rest of a printed copy is only what the signed document holds).
      const usd = me?.counter?.showUsd ? `US$ ${usdOf(view.view.totals.taxInclusive)} (BZ$2 = US$1)` : '';
      const message = [usd, hardware.receiptMessage].filter((x) => x?.trim()).join('\n');
      const ticket = documentTicket(view, { message, ...(options.copy && { copy: true }), logo });
      for (let i = 0; i < (options.copy ? 1 : hardware.copies); i++) await printTicket(ticket, { openDrawer: i === 0 && options.openDrawer, title: view.view.typeName });
    },
    openDrawer: async () => {
      const printer = hardware.printers.find((x) => x.drawer);
      if (!printer) throw new HardwareError(t('No cash drawer is set up under Devices'));
      await kickDrawer(p, printer);
    },
    lock,
    unpair: props.unpair,
    offline: props.offline,
    scanWithCamera: p.scanBarcode
      ? () => p.scanBarcode!()
      : browserCanScan() ? () => new Promise<string | null>((resolve) => setCamera(() => resolve)) : null,
    update,
    offerUpdate: () => setAskUpdate(true),
  };

  // What the shared counter and shift screens expect of a signed-in session.
  const account: Account = { id: session.user.id, name: session.user.name, email: null, username: null, role: session.user.role, status: 'active', mustChangePassword: false, lastLoginAt: null, createdAt: '' };
  const sessionValue: SessionState = {
    loading: false,
    session: me ? {
      user: account,
      business: { id: me.id, slug: till.business.slug, legalName: me.legalName, tradeName: me.tradeName, environment: me.environment },
      permissions: session.permissions,
      twoFactor: { enabled: false, required: false, setupRequired: false },
    } : null,
    me,
    role: session.user.role,
    can: (x) => permissions.has(x),
    refresh: refreshMe,
    refreshMe,
    setSession: () => {},
    logout: async () => lock(),
  };

  // A restaurant or bar: the floor comes first for those who serve, the kitchen screen for those who cook.
  const service = Boolean(me?.venue?.restaurant || me?.venue?.bar);
  const sells = permissions.has('documents.issue');
  const serves = service && (permissions.has('venue.orders') || permissions.has('venue.floor'));
  const cooks = service && permissions.has('venue.kitchen');
  const landed = useRef(false);
  useEffect(() => {
    if (!me || landed.current) return;
    landed.current = true;
    if (serves) setTab('floor');
    else if (cooks && !sells) setTab('kitchen');
  }, [me, serves, cooks, sells]);
  const now = useNow(15_000);
  const tabIcon: Record<Tab, PosIconName> = { floor: 'floor', kitchen: 'kitchen', sell: 'sell', sales: 'receipt', shift: 'drawer', devices: 'devices', sync: 'sync' };
  const printerName = receiptPrinter?.name ?? (p.kind === 'web' ? t('This browser') : null);
  const tabs: Array<[Tab, string]> = [
    ...(serves ? [['floor', t('Floor')] as [Tab, string]] : []),
    ...(cooks ? [['kitchen', t('Kitchen')] as [Tab, string]] : []),
    ...(sells ? [['sell', t('Sell')], ['sales', t('Sales')], ['shift', t('Shift')]] as Array<[Tab, string]> : []),
    ...(isManager ? [['devices', t('Devices')] as [Tab, string]] : []),
    ...(isManager && props.offline ? [['sync', t('Sync')] as [Tab, string]] : []),
  ];
  return (
    <TillContext.Provider value={value}>
      <ConnectivityContext.Provider value={{ online, serverFeatures: online && hasSession }}>
      <SessionContext.Provider value={sessionValue}>
        <div className="till">
          {/* The status bar: where, the screens, the connection, the printer, the time, and who is selling (one tap to switch). */}
          <header className="till-bar status-bar">
            <div className="till-where where"><strong>{till.business.name}</strong><span>{till.device.name}</span></div>
            <nav className="till-tabs status-tabs" aria-label={t('Till')}>
              {tabs.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => k !== tab && setTab(k)}><Icon name={tabIcon[k]} /><span>{label}</span></button>)}
            </nav>
            <div className="pills">
              {sync && <SyncIndicator state={sync} onOpen={isManager ? () => setTab('sync') : undefined} />}
              {(update.kind === 'ready' || update.kind === 'available') && (
                <button type="button" className="status-pill update" onClick={() => setAskUpdate(true)} title={t('Version {v} of the till app', { v: update.version })}
                  aria-label={update.kind === 'ready' ? t('Restart to update') : t('Update available')}>
                  <Icon name="sparkle" /><span className="pill-text">{update.kind === 'ready' ? t('Restart to update') : t('Update available')}</span>
                </button>
              )}
              <button type="button" className={`status-pill printer${printerName ? '' : ' bad'}`} title={printerName ? t('Receipt printer: {name}', { name: printerName }) : t('No receipt printer is set up')}
                onClick={isManager ? () => setTab('devices') : undefined} aria-label={printerName ? t('Receipt printer: {name}', { name: printerName }) : t('No receipt printer is set up')}>
                <Icon name="printer" /><span className="pill-text">{printerName ?? t('No printer')}</span>
              </button>
              <time className="status-clock num" dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              <button type="button" className="status-switch till-user" onClick={lock} aria-label={t('Switch user')} title={t('Switch user: {name} is selling', { name: session.user.name })}>
                <span className="pos-avatar" aria-hidden="true">{initials(session.user.name)}</span><span className="pill-text">{session.user.name}</span><Icon name="switchUser" />
              </button>
            </div>
          </header>
          {!online && !props.offline && <div className="till-banner"><Banner tone="danger" title={t('No connection.')}>{t('Sales need the internet: every receipt is signed and sent to BTS.')}</Banner></div>}
          {me?.contingency.active && <div className="till-banner"><Banner tone="warning" title={t('BTS cannot be reached right now.')}>{t('Receipts are issued and sent when it is back.')}</Banner></div>}
          {/* A tab is a whole screen: the new one replaces the old at once and fades in (keyed by tab), never two on screen together. */}
          <main className="till-main" key={tab}>
            {/* The counter and the shift wait for the business and the person (from the till's own copy: a moment). */}
            {!me && tab !== 'devices' && tab !== 'sync' && <div className="till-loading" aria-busy="true">{t('Loading…')}</div>}
            {me && tab === 'floor' && serves && <TillFloor />}
            {me && tab === 'kitchen' && cooks && <KitchenScreen />}
            {me && tab === 'sell' && <Sell />}
            {me && tab === 'sales' && <Sales />}
            {me && tab === 'shift' && <ShiftPanel />}
            {tab === 'devices' && isManager && <HardwareSettings onError={(e) => toast(e instanceof Error ? e.message : String(e), 'bad')} />}
            {tab === 'sync' && isManager && props.offline && sync && <SyncScreen till={props.offline} state={sync} />}
          </main>
        </div>
        {camera && <CameraScanner onClose={() => { camera(null); setCamera(null); }} onScan={(code) => { camera(code); setCamera(null); }} />}
        {askUpdate && (update.kind === 'ready' || update.kind === 'available') && (
          <Modal title={update.kind === 'ready' ? t('Restart to update?') : t('A new till app')} onClose={() => setAskUpdate(false)}>
            <div className="stack">
              {update.kind === 'ready'
                ? <p>{t('Version {v} is downloaded. The till closes and opens again in a few seconds. Sales already made are kept; finish the sale on screen first.', { v: update.version })}</p>
                : <p>{t('Version {v} is ready on the server. It downloads in the browser; open it and tap Install. Sales already made are kept.', { v: update.version })}</p>}
              <div className="row">
                <button type="button" className="secondary" onClick={() => setAskUpdate(false)}>{t('Not now')}</button>
                <span className="spacer" />
                <button type="button" onClick={() => { setAskUpdate(false); installUpdate(); }}>{update.kind === 'ready' ? t('Restart now') : t('Download')}</button>
              </div>
            </div>
          </Modal>
        )}
      </SessionContext.Provider>
      </ConnectivityContext.Provider>
    </TillContext.Provider>
  );
}

