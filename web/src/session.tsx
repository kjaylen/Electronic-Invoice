/** Who is signed in to this business, what they may do, and the business's status (BTS outage, queue). */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me, type Permission, type SessionInfo, UNAUTHORIZED_EVENT } from './api';
import { BUSINESS, rememberBusiness, STORE_DOMAIN } from './business';
import { useT } from './i18n';
import { useToast } from './toast';

interface SessionState {
  loading: boolean;
  session: SessionInfo | null;
  me: Me | null;
  role: SessionInfo['user']['role'] | null;
  can: (p: Permission) => boolean;
  refresh: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setSession: (s: SessionInfo | null) => void;
  logout: () => Promise<void>;
  /** False while nobody has asked the server who is signed in (a page opened on the storefront). */
  asked?: boolean;
}

/** Exported so the till app can supply its own session (a cashier signed in with a PIN). */
export type { SessionState };
export const SessionContext = createContext<SessionState | null>(null);
const Ctx = SessionContext;
const POLL_MS = 30_000;
/** A buyer on the storefront is not staff: the server is not asked who is signed in until a staff page needs to know. */
const onStorefront = () => STORE_DOMAIN || /^\/[^/]+\/shop(\/|$)/.test(window.location.pathname);

export function SessionProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const [asked, setAsked] = useState(() => !onStorefront());
  const [loading, setLoading] = useState(() => Boolean(BUSINESS) && !onStorefront());
  const [session, setSessionState] = useState<SessionInfo | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const wasDown = useRef(false);

  const accept = useCallback((s: SessionInfo | null) => {
    setSessionState(s);
    if (s) rememberBusiness({ slug: s.business.slug, name: s.business.tradeName ?? s.business.legalName });
  }, []);

  const refresh = useCallback(async () => {
    setAsked(true);
    if (!BUSINESS) return setLoading(false);
    try {
      const s = await api<SessionInfo>('/v1/auth/session');
      accept(s);
      // Nothing of the business is asked for while a first step is owed, or while it is closed.
      setMe(s.user.mustChangePassword || s.twoFactor?.setupRequired || s.business.closed ? null : await api<Me>('/v1/me'));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setSessionState(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [accept]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/v1/me'));
    } catch {
      /* a failed status check is not worth interrupting anyone for */
    }
  }, []);

  useEffect(() => {
    if (!onStorefront()) void refresh();
  }, [refresh]);

  // Signed out elsewhere, deactivated, or the session expired: back to the login page.
  useEffect(() => {
    const onUnauthorized = () => {
      setSessionState(null);
      setMe(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Keep the outage banner and queue count live while the tab is visible.
  const signedIn = Boolean(session && !session.user.mustChangePassword && !session.twoFactor?.setupRequired && !session.business.closed);
  useEffect(() => {
    if (!signedIn) return;
    const tick = () => document.visibilityState === 'visible' && void refreshMe();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [signedIn, refreshMe]);

  // Tell people when BTS comes back and the queue has been sent.
  useEffect(() => {
    if (!me) return;
    const down = me.contingency.active || me.contingency.queued > 0;
    if (wasDown.current && !down) toast(t('BTS is back. Every queued document has been sent.'), 'ok');
    wasDown.current = down;
  }, [me, t, toast]);

  const permissions = new Set(session?.permissions ?? []);
  const value: SessionState = {
    loading,
    asked,
    session,
    me,
    role: session?.user.role ?? null,
    can: (p) => permissions.has(p),
    refresh,
    refreshMe,
    setSession: (s) => {
      accept(s);
      void refresh();
    },
    logout: async () => {
      await api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
      setSessionState(null);
      setMe(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
