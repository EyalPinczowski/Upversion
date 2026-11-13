import { addDays, type LocalDate } from '../dates';
import { CATALOG_TAXONOMY } from '../profile/catalog';
import type { SkillSource, UserProfile } from '../profile/schemas';
import type { CatalogQuestion, MatchTaxonomy } from '../profile/types';
import type { BuildRequestInput } from './schemas';

/** Study windows by the `time_of_day` answer (owner decision Q9). */
export const TIME_OF_DAY_WINDOWS: Record<string, { windowStart: string; windowEnd: string }> = {
  morning: { windowStart: '08:00', windowEnd: '12:00' },
  afternoon: { windowStart: '12:00', windowEnd: '17:00' },
  evening: { windowStart: '18:00', windowEnd: '22:00' },
  flexible: { windowStart: '09:00', windowEnd: '17:30' },
};

export interface PrefillOptions {
  /** Today in the user's time zone (the caller computes it). The start date is tomorrow. */
  today: LocalDate;
  /** The browser's time zone. */
  timezone: string;
  taxonomy?: MatchTaxonomy;
}

export interface PrefillResult {
  /** A partial request: only what the profile and setup answers say. The user fills the rest. */
  request: Partial<BuildRequestInput>;
  /** For each skill level in the request, where it came from; `null` when the skill is not rated yet. */
  levelSources: Record<string, SkillSource | null>;
  /** Skills of the target roles and extra skills that the profile has no level for ("not rated"). */
  notRated: string[];
}

function question(questions: readonly CatalogQuestion[], id: string): CatalogQuestion | undefined {
  return questions.find((q) => q.id === id);
}

function optionValues(q: CatalogQuestion | undefined): string[] {
  return (q?.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
}

function stringList(value: unknown, known: Set<string>, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && known.has(v) && !out.includes(v)) out.push(v);
  }
  return out.slice(0, max);
}

/**
 * Step 1 to 3 of the builder UI: a partial `BuildRequest` from the profile (setup answers and
 * `profile.skills` with their sources). Reads defaults and options from `questions.json`; the
 * target role and skill answers are checked against the catalog. No time zone is guessed: the
 * caller passes the browser's.
 */
export function prefillFromProfile(
  profile: Pick<UserProfile, 'answers' | 'skills'>,
  questions: readonly CatalogQuestion[],
  options: PrefillOptions,
): PrefillResult {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const answers = profile.answers;
  const roleIds = new Set(taxonomy.roles.map((r) => r.id));
  const skillIds = new Set(taxonomy.skills.map((s) => s.id));

  const roleQ = question(questions, 'target_role');
  const skillQ = question(questions, 'target_skills');
  const targetRoleIds = stringList(answers['target_role'], roleIds, roleQ?.max ?? 2);
  const extraSkillIds = stringList(answers['target_skills'], skillIds, skillQ?.max ?? 5);

  // Levels: the profile's own, for the skills of the chosen roles and extra skills.
  const levelSources: Record<string, SkillSource | null> = {};
  const skillLevels: Record<string, number> = {};
  const relevant = new Set<string>(extraSkillIds);
  for (const roleId of targetRoleIds) {
    const role = taxonomy.roles.find((r) => r.id === roleId);
    for (const s of role?.skills ?? []) relevant.add(s.skill);
  }
  const profileSkills = new Map(profile.skills.map((s) => [s.skillId, s]));
  const notRated: string[] = [];
  for (const id of [...relevant].sort()) {
    const known = profileSkills.get(id);
    if (known) {
      skillLevels[id] = known.level;
      levelSources[id] = known.source;
    } else {
      skillLevels[id] = 0;
      levelSources[id] = null;
      notRated.push(id);
    }
  }

  // Time: days and hours per day, and the window from the preferred time of day.
  const daysQ = question(questions, 'days_per_week');
  const hoursQ = question(questions, 'hours_per_day');
  const weekdays = Array.isArray(answers['days_per_week'])
    ? (answers['days_per_week'] as unknown[]).filter(
        (d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6,
      )
    : [];
  const defaultDays = Array.isArray(daysQ?.default) ? (daysQ.default as number[]) : [0, 1, 2, 3, 4];
  const hoursAnswer = answers['hours_per_day'];
  const defaultHours = typeof hoursQ?.default === 'number' ? hoursQ.default : 3;
  const todAnswer = answers['time_of_day'];
  const window =
    typeof todAnswer === 'string' && Object.hasOwn(TIME_OF_DAY_WINDOWS, todAnswer)
      ? (TIME_OF_DAY_WINDOWS[todAnswer] as { windowStart: string; windowEnd: string })
      : (TIME_OF_DAY_WINDOWS['flexible'] as { windowStart: string; windowEnd: string });
  const weeks = question(questions, 'timeframe') as
    (CatalogQuestion & { default_weeks?: number }) | undefined;
  const startDate = addDays(options.today, 1);

  const request: Partial<BuildRequestInput> = {
    ...(targetRoleIds.length > 0 ? { targetRoleIds } : {}),
    extraSkillIds,
    skillLevels,
    startDate,
    deadline: addDays(startDate, (weeks?.default_weeks ?? 4) * 7),
    weekPattern: {
      studyWeekdays:
        weekdays.length > 0 ? [...new Set(weekdays)].sort((a, b) => a - b) : defaultDays,
      defaultHours:
        typeof hoursAnswer === 'number' && Number.isFinite(hoursAnswer)
          ? hoursAnswer
          : defaultHours,
      ...window,
      timezone: options.timezone,
    },
  };

  // Budget, certificates and interview prep, when the answers carry them (never guessed).
  const choice = (id: string): string | undefined => {
    const v = answers[id];
    return typeof v === 'string' && optionValues(question(questions, id)).includes(v)
      ? v
      : undefined;
  };
  const budget = choice('budget');
  if (budget === 'free' || budget === 'flexible') request.budget = { mode: budget };
  const cert = choice('certificates');
  if (cert === 'must' || cert === 'nice' || cert === 'none') request.certPreference = cert;
  const prep = choice('interview_prep');
  if (prep === 'yes' || prep === 'later' || prep === 'no') request.interviewPrep = prep;
  return { request, levelSources, notRated };
}
