import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../App';
import type { Me } from '../api/client';
import type { AuthService, AuthSession } from '../auth/auth-service';
import type { Env } from '../env';
import { createQueryClient } from '../lib/query-client';
import { markWelcomeSeen, resetWelcomeMemory } from '../lib/welcome';

export const ENV: Env = {
  appEnv: 'operational',
  apiUrl: 'https://api.example.test',
  supabaseUrl: 'https://project.supabase.test',
  supabaseAnonKey: 'anon-key-placeholder',
};

export const SESSION: AuthSession = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'dana@example.com',
};

type Listener = (session: AuthSession | null) => void;

/** An AuthService whose behaviour tests control. Nothing here talks to Supabase. */
export function fakeAuth(initial: AuthSession | null = null) {
  let session = initial;
  const listeners = new Set<Listener>();
  const emit = (next: AuthSession | null) => {
    session = next;
    listeners.forEach((listener) => listener(next));
  };
  const service = {
    getSession: vi.fn(async () => session),
    onChange: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getAccessToken: vi.fn(async () => (session ? 'access-token-placeholder' : null)),
    sendCode: vi.fn<AuthService['sendCode']>(async () => {}),
    verifyCode: vi.fn<AuthService['verifyCode']>(async () => {
      emit(SESSION);
    }),
    signInWithGoogle: vi.fn(async () => {}),
    signOut: vi.fn<AuthService['signOut']>(async () => {
      emit(null);
    }),
  } satisfies AuthService;
  return Object.assign(service, { emit });
}

export type FakeAuth = ReturnType<typeof fakeAuth>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message, requestId: 'req-1' } }, status);

export function meBody(overrides: Partial<Me> = {}): Me {
  return {
    id: SESSION.userId,
    email: SESSION.email!,
    displayName: null,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    legal: {
      terms: { currentVersion: '0.1', accepted: true },
      privacy: { currentVersion: '0.1', accepted: true },
      allAccepted: true,
    },
    ...overrides,
  };
}

export const unacceptedLegal: Me['legal'] = {
  terms: { currentVersion: '0.1', accepted: false },
  privacy: { currentVersion: '0.1', accepted: false },
  allAccepted: false,
};

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * Stubs the global fetch with routes keyed like "GET /api/v1/me". Anything unlisted answers 404 in
 * the API's error shape. The health check defaults to "ok" and the plan list to empty.
 */
export function installApi(routes: Record<string, Handler>) {
  const all: Record<string, Handler> = {
    'GET /api/v1/health': () => json({ status: 'ok', environment: 'test' }),
    'GET /api/v1/plans': () => json({ plans: [] }),
    ...routes,
  };
  const calls: Request[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    calls.push(request);
    const handler = all[`${request.method} ${new URL(request.url).pathname}`];
    if (!handler) return apiError(404, 'not_found', 'Resource not found.');
    // Like the real fetch, a request that is aborted (timeout, cancelled query) rejects.
    const aborted = new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
    return Promise.race([Promise.resolve().then(() => handler(request)), aborted]);
  });
  vi.stubGlobal('fetch', stub);
  return {
    stub,
    calls,
    count: (key: string) =>
      calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key).length,
  };
}

export function renderApp(options: {
  auth: AuthService;
  path?: string | { pathname: string; state?: unknown };
  env?: Env;
  /** Default 'seen': the first-visit welcome is pre-marked so tests of other screens are not interrupted. */
  welcome?: 'seen' | 'first-visit';
}): RenderResult & { auth: AuthService } {
  if ((options.welcome ?? 'seen') === 'seen') markWelcomeSeen(SESSION.userId, { persist: false });
  else resetWelcomeMemory();
  const result = render(
    <MemoryRouter initialEntries={[options.path ?? '/']}>
      <App env={options.env ?? ENV} queryClient={createQueryClient()} auth={options.auth} />
    </MemoryRouter>,
  );
  return Object.assign(result, { auth: options.auth });
}
