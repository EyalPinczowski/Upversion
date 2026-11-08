import { cvTextSession } from '../cv/cv-text-session';
import { clearStoredSessions } from '../pages/practice/session-store';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthService, AuthSession, SignOutScope } from './auth-service';

export type AuthState =
  { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; session: AuthSession };

/** A one-time message for the sign-in page after a sign-out the person caused. */
export type AuthNotice = 'accountDeleted';

interface AuthContextValue {
  state: AuthState;
  service: AuthService;
  notice: AuthNotice | null;
  /** Signs out, then drops every cached server answer so the next person sees none of it. */
  signOut: (scope?: SignOutScope, notice?: AuthNotice) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const stateFor = (session: AuthSession | null): AuthState =>
  session ? { status: 'signedIn', session } : { status: 'signedOut' };

export function AuthProvider({ service, children }: { service: AuthService; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const apply = (session: AuthSession | null) => {
      if (!active) return;
      // A different person (or nobody) now: nothing cached for the previous one may stay.
      if (lastUserId.current !== null && lastUserId.current !== (session?.userId ?? null)) {
        queryClient.clear();
        clearStoredSessions();
        cvTextSession.clear();
      }
      lastUserId.current = session?.userId ?? null;
      if (session) setNotice(null);
      setState(stateFor(session));
    };
    const unsubscribe = service.onChange(apply);
    service.getSession().then(apply, () => apply(null));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [service, queryClient]);

  const signOut = useCallback(
    async (scope: SignOutScope = 'local', next?: AuthNotice) => {
      await service.signOut(scope);
      queryClient.clear();
      clearStoredSessions();
      cvTextSession.clear();
      setNotice(next ?? null);
      lastUserId.current = null;
      setState({ status: 'signedOut' });
    },
    [service, queryClient],
  );

  const value = useMemo(
    () => ({ state, service, notice, signOut }),
    [state, service, notice, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
