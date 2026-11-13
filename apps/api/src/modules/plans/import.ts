import { createHash } from 'node:crypto';
import { parsePlanFile, TAXONOMY_SKILL_IDS, type PlanFile } from '@upversion/shared';
import { ZodError } from 'zod';
import { HttpError } from '../../errors';
import { MAX_OVERRIDES_PER_PLAN, MAX_TASKS_PER_PLAN } from './schemas';

export interface ValidImport {
  status: 'draft' | 'active';
  plan: PlanFile;
  /** Identifies the content, so a retry with the same id can be told from a different plan. */
  payloadHash: string;
}

const unprocessable = (message: string) => new HttpError(422, 'unprocessable', message);

function describe(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, 5)
      .map((i) => `${i.path.length ? i.path.join('.') : 'plan'}: ${i.message}`);
    return `Invalid plan file. ${issues.join('; ')}`;
  }
  // parsePlanFile's own checks (duplicate ids, unknown dependencies) are safe to show.
  if (error instanceof Error) return `Invalid plan file. ${error.message}`;
  return 'Invalid plan file.';
}

/** JSON with sorted keys, so equal content always gives equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The plan's skill ids without repeats (first occurrence wins), or undefined when there are none,
 * so `[]` and a missing field mean the same thing. Every id must be in the taxonomy; the message
 * names the position and echoes only the offending id (cut short), nothing else.
 */
function checkedSkillIds(ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  const unknown = ids.map((id, i) => ({ id, i })).filter(({ id }) => !TAXONOMY_SKILL_IDS.has(id));
  if (unknown.length > 0) {
    const where = unknown.slice(0, 5).map(({ i }) => `skillIds.${i}`);
    throw unprocessable(
      `Invalid plan file. ${where.join(', ')}: unknown skill id (first: "${unknown[0]!.id.slice(0, 40)}"). Use ids from the skill taxonomy.`,
    );
  }
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique : undefined;
}

/**
 * Everything beyond the shared schema that the database would otherwise reject with a 500:
 * blank names, an end before the start, duplicate override dates, characters Postgres cannot
 * store, and the size limits.
 */
export function validateImport(
  body: Record<string, unknown>,
  status: 'draft' | 'active' | undefined,
): ValidImport {
  if (Array.isArray(body.tasks) && body.tasks.length > MAX_TASKS_PER_PLAN) {
    throw unprocessable(`A plan can have at most ${MAX_TASKS_PER_PLAN} tasks.`);
  }
  if (Array.isArray(body.overrides) && body.overrides.length > MAX_OVERRIDES_PER_PLAN) {
    throw unprocessable(`A plan can have at most ${MAX_OVERRIDES_PER_PLAN} day overrides.`);
  }
  let plan: PlanFile;
  try {
    plan = parsePlanFile(body);
  } catch (error) {
    throw unprocessable(describe(error));
  }
  if (plan.name.trim() === '') throw unprocessable('The plan name cannot be blank.');
  const blank = plan.tasks.find((t) => t.title.trim() === '' || t.id.trim() === '');
  if (blank) throw unprocessable('Task ids and titles cannot be blank.');
  if (plan.endDate !== undefined && plan.endDate < plan.startDate) {
    throw unprocessable('endDate cannot be before startDate.');
  }
  const dates = new Set(plan.overrides.map((o) => o.date));
  if (dates.size !== plan.overrides.length) {
    throw unprocessable('Day overrides must have distinct dates.');
  }
  const skillIds = checkedSkillIds(plan.skillIds);
  plan = { ...plan, skillIds };
  // Postgres text and jsonb cannot hold a NUL character; JSON.stringify writes it as \u0000.
  if (JSON.stringify(plan).includes('\\u0000')) {
    throw unprocessable('The plan contains a character that cannot be stored.');
  }
  const finalStatus = status ?? 'active';
  const payloadHash = createHash('sha256')
    .update(canonical({ status: finalStatus, plan }))
    .digest('hex');
  return { status: finalStatus, plan, payloadHash };
}

/** The plan's headline numbers, stored in `plans.summary` (spec 4: hours, certs). */
export function summarize(
  plan: PlanFile,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(plan.skillIds && plan.skillIds.length > 0 ? { skillIds: plan.skillIds } : {}),
    hours: Math.round(plan.tasks.reduce((sum, t) => sum + t.estHours, 0) * 100) / 100,
    certs: plan.tasks.filter((t) => t.isCertificate).length,
    ...extra,
  };
}
