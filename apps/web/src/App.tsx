import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { createApiClient } from './api/client';
import { ApiProvider } from './api/ApiProvider';
import type { AuthService } from './auth/auth-service';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAccount } from './auth/RequireAccount';
import { DemoBanner } from './components/EnvironmentBadge';
import type { Env } from './env';
import { AppShell, PublicShell } from './layout/Shell';
import { CalendarCallbackPage } from './pages/CalendarCallbackPage';
import { BriefingPage } from './pages/briefing/BriefingPage';
import { LegalPage } from './pages/LegalPage';
import { ActivePlanProvider } from './plan/ActivePlan';
import { PlanLayout } from './plan/PlanSummaryBar';
import { Loading } from './components/status';
import { PlanPage } from './pages/PlanPage';
import { PracticePage } from './pages/practice/PracticePage';
import { PracticeTrendsPage } from './pages/practice-trends/PracticeTrendsPage';
import { ReviewPage } from './pages/review/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { SignInPage } from './pages/SignInPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';

// Loaded on first visit only: the wizard (and, behind it, the CV reader) stays out of the main chunk.
const SetupPage = lazy(() =>
  import('./pages/setup/SetupPage').then((m) => ({ default: m.SetupPage })),
);

const TailorCvPage = lazy(() =>
  import('./pages/cv-tailor/TailorCvPage').then((m) => ({ default: m.TailorCvPage })),
);
// The plan builder page: its own chunk, loaded when the route opens. The builder code itself
// (`@upversion/shared/plan-builder`) is never imported by the web: the API runs it.
const PlanBuilderPage = lazy(() =>
  import('./pages/plan-builder/PlanBuilderPage').then((m) => ({ default: m.PlanBuilderPage })),
);
const ChangeCvPage = lazy(() =>
  import('./pages/settings/ChangeCvPage').then((m) => ({ default: m.ChangeCvPage })),
);

/**
 * The whole app. The router is supplied from outside (BrowserRouter in production, MemoryRouter in
 * tests), and so are the query client and the auth service.
 */
export function App({
  env,
  queryClient,
  auth,
}: {
  env: Env;
  queryClient: QueryClient;
  auth: AuthService;
}) {
  const api = useMemo(
    () => createApiClient({ baseUrl: env.apiUrl, getAccessToken: () => auth.getAccessToken() }),
    [env.apiUrl, auth],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider service={auth}>
        <ApiProvider client={api}>
          <a
            href="#main"
            className="fixed left-4 top-4 z-20 inline-flex min-h-11 -translate-y-[200%] items-center rounded-sm bg-accent px-4 py-3 font-bold text-on-accent focus:translate-y-0"
          >
            Skip to main content
          </a>
          <DemoBanner appEnv={env.appEnv} />
          <Routes>
            <Route element={<PublicShell appEnv={env.appEnv} />}>
              <Route path="/signin" element={<SignInPage />} />
              <Route path="/terms" element={<LegalPage slug="terms" />} />
              <Route path="/privacy" element={<LegalPage slug="privacy" />} />
              <Route path="/disclaimer" element={<LegalPage slug="disclaimer" />} />
            </Route>
            <Route element={<RequireAccount appEnv={env.appEnv} />}>
              <Route element={<AppShell appEnv={env.appEnv} />}>
                <Route element={<ActivePlanProvider />}>
                  <Route element={<PlanLayout />}>
                    <Route index element={<TodayPage apiUrl={env.apiUrl} />} />
                    <Route path="week" element={<WeekPage />} />
                    <Route path="plan" element={<PlanPage />} />
                    <Route
                      path="plan/new"
                      element={
                        <Suspense fallback={<Loading label="Loading…" />}>
                          <PlanBuilderPage />
                        </Suspense>
                      }
                    />
                    <Route path="plan/:taskId" element={<TaskDetailPage />} />
                  </Route>
                  <Route path="briefing/:date" element={<BriefingPage />} />
                  <Route path="practice-history" element={<PracticeTrendsPage />} />
                  <Route path="practice/:taskId" element={<PracticePage />} />
                  <Route path="review/:date" element={<ReviewPage />} />
                  <Route
                    path="setup"
                    element={
                      <Suspense fallback={<Loading label="Loading…" />}>
                        <SetupPage />
                      </Suspense>
                    }
                  />
                  <Route path="calendar/callback" element={<CalendarCallbackPage />} />
                  <Route path="settings" element={<SettingsPage appEnv={env.appEnv} />} />
                  <Route
                    path="settings/tailor-cv"
                    element={
                      <Suspense fallback={<Loading label="Loading…" />}>
                        <TailorCvPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="settings/cv"
                    element={
                      <Suspense fallback={<Loading label="Loading…" />}>
                        <ChangeCvPage />
                      </Suspense>
                    }
                  />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
