import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrfToken, type Admin } from './api/client';

interface MeResponse {
  admin: Admin;
  csrfToken: string;
  totpRequired: boolean;
}

interface AuthState {
  admin: Admin | null;
  totpRequired: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<MeResponse>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const apply = (r: MeResponse | null) => {
    setAdmin(r?.admin ?? null);
    setTotpRequired(r?.totpRequired ?? false);
    setCsrfToken(r?.csrfToken ?? null);
  };

  const refresh = useCallback(async () => {
    try {
      apply(await api.get<MeResponse>('/api/auth/me'));
    } catch {
      apply(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => apply(null);
    window.addEventListener('tutor:unauthorized', onUnauthorized);
    return () => window.removeEventListener('tutor:unauthorized', onUnauthorized);
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const r = await api.post<MeResponse>('/api/auth/login', { email, password });
    apply(r);
    return r;
  };

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    apply(null);
  };

  return <AuthContext.Provider value={{ admin, totpRequired, loading, refresh, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export const canReview = (a: Admin | null) => a?.role === 'SUPER_ADMIN' || a?.role === 'REVIEWER';
export const isSuper = (a: Admin | null) => a?.role === 'SUPER_ADMIN';
