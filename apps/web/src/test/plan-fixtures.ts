import type {
  DayState,
  OpenTasks,
  PlanDetail,
  PlanSummary,
  Progress,
  Schedule,
  SchedulePreview,
  Task,
  WeekPattern,
} from '../api/client';
import { json } from './helpers';

export const PLAN_ID = '22222222-2222-4222-8222-222222222222';
export const NOW = '2026-11-01T08:00:00.000Z';

export const planSummary = (overrides: Partial<PlanSummary> = {}): PlanSummary => ({
  id: PLAN_ID,
  name: 'Demo plan',
  status: 'active',
  createdFrom: 'import',
  startDate: '2026-11-03',
  endDate: '2026-11-26',
  summary: {},
  taskCount: 3,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const taskView = (overrides: Partial<Task> = {}): Task => ({
  id: 'sql1',
  title: 'Intro to SQL',
  type: 'course',
  estHours: 3,
  doneHours: 1,
  status: 'in_progress',
  order: 1,
  dependsOn: [],
  isAnchor: false,
  splittable: true,
  isCertificate: false,
  lessons: [],
  howToSteps: [],
  source: 'import',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const TASKS: Task[] = [
  taskView({
    id: 'setup',
    title: 'Set up accounts',
    type: 'admin',
    estHours: 0.5,
    doneHours: 0.5,
    status: 'done',
    order: 0,
  }),
  taskView({
    id: 'sql1',
    title: 'Intro to SQL',
    type: 'course',
    dependsOn: ['setup'],
    isCertificate: true,
    certificateName: 'SQL certificate',
    url: 'https://example.test/sql',
    howToSteps: ['Create a free account', 'Finish all lessons'],
    lessons: [
      {
        title: 'Select basics',
        url: 'https://example.test/sql/1',
        estMinutes: 30,
        needsCheck: true,
      },
      { title: 'Joins', needsCheck: false },
    ],
    notes: 'Take notes as you go.',
  }),
  taskView({
    id: 'exam',
    title: 'SQL exam',
    type: 'cert_exam',
    estHours: 1,
    doneHours: 0,
    status: 'pending',
    order: 2,
    dependsOn: ['sql1'],
    isAnchor: true,
    anchorDate: '2026-11-19',
    anchorStartTime: '10:00',
  }),
];

export const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  today: '2026-11-10',
  timezone: 'Asia/Jerusalem',
  finishDate: '2026-11-20',
  blocks: [
    {
      taskId: 'sql1',
      date: '2026-11-10',
      start: '09:00',
      end: '10:30',
      minutes: 90,
      kind: 'study',
    },
    {
      taskId: 'sql1',
      date: '2026-11-11',
      start: '09:00',
      end: '11:00',
      minutes: 120,
      kind: 'study',
    },
    {
      taskId: 'exam',
      date: '2026-11-19',
      start: '10:00',
      end: '11:00',
      minutes: 60,
      kind: 'anchor',
    },
  ],
  warnings: [],
  ...overrides,
});

export const anchorAtRisk: Schedule['warnings'][number] = {
  kind: 'anchor_at_risk',
  taskId: 'exam',
  anchorDate: '2026-11-19',
  anchorStartTime: '10:00',
  shortfallMinutes: 90,
  lateTaskIds: ['sql1'],
  options: [{ kind: 'add_hours', minutes: 90 }, { kind: 'add_day' }],
};

export const progress = (overrides: Partial<Progress> = {}): Progress => ({
  hours: { planned: 4.5, done: 1.5 },
  tasks: { total: 3, done: 1, skipped: 0 },
  certificatesEarned: 0,
  certificates: [],
  byType: [],
  byDay: [],
  ...overrides,
});

export const WEEK_PATTERN: WeekPattern = {
  studyWeekdays: [0, 1, 2, 3, 4],
  defaultHours: 7,
  hoursByWeekday: {},
  windowStart: '09:00',
  windowEnd: '17:30',
  lunchStart: '13:00',
  lunchEnd: '14:00',
  breakEveryHours: 2,
  breakMinutes: 10,
  minBlockMinutes: 30,
  timezone: 'Asia/Jerusalem',
};

export const planDetail = (overrides: Partial<PlanDetail> = {}): PlanDetail =>
  ({
    ...planSummary(),
    weekPattern: WEEK_PATTERN,
    overrides: [{ date: '2026-11-12', isStudyDay: false }],
    tasks: [],
    ...overrides,
  }) as PlanDetail;

export const previewResult = (text: string): SchedulePreview => ({
  today: '2026-11-10',
  summary: {
    movedTaskIds: ['sql1'],
    finishBefore: '2026-11-20',
    finishAfter: '2026-11-23',
    finishChanged: true,
    finishShiftStudyDays: 1,
    newAnchorRisks: [],
    text,
  },
  current: { finishDate: '2026-11-20', warnings: [] },
  proposed: { finishDate: '2026-11-23', warnings: [], blocks: [] },
});

export const openTasks = (overrides: Partial<OpenTasks> = {}): OpenTasks => ({
  today: '2026-11-10',
  weekStart: '2026-11-08',
  weekEnd: '2026-11-14',
  tasks: [],
  ...overrides,
});

export const dayState = (overrides: Partial<DayState> = {}): DayState => ({
  date: '2026-11-10',
  status: 'not_started',
  startedAt: null,
  endedAt: null,
  frozen: null,
  ...overrides,
});

/** A day that answers "not started" with nothing frozen, whatever the date. */
export function dayRoutes(
  state: (date: string) => DayState = (date) => dayState({ date }),
): Record<string, (request: Request) => Response> {
  const date = (request: Request) => new URL(request.url).pathname.split('/').at(-1)!;
  return {
    [`GET /api/v1/plans/${PLAN_ID}/days/2026-11-10`]: (r) => json(state(date(r))),
  };
}

/** Routes for a signed-in person with one plan; pass overrides to change single answers. */
export function planRoutes(
  extra: Record<string, (request: Request) => Response | Promise<Response>> = {},
) {
  return {
    'GET /api/v1/me': () =>
      json({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'dana@example.com',
        displayName: null,
        role: 'user',
        createdAt: NOW,
        lastSeenAt: null,
        legal: {
          terms: { currentVersion: '0.1', accepted: true },
          privacy: { currentVersion: '0.1', accepted: true },
          allAccepted: true,
        },
      }),
    'GET /api/v1/plans': () => json({ plans: [planSummary()] }),
    [`GET /api/v1/plans/${PLAN_ID}`]: () => json(planDetail()),
    [`GET /api/v1/plans/${PLAN_ID}/schedule`]: () => json(schedule()),
    [`GET /api/v1/plans/${PLAN_ID}/tasks`]: () => json({ tasks: TASKS }),
    [`GET /api/v1/plans/${PLAN_ID}/progress`]: () => json(progress()),
    [`GET /api/v1/plans/${PLAN_ID}/logs`]: () => json({ logs: [] }),
    [`GET /api/v1/plans/${PLAN_ID}/practice/context`]: () =>
      json({ jobDescription: '', updatedAt: null }),
    [`GET /api/v1/plans/${PLAN_ID}/open-tasks`]: () => json(openTasks()),
    ...dayRoutes(),
    ...extra,
  };
}
