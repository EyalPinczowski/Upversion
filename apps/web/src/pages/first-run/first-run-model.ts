import { CATALOG_QUESTIONS } from '@upversion/shared';
import { ROLES, type BuilderState } from '../plan-builder/builder-model';

export const FIRST_RUN_STEPS = [
  { title: 'What are you aiming for?' },
  { title: 'Where are you now?' },
  { title: 'How much time and money?' },
  { title: 'Your draft plan' },
] as const;
/** The profile answers each screen saves (ids of `questions.json` that the profile accepts). */
export function answersForStep(step: number, s: BuilderState): Record<string, unknown> {
  if (step === 1) return { target_role: s.roleIds, target_skills: s.extraSkillIds };
  if (step === 3) {
    const hours = Number(s.hours.trim().replace(',', '.'));
    return {
      days_per_week: [...s.weekdays].sort((a, b) => a - b),
      // Only a multiple of 0.5: one value the profile would refuse must not drop the other answers.
      ...(Number.isFinite(hours) && hours >= 0.5 && hours <= 12 && (hours * 2) % 1 === 0
        ? { hours_per_day: hours }
        : {}),
      time_of_day: s.timeOfDay,
    };
  }
  return {};
}

interface DiscoverOption {
  value: string;
  label: string;
  roles: string[];
}

export const DISCOVER_ENJOY_ID = 'discover_enjoy';
export const DISCOVER_STYLE_ID = 'discover_style';
export const DISCOVER_PICK_ID = 'discover_pick';

const question = (id: string) => CATALOG_QUESTIONS.find((q) => q.id === id);

/** The "kinds of work" options of `discover_enjoy`, each with the roles it points to. */
export function enjoyOptions(): DiscoverOption[] {
  return ((question(DISCOVER_ENJOY_ID)?.options ?? []) as Partial<DiscoverOption>[]).flatMap((o) =>
    o.value && o.label ? [{ value: o.value, label: o.label, roles: o.roles ?? [] }] : [],
  );
}

export function enjoyMax(): number {
  return question(DISCOVER_ENJOY_ID)?.max ?? 3;
}

export function styleOptions(): { value: string; label: string }[] {
  return ((question(DISCOVER_STYLE_ID)?.options ?? []) as { value: string; label: string }[]).map(
    (o) => ({ value: o.value, label: o.label }),
  );
}

/** A work style leans toward some of the "kinds of work" (a small rule-based nudge, no AI). */
const STYLE_LEANS: Record<string, string[]> = {
  focus: ['data', 'technical', 'building'],
  people: ['people', 'growth'],
};

const MAX_SUGGESTIONS = 4;

/**
 * 3 to 4 roles from `roles.json` for the kinds of work a person enjoys (ADR 018, "Not sure").
 * Pure: more matching options first, a work style breaks ties, then the order of the options.
 */
export function suggestRoles(enjoy: string[], style: string | null): string[] {
  const known = new Set(ROLES.map((r) => r.id));
  const options = enjoyOptions().filter((o) => enjoy.includes(o.value));
  const score = new Map<string, number>();
  for (const o of options) {
    const lean = style !== null && (STYLE_LEANS[style] ?? []).includes(o.value);
    for (const id of o.roles) {
      if (known.has(id)) score.set(id, (score.get(id) ?? 0) + 1 + (lean ? 0.5 : 0));
    }
  }
  const order = new Map<string, number>();
  options.flatMap((o) => o.roles).forEach((id, i) => order.has(id) || order.set(id, i));
  return [...score.keys()]
    .sort((a, b) => score.get(b)! - score.get(a)! || order.get(a)! - order.get(b)!)
    .slice(0, MAX_SUGGESTIONS);
}
