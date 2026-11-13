import {
  addDays,
  CATALOG_QUESTIONS,
  CATALOG_TAXONOMY,
  diffDays,
  isLocalDate,
  isTime,
  MAX_DEADLINE_DAYS,
  MAX_EXTRA_SKILLS,
  MAX_TARGET_ROLES,
  parseTime,
  prefillFromProfile,
  TIME_OF_DAY_WINDOWS,
  type SkillSource,
} from '@upversion/shared';
import type { BuildRequestBody, ProfileView } from '../../api/client';
import { isApiError } from '../../api/errors';

/** What the person has chosen so far. Kept in the page's state only; nothing is saved before "Start this plan". */
export interface BuilderState {
  roleIds: string[];
  extraSkillIds: string[];
  /** Levels the person set on step 2 (they win over the profile's). */
  edited: Record<string, number>;
  startDate: string;
  deadline: string;
  weekdays: number[];
  hours: string;
  timeOfDay: string;
  timezone: string;
  budgetMode: 'free' | 'limit' | 'flexible';
  amount: string;
  maxItemPrice: string;
  certPreference: 'must' | 'nice' | 'none';
  interviewPrep: 'yes' | 'later' | 'no';
  certificateOptIns: string[];
  examDates: { catalogId: string; date: string; start: string }[];
  exclude: string[];
  priorityOverrides: Record<string, 'core' | 'optional'>;
}

export interface Prefill {
  /** Levels and where they came from (the profile), for skills of the pre-filled roles. */
  levels: Record<string, number>;
  sources: Record<string, SkillSource | null>;
  /** The profile's own skills, for roles the person adds on step 1. */
  profileSkills: Record<string, { level: number; source: SkillSource }>;
}

export const SOURCE_LABELS: Record<SkillSource, string> = {
  cv: 'from your CV',
  setup: 'from setup',
  manual: 'you set this',
};

export const TIME_OF_DAY_CHOICES = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'flexible', label: 'Flexible' },
] as const;

export const ROLES = [...CATALOG_TAXONOMY.roles].sort((a, b) => a.title.localeCompare(b.title));
export const SKILLS = [...CATALOG_TAXONOMY.skills].sort((a, b) => a.name.localeCompare(b.name));
const SKILL_NAME = new Map(CATALOG_TAXONOMY.skills.map((s) => [s.id, s.name]));
const ROLE_TITLE = new Map(CATALOG_TAXONOMY.roles.map((r) => [r.id, r.title]));
export const skillName = (id: string) => SKILL_NAME.get(id) ?? id;
export const roleTitle = (id: string) => ROLE_TITLE.get(id) ?? id;

export const HOURS_MIN = 0.5;
export const HOURS_MAX = 12;
export const MAX_ROLES = MAX_TARGET_ROLES;
export const MAX_EXTRAS = MAX_EXTRA_SKILLS;

/** Options of a question in `questions.json` (never hard-coded here): value and label. */
export function questionOptions(id: string): { value: string; label: string }[] {
  const q = CATALOG_QUESTIONS.find((x) => x.id === id);
  return (q?.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

export function questionText(id: string): string {
  return CATALOG_QUESTIONS.find((x) => x.id === id)?.text ?? '';
}

/** The browser's IANA time zone, or UTC when it is unusable as an id. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The skills a role asks for, heaviest first. */
export function roleSkills(roleId: string): { skill: string; weight: number }[] {
  const role = CATALOG_TAXONOMY.roles.find((r) => r.id === roleId);
  return [...(role?.skills ?? [])].sort(
    (a, b) => b.weight - a.weight || (a.skill < b.skill ? -1 : 1),
  );
}

/** The skills shown on step 2: those of the chosen roles (heaviest first), then the extra ones. */
export function relevantSkillIds(state: Pick<BuilderState, 'roleIds' | 'extraSkillIds'>): string[] {
  const out: string[] = [];
  for (const roleId of state.roleIds) {
    for (const { skill } of roleSkills(roleId)) if (!out.includes(skill)) out.push(skill);
  }
  for (const id of state.extraSkillIds) if (!out.includes(id)) out.push(id);
  return out;
}

export function levelOf(state: BuilderState, prefill: Prefill, skillId: string): number {
  return (
    state.edited[skillId] ?? prefill.levels[skillId] ?? prefill.profileSkills[skillId]?.level ?? 0
  );
}

/** Where a level came from, in words: "not rated" when nothing is known. */
export function levelSource(state: BuilderState, prefill: Prefill, skillId: string): string {
  if (state.edited[skillId] !== undefined) return 'you set this (for this plan only)';
  const source = prefill.sources[skillId] ?? prefill.profileSkills[skillId]?.source ?? null;
  return source ? SOURCE_LABELS[source] : 'not rated';
}

/** The first state of the builder: the profile's answers where there are any, plain defaults elsewhere. */
export function initialState(
  profile: ProfileView | null,
  today: string,
  timezone: string,
): { state: BuilderState; prefill: Prefill } {
  const { request, levelSources } = prefillFromProfile(
    { answers: profile?.answers ?? {}, skills: profile?.skills ?? [] },
    CATALOG_QUESTIONS,
    { today, timezone },
  );
  const startDate = request.startDate ?? addDays(today, 1);
  const pattern = request.weekPattern;
  const timeOfDay =
    TIME_OF_DAY_CHOICES.find(
      (c) =>
        TIME_OF_DAY_WINDOWS[c.value]?.windowStart === pattern?.windowStart &&
        TIME_OF_DAY_WINDOWS[c.value]?.windowEnd === pattern?.windowEnd,
    )?.value ?? 'flexible';
  const budgetMode = request.budget?.mode === 'flexible' ? 'flexible' : 'free';
  const state: BuilderState = {
    roleIds: request.targetRoleIds ?? [],
    extraSkillIds: request.extraSkillIds ?? [],
    edited: {},
    startDate,
    deadline: request.deadline ?? addDays(startDate, 28),
    weekdays: pattern?.studyWeekdays ?? [0, 1, 2, 3, 4],
    hours: String(pattern?.defaultHours ?? 3),
    timeOfDay,
    timezone,
    budgetMode,
    amount: '',
    maxItemPrice: '',
    certPreference: request.certPreference ?? 'nice',
    interviewPrep: request.interviewPrep ?? 'no',
    certificateOptIns: [],
    examDates: [],
    exclude: [],
    priorityOverrides: {},
  };
  const profileSkills: Prefill['profileSkills'] = {};
  for (const s of profile?.skills ?? []) {
    profileSkills[s.skillId] = { level: s.level, source: s.source };
  }
  return {
    state,
    prefill: {
      levels: Object.fromEntries(
        Object.entries(request.skillLevels ?? {}).map(([k, v]) => [k, Number(v)]),
      ),
      sources: levelSources,
      profileSkills,
    },
  };
}

export type StepErrors = Record<string, string>;

function parsePositive(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Problems that make a step unfinished, by field. Empty when the step is fine. */
export function validateStep(step: number, s: BuilderState): StepErrors {
  const errors: StepErrors = {};
  if (step === 1) {
    if (s.roleIds.length === 0) errors.roles = 'Choose at least one role.';
    if (s.roleIds.length > MAX_ROLES) errors.roles = `Choose at most ${MAX_ROLES} roles.`;
  }
  if (step === 3) {
    if (!isLocalDate(s.startDate)) errors.startDate = 'Enter a start date.';
    if (!isLocalDate(s.deadline)) errors.deadline = 'Enter a finish date.';
    else if (isLocalDate(s.startDate)) {
      if (diffDays(s.startDate, s.deadline) <= 0) {
        errors.deadline = 'The finish date must be after the start date.';
      } else if (diffDays(s.startDate, s.deadline) > MAX_DEADLINE_DAYS) {
        errors.deadline = `Choose a finish date within ${MAX_DEADLINE_DAYS} days of the start.`;
      }
    }
    if (s.weekdays.length === 0) errors.weekdays = 'Choose at least one study day.';
    const hours = parsePositive(s.hours);
    if (hours === null || hours < HOURS_MIN || hours > HOURS_MAX) {
      errors.hours = `Enter hours per study day from ${HOURS_MIN} to ${HOURS_MAX}.`;
    }
  }
  if (step === 4) {
    if (s.budgetMode === 'limit' && parsePositive(s.amount) === null) {
      errors.amount = 'Enter the most you want to spend, in US dollars.';
    }
    if (s.maxItemPrice.trim() !== '' && parsePositive(s.maxItemPrice) === null) {
      errors.maxItemPrice = 'Enter an amount above 0, or leave it empty.';
    }
  }
  return errors;
}

/** The request for the server, or null while a step before the draft is still unfinished. */
export function toRequest(s: BuilderState, prefill: Prefill): BuildRequestBody | null {
  for (const step of [1, 3, 4]) {
    if (Object.keys(validateStep(step, s)).length > 0) return null;
  }
  const window = TIME_OF_DAY_WINDOWS[s.timeOfDay] ?? TIME_OF_DAY_WINDOWS['flexible']!;
  if (!isTime(window.windowStart) || parseTime(window.windowEnd) <= parseTime(window.windowStart)) {
    return null;
  }
  const skillLevels: Record<string, number> = {};
  for (const id of relevantSkillIds(s)) skillLevels[id] = levelOf(s, prefill, id);
  const amount = parsePositive(s.amount);
  const maxItemPrice = parsePositive(s.maxItemPrice);
  return {
    targetRoleIds: s.roleIds,
    extraSkillIds: s.extraSkillIds,
    skillLevels,
    startDate: s.startDate,
    deadline: s.deadline,
    weekPattern: {
      studyWeekdays: [...s.weekdays].sort((a, b) => a - b),
      defaultHours: parsePositive(s.hours)!,
      hoursByWeekday: {},
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      timezone: s.timezone,
      breakEveryHours: 2,
      breakMinutes: 10,
      minBlockMinutes: 30,
    },
    budget: {
      mode: s.budgetMode,
      ...(s.budgetMode === 'limit' && amount !== null ? { amount } : {}),
      ...(s.budgetMode !== 'free' && maxItemPrice !== null ? { maxItemPrice } : {}),
    },
    certPreference: s.certPreference,
    interviewPrep: s.interviewPrep,
    certificateOptIns: s.certificateOptIns,
    examDates: s.examDates,
    mustInclude: [],
    exclude: s.exclude,
    priorityOverrides: s.priorityOverrides,
  };
}

/** The request as a string, to tell whether two requests are the same. */
export const requestKey = (r: BuildRequestBody | null): string => JSON.stringify(r);

const ISSUE_TEXT: Record<string, string> = {
  unknown_role: 'One of the roles is not in the catalog. Go back to step 1 and choose again.',
  unknown_skill: 'One of the skills is not in the catalog. Go back to step 1 and choose again.',
  unknown_catalog_id: 'One of the items is not in the catalog any more. Check the draft again.',
  duplicate_id: 'The same item or skill is listed twice. Go back and check your choices.',
  deadline_not_after_start: 'The finish date must be after the start date. Change it on step 3.',
  deadline_in_past: 'The finish date has already passed. Choose a later one on step 3.',
  not_a_certificate: 'One of the items you added as a certificate is not an exam.',
  exam_date_too_late: 'An exam date is after your finish date. Move the exam or the finish date.',
  exam_date_out_of_range:
    'An exam date is outside the plan’s dates. Choose a day between the start and the finish date.',
  deadline_too_far: `The finish date is too far away. Choose one within ${MAX_DEADLINE_DAYS} days of the start (step 3).`,
  exam_dates_overlap: 'Two exams are on the same day and time. Move one of them.',
};

/** Plain words for a failed preview or create. Never repeats text from the request. */
export function describeBuildError(error: unknown): string {
  if (!isApiError(error)) return 'Something went wrong. Nothing was created.';
  if (error.kind !== 'http') {
    return 'Can’t reach the server. Nothing was created. Check your connection and try again.';
  }
  switch (error.status) {
    case 400:
      return 'Something in your choices was not accepted. Go back and check the steps.';
    case 404:
      return 'The plan builder is not available right now.';
    case 422: {
      const texts = (error.issues ?? []).map((i) => ISSUE_TEXT[i.code]).filter(Boolean);
      return texts.length > 0
        ? [...new Set(texts)].join(' ')
        : 'Some of your choices can’t work together. Go back and check the dates and the roles.';
    }
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    default:
      return error.status >= 500
        ? 'Something went wrong on our side. Nothing was created. Try again in a moment.'
        : 'The plan could not be built. Nothing was created.';
  }
}
