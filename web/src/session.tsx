/** Who is signed in, and which business they are working in. */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, type Me, type SessionInfo } from './api';

interface SessionState {
  loading: boolean;
  session: SessionInfo | null;
  me: Me | null;
  refresh: () => Promise<void>;
  setSession: (s: SessionInfo | null) => void;
  logout: () => Promise<void>;
  switchBusiness: (id: string) => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [me, setMe] = useState<Me | null>(null);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: SessionState = {
    loading,
    session,
    me,
    refresh,
    setSession: (s) => {
      setSession(s);
      void refresh();
    },
    logout: async () => {
      await api('/v1/auth/logout', { method: 'POST' });
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
