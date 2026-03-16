import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { AuthAdapter, AuthUser } from './types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, loading: true });

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

interface AuthProviderProps {
  adapter: AuthAdapter;
  children: ReactNode;
}

export function AuthProvider({ adapter, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adapter.getUser().then((u) => {
      setUser(u);
      setLoading(false);
    });

    const unsub = adapter.onAuthChange(setUser);
    return unsub;
  }, [adapter]);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

interface AuthGateProps {
  adapter: AuthAdapter;
  children: ReactNode;
}

/** Wraps children — shows them if authenticated, redirects or blocks if not. */
export function AuthGate({ adapter, children }: AuthGateProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg)', color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
      }}>
        Loading...
      </div>
    );
  }

  if (!user) {
    if (adapter.loginUrl) {
      const redirect = encodeURIComponent(window.location.href);
      window.location.href = `${adapter.loginUrl}?redirect=${redirect}`;
      return null;
    }

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg)', color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
      }}>
        Not authenticated
      </div>
    );
  }

  return <>{children}</>;
}
