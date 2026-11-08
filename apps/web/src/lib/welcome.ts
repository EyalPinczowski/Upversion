/**
 * Whether this person has seen the first-visit welcome. There is no per-user preferences store in
 * the API or database yet, so it is remembered in this browser only, keyed by user id. Storage can
 * be blocked or throw (private windows): then it is remembered for this visit only, in memory.
 */
const keyFor = (userId: string) => `upversion.welcome-seen.${userId}`;
const seenInMemory = new Set<string>();

export const WELCOME_REOPEN_EVENT = 'upversion:welcome-reopen';

export function hasSeenWelcome(userId: string): boolean {
  if (seenInMemory.has(userId)) return true;
  try {
    return window.localStorage.getItem(keyFor(userId)) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeSeen(userId: string, { persist = true } = {}): void {
  seenInMemory.add(userId);
  if (!persist) return;
  try {
    window.localStorage.setItem(keyFor(userId), '1');
  } catch {
    // Not remembered across visits.
  }
}

/** Test helper: forget the in-memory part so a test starts as a first visit. */
export function resetWelcomeMemory(): void {
  seenInMemory.clear();
}

/** Asks the app shell to open the welcome dialog again (the Settings "Help" button). */
export function requestWelcome(): void {
  window.dispatchEvent(new Event(WELCOME_REOPEN_EVENT));
}

/** Routes where the welcome never opens, even though they sit inside the signed-in shell. */
export const WELCOME_EXCLUDED_PATHS = ['/calendar/callback'];

/** `/calendar/callback/` and `/calendar/callback` are the same page. */
export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function isWelcomeExcluded(pathname: string): boolean {
  return WELCOME_EXCLUDED_PATHS.includes(normalizePath(pathname));
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** The page the target lives on. The tour goes there when the step is reached. */
  route: string;
  /** CSS selectors, first match wins. A step whose target never shows up is skipped. */
  targets: string[];
}

const nav = (href: string) => `nav[aria-label="Main"] a[href="${href}"]`;

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'today',
    title: 'Today',
    body: 'Your tasks for today. Start here each day.',
    route: '/',
    targets: [nav('/')],
  },
  {
    id: 'week',
    title: 'Week',
    body: 'The week at a glance, so you can see what is coming.',
    route: '/week',
    targets: [nav('/week')],
  },
  {
    id: 'plan',
    title: 'Plan',
    body: 'Your study plan. Changes to it are suggestions until you approve them.',
    route: '/plan',
    targets: [nav('/plan')],
  },
  {
    id: 'plan-curriculum',
    title: 'Curriculum',
    body: 'What your plan covers, topic by topic.',
    route: '/plan',
    targets: ['[data-tour="plan-curriculum"]'],
  },
  {
    id: 'plan-settings',
    title: 'Plan settings',
    body: 'Your study time (which days and how many hours) and the plan itself.',
    route: '/plan',
    targets: ['[data-tour="plan-settings"]'],
  },
  {
    id: 'settings',
    title: 'Settings',
    body: 'Appearance, AI use, privacy and data, your account and connections. AI is optional.',
    route: '/settings',
    targets: [nav('/settings')],
  },
];

export function findTourTarget(step: TourStep, root: ParentNode = document): Element | null {
  for (const selector of step.targets) {
    const el = root.querySelector(selector);
    if (el) return el;
  }
  return null;
}
