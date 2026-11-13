import { compareDates, diffDays, hoursToMinutes, parseTime, type LocalDate } from '../dates';
import type { CatalogIndex } from './catalog';
import type { BuildRequest } from './schemas';

export type BuildRequestIssueCode =
  | 'unknown_role'
  | 'unknown_skill'
  | 'unknown_catalog_id'
  | 'duplicate_id'
  | 'deadline_not_after_start'
  | 'deadline_in_past'
  | 'not_a_certificate'
  | 'exam_date_too_late'
  | 'exam_date_out_of_range'
  | 'deadline_too_far'
  | 'exam_dates_overlap';

export interface BuildRequestIssue {
  code: BuildRequestIssueCode;
  message: string;
  /** The offending id, when there is one. */
  id?: string;
}

/** The deadline may be at most this many days after the start date (a longer plan is not a study plan, and the engine would be asked to look years ahead). */
export const MAX_DEADLINE_DAYS = 730;

/** The longest exam block the builder plans (owner Q11: every exam block is at most 2 hours). */
export const MAX_EXAM_BLOCK_HOURS = 2;

/** The length of the exam block of a catalog exam: its estimate when that is at most 2 hours, else 2 hours. */
export function examBlockHours(estHours: number): number {
  return estHours <= MAX_EXAM_BLOCK_HOURS ? estHours : MAX_EXAM_BLOCK_HOURS;
}

/** Thrown by `buildPlan` for a request the catalog or the dates cannot satisfy (the API answers 422). */
export class BuildRequestError extends Error {
  readonly issues: BuildRequestIssue[];
  constructor(issues: BuildRequestIssue[]) {
    super(`Invalid plan request: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'BuildRequestError';
    this.issues = issues;
  }
}

/** Checks a parsed request against the catalog and the dates. Empty list: it is usable. */
export function validateBuildRequest(
  request: BuildRequest,
  index: CatalogIndex,
  today: LocalDate,
): BuildRequestIssue[] {
  const issues: BuildRequestIssue[] = [];
  const dup = (list: readonly string[], what: string) => {
    for (const id of new Set(list.filter((x, i) => list.indexOf(x) !== i))) {
      issues.push({ code: 'duplicate_id', message: `${what} lists ${id} twice`, id });
    }
  };
  dup(request.targetRoleIds, 'targetRoleIds');
  dup(request.extraSkillIds, 'extraSkillIds');
  dup(request.certificateOptIns, 'certificateOptIns');
  dup(request.mustInclude, 'mustInclude');
  dup(request.exclude, 'exclude');
  dup(
    request.examDates.map((e) => e.catalogId),
    'examDates',
  );

  for (const id of request.targetRoleIds) {
    if (!index.roles.has(id))
      issues.push({ code: 'unknown_role', message: `Unknown role ${id}`, id });
  }
  const skillKnown = (id: string) => index.skillNames.has(id);
  for (const id of [...request.extraSkillIds, ...Object.keys(request.skillLevels)]) {
    if (!skillKnown(id)) issues.push({ code: 'unknown_skill', message: `Unknown skill ${id}`, id });
  }
  const itemIds = [
    ...request.certificateOptIns,
    ...request.mustInclude,
    ...request.exclude,
    ...Object.keys(request.priorityOverrides),
    ...request.examDates.map((e) => e.catalogId),
  ];
  for (const id of itemIds) {
    if (!index.byId.has(id)) {
      issues.push({ code: 'unknown_catalog_id', message: `Unknown catalog item ${id}`, id });
    }
  }
  for (const id of request.certificateOptIns) {
    const item = index.byId.get(id);
    if (item && item.type !== 'cert_exam' && item.cost_type !== 'free_audit') {
      issues.push({
        code: 'not_a_certificate',
        message: `${id} has no certificate to add`,
        id,
      });
    }
  }
  for (const e of request.examDates) {
    const item = index.byId.get(e.catalogId);
    if (!item) continue;
    if (item.type !== 'cert_exam') {
      issues.push({
        code: 'not_a_certificate',
        message: `${e.catalogId} is not an exam`,
        id: e.catalogId,
      });
      continue;
    }
    const firstDay = compareDates(request.startDate, today) >= 0 ? request.startDate : today;
    if (compareDates(e.date, firstDay) < 0 || compareDates(e.date, request.deadline) > 0) {
      issues.push({
        code: 'exam_date_out_of_range',
        message: `The ${e.catalogId} exam date must be between ${firstDay} and the deadline`,
        id: e.catalogId,
      });
    }
    const end = parseTime(e.start) + hoursToMinutes(examBlockHours(item.est_hours));
    if (end > 1439) {
      issues.push({
        code: 'exam_date_too_late',
        message: `The ${e.catalogId} exam must end by 23:59`,
        id: e.catalogId,
      });
    }
  }
  // Two exams cannot happen at the same time (each takes its exam block from its start time).
  const slots = request.examDates.flatMap((e) => {
    const item = index.byId.get(e.catalogId);
    if (!item || item.type !== 'cert_exam') return [];
    const start = parseTime(e.start);
    return [
      {
        id: e.catalogId,
        date: e.date,
        start,
        end: start + hoursToMinutes(examBlockHours(item.est_hours)),
      },
    ];
  });
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      if (a.date === b.date && a.start < b.end && b.start < a.end) {
        issues.push({
          code: 'exam_dates_overlap',
          message: `The ${a.id} and ${b.id} exams overlap on ${a.date}`,
          id: b.id,
        });
      }
    }
  }
  if (compareDates(request.deadline, request.startDate) <= 0) {
    issues.push({
      code: 'deadline_not_after_start',
      message: 'The deadline must be after the start date',
    });
  }
  if (diffDays(request.startDate, request.deadline) > MAX_DEADLINE_DAYS) {
    issues.push({
      code: 'deadline_too_far',
      message: `The deadline may be at most ${MAX_DEADLINE_DAYS} days after the start date`,
    });
  }
  if (compareDates(request.deadline, today) < 0) {
    issues.push({ code: 'deadline_in_past', message: 'The deadline is in the past' });
  }
  return issues;
}
