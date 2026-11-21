/** Who is signed in, and which business they are working in. Keeps the business status (BTS outage, queue) fresh. */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me, type SessionInfo, UNAUTHORIZED_EVENT } from './api';
import { useT } from './i18n';
import { useToast } from './toast';

interface SessionState {
  loading: boolean;
  session: SessionInfo | null;
  me: Me | null;
  /** The person's role in the current business. */
  role: 'owner' | 'member' | null;
  refresh: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setSession: (s: SessionInfo | null) => void;
  logout: () => Promise<void>;
  switchBusiness: (id: string) => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
const POLL_MS = 30_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const wasDown = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api<SessionInfo>('/v1/auth/session');
      setSession(s);
      setMe(s.currentBusinessId ? await api<Me>('/v1/me') : null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setSession(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/v1/me'));
    } catch {
      /* a failed status check is not worth interrupting anyone for */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Signed out elsewhere or the session expired: drop to the login page.
  useEffect(() => {
    const onUnauthorized = () => {
      setSession(null);
      setMe(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Keep the outage banner and queue count live while the tab is visible.
  const businessId = session?.currentBusinessId;
  useEffect(() => {
    if (!businessId) return;
    const tick = () => document.visibilityState === 'visible' && void refreshMe();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [businessId, refreshMe]);

  // Tell people when BTS comes back and the queue has been sent.
  useEffect(() => {
    if (!me) return;
    const down = me.contingency.active || me.contingency.queued > 0;
    if (wasDown.current && !down) toast(t('BTS is back. Every queued document has been sent.'), 'ok');
    wasDown.current = down;
  }, [me, t, toast]);

  const role = session?.businesses.find((b) => b.id === session.currentBusinessId)?.role ?? null;
  const value: SessionState = {
    loading,
    session,
    me,
    role,
    refresh,
    refreshMe,
    setSession: (s) => {
      setSession(s);
      void refresh();
    },
    logout: async () => {
      await api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
      setSession(null);
      setMe(null);
    },
    switchBusiness: async (id) => {
      await api('/v1/auth/switch', { method: 'POST', body: { businessId: id } });
      await refresh();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
