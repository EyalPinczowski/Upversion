import type { ProfileView } from '../api/client';
import { apiError, installApi, json, meBody } from './helpers';
import { planRoutes } from './plan-fixtures';

export const profileView = (overrides: Partial<ProfileView> = {}): ProfileView => ({
  answers: {},
  skills: [],
  rolesHeld: [],
  yearsExperience: null,
  cvImportedAt: null,
  setupStatus: 'not_started',
  setupStep: null,
  setupCompletedAt: null,
  ...overrides,
});

type Handler = Parameters<typeof installApi>[0][string];

/**
 * A stand-in for the profile API of ADR 015 (WP-B): keeps one profile in memory and answers the
 * five routes the way the ADR describes them. `profile: 404` is the flag-off server.
 */
export function installSetupApi(
  options: {
    profile?: ProfileView | 404;
    plans?: boolean;
    calendar?: 404 | { status: 'connected' | 'disconnected' };
    extra?: Record<string, Handler>;
  } = {},
) {
  let profile = options.profile ?? profileView();
  const off = profile === 404;
  const state = {
    get profile() {
      return profile === 404 ? null : profile;
    },
  };
  const read = async (request: Request) =>
    (await request.clone().json()) as Record<string, unknown>;
  const api = installApi({
    ...(options.plans ? planRoutes() : { 'GET /api/v1/me': () => json(meBody()) }),
    'GET /api/v1/me/profile': () =>
      off ? apiError(404, 'not_found', 'Resource not found.') : json(profile),
    'PUT /api/v1/me/profile/answers': async (request) => {
      if (profile === 404) return apiError(404, 'not_found', 'Resource not found.');
      const body = await read(request);
      profile = { ...profile, answers: { ...profile.answers, ...(body.answers as object) } };
      return json(profile);
    },
    'PUT /api/v1/me/profile/import': async (request) => {
      if (profile === 404) return apiError(404, 'not_found', 'Resource not found.');
      const body = (await read(request)) as unknown as ProfileView & { education: string | null };
      profile = {
        ...profile,
        skills: body.skills.map((s) => ({ ...s, source: 'cv' as const })),
        rolesHeld: body.rolesHeld,
        yearsExperience: body.yearsExperience,
        cvImportedAt: '2026-11-08T10:00:00.000Z',
      };
      return json(profile);
    },
    'PATCH /api/v1/me/profile/setup': async (request) => {
      if (profile === 404) return apiError(404, 'not_found', 'Resource not found.');
      const body = await read(request);
      profile = {
        ...profile,
        setupStatus: body.status as ProfileView['setupStatus'],
        setupStep: (body.step as string | undefined) ?? null,
        setupCompletedAt: body.status === 'completed' ? '2026-11-08T10:00:00.000Z' : null,
      };
      return json(profile);
    },
    'DELETE /api/v1/me/profile': () => {
      profile = profileView({ setupStatus: 'dismissed' });
      return json(profile);
    },
    ...(options.calendar === undefined || options.calendar === 404
      ? {}
      : {
          'GET /api/v1/calendar': () =>
            json({
              status: (options.calendar as { status: string }).status,
              lastSyncedAt: null,
              lastErrorCode: null,
              sources: [],
            }),
          'POST /api/v1/calendar/sync': () =>
            json({
              status: 'cached',
              syncedAt: null,
              movedTaskIds: [],
              finishChanged: false,
              text: '',
            }),
        }),
    ...options.extra,
  });
  return Object.assign(api, { state });
}

/** Every request the app made to the profile routes, parsed. */
export async function profileCalls(api: ReturnType<typeof installSetupApi>) {
  const out: { method: string; path: string; body: unknown }[] = [];
  for (const call of api.calls) {
    const path = new URL(call.url).pathname;
    if (!path.startsWith('/api/v1/me/profile')) continue;
    const text = await call.clone().text();
    out.push({ method: call.method, path, body: text ? JSON.parse(text) : undefined });
  }
  return out;
}
