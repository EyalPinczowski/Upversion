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

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selectors, first match wins. A step with no match on the screen is skipped. */
  targets: string[];
}

const nav = (href: string) => `nav[aria-label="Main"] a[href="${href}"]`;

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'today',
    title: 'Today',
    body: 'Your tasks for today. Start here each day.',
    targets: [nav('/')],
  },
  {
    id: 'week',
    title: 'Week',
    body: 'The week at a glance, so you can see what is coming.',
    targets: [nav('/week')],
  },
  {
    id: 'plan',
    title: 'Plan',
    body: 'Your study plan. Changes to it are suggestions until you approve them.',
    targets: [nav('/plan')],
  },
  {
    id: 'plan-curriculum',
    title: 'Curriculum',
    body: 'What your plan covers, topic by topic.',
    targets: ['[data-tour="plan-curriculum"]'],
  },
  {
    id: 'plan-settings',
    title: 'Plan settings',
    body: 'How much time you give the plan and when it runs.',
    targets: ['[data-tour="plan-settings"]'],
  },
  {
    id: 'settings',
    title: 'Settings',
    body: 'Your time, appearance and data. AI and calendar are optional extras.',
    targets: [nav('/settings')],
  },
];

/** The steps that have something to point at right now. */
export function resolveTourSteps(
  steps: TourStep[] = TOUR_STEPS,
  root: ParentNode = document,
): TourStep[] {
  return steps.filter((step) => step.targets.some((selector) => root.querySelector(selector)));
}
