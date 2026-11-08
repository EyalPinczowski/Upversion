import { APP_NAME } from '@upversion/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { CalendarWatcher } from '../components/CalendarWatcher';
import { EnvironmentBadge } from '../components/EnvironmentBadge';
import { PlanIcon, SettingsIcon, TodayIcon, WeekIcon } from '../components/icons';
import { Logo } from '../components/Logo';
import { WelcomeGuide } from '../components/welcome/WelcomeGuide';
import type { AppEnv } from '../env';
import { SetupRedirect } from '../pages/setup/SetupRedirect';

/** Moves focus to the page content after a route change, so keyboard and screen reader users start there. */
function useFocusMainOnNavigation() {
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);
  return main;
}

/** Page width steps: phone and tablet 6xl, desktop (1024+) 7xl, wide (1440+) a little more. */
const FRAME = 'mx-auto max-w-6xl lg:max-w-7xl min-[1440px]:max-w-[90rem]';

function Header({ appEnv }: { appEnv: AppEnv }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className={`${FRAME} flex min-h-16 items-center gap-3 px-4`}>
        <Logo title={null} />
        <span className="text-h2 font-bold">{APP_NAME}</span>
        <span className="ml-auto">
          <EnvironmentBadge appEnv={appEnv} />
        </span>
      </div>
    </header>
  );
}

/** Signed-out pages: sign-in, legal documents, and the screens shown before the app opens. */
export function PublicShell({ appEnv, children }: { appEnv: AppEnv; children?: ReactNode }) {
  const main = useFocusMainOnNavigation();
  return (
    <>
      <Header appEnv={appEnv} />
      <main ref={main} id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-6">
        {children ?? <Outlet />}
      </main>
    </>
  );
}

const NAV = [
  { to: '/', label: 'Today', end: true, Icon: TodayIcon },
  { to: '/week', label: 'Week', end: false, Icon: WeekIcon },
  { to: '/plan', label: 'Plan', end: false, Icon: PlanIcon },
  { to: '/settings', label: 'Settings', end: false, Icon: SettingsIcon },
];

const itemBase = 'flex items-center gap-2 font-bold no-underline';

/** Pages that use the extra width of a desktop (two columns); the others keep a reading column. */
const WIDE_PATHS = new Set(['/', '/week']);

/**
 * The signed-in app. Phone (under 640 px): tab bar along the bottom. Tablet (640 to 1023): side
 * rail. Desktop (1024 and up): a wider persistent sidebar, with the content in a centred column.
 */
export function AppShell({ appEnv }: { appEnv: AppEnv }) {
  const main = useFocusMainOnNavigation();
  const { pathname } = useLocation();
  const wide = WIDE_PATHS.has(pathname);
  return (
    <>
      <Header appEnv={appEnv} />
      <div className={`${FRAME} flex`}>
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] sm:static sm:inset-auto sm:block sm:w-56 sm:shrink-0 sm:self-start sm:overflow-visible sm:border-t-0 sm:border-r sm:bg-transparent sm:p-3 sm:pb-3 lg:sticky lg:top-0 lg:w-64 lg:p-4"
        >
          {NAV.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `${itemBase} min-h-16 min-w-24 shrink-0 grow flex-col justify-center border-t-4 px-3 text-sm sm:min-h-11 sm:min-w-0 sm:flex-row sm:justify-start sm:rounded-sm sm:border-t-0 sm:border-l-4 sm:px-3 sm:py-2 sm:text-base ${
                  isActive
                    ? 'border-accent bg-accent-soft text-accent-soft-text'
                    : 'border-transparent text-muted hover:text-text'
                }`
              }
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className="min-w-0 grow px-4 pb-28 pt-6 sm:px-8 sm:pb-8"
        >
          <div className={wide ? 'max-w-3xl lg:max-w-none' : 'max-w-3xl'}>
            <CalendarWatcher />
            <WelcomeGuide />
            <SetupRedirect />
            <Outlet />
          </div>
        </main>
      </div>
    </>
  );
}
