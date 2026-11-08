import { CATALOG_TAXONOMY, type SetupQuestion } from '@upversion/shared';

/** Whether an answer counts as given (a default the person keeps counts too). */
export function isAnswered(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

/** The hint under a question when an earlier answer matches `hint_if` (e.g. working full-time). */
export function hintFor(question: SetupQuestion, answers: Record<string, unknown>): string | null {
  const rules = question.hint_if as Record<string, Record<string, string>> | undefined;
  if (!rules) return null;
  for (const [otherId, byValue] of Object.entries(rules)) {
    const given = answers[otherId];
    if (typeof given === 'string' && typeof byValue[given] === 'string') return byValue[given];
  }
  return null;
}

/** Sunday first, the same numbering as the scheduling engine (0 = Sunday). */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** An answer in words, for the summary. */
export function describeAnswer(question: SetupQuestion, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const label = (v: string) => {
    const option = question.options?.find((o) => (typeof o === 'string' ? o : o.value) === v);
    return option === undefined ? v : typeof option === 'string' ? option : option.label;
  };
  switch (question.type) {
    case 'single':
      return typeof value === 'string' ? label(value) : null;
    case 'yes_no':
      return value === true ? 'Yes' : value === false ? 'No' : null;
    case 'number':
      return typeof value === 'number' ? (value === 1 ? '1 hour' : `${value} hours`) : null;
    case 'weekdays':
      return Array.isArray(value) && value.length > 0
        ? (value as number[]).map((d) => DAYS[d] ?? String(d)).join(', ')
        : null;
    case 'multi_role':
      return Array.isArray(value) && value.length > 0
        ? (value as string[])
            .map((id) => CATALOG_TAXONOMY.roles.find((r) => r.id === id)?.title ?? id)
            .join(', ')
        : null;
    case 'multi_skill':
      return Array.isArray(value) && value.length > 0
        ? (value as string[])
            .map((id) => CATALOG_TAXONOMY.skills.find((s) => s.id === id)?.name ?? id)
            .join(', ')
        : null;
    default:
      return Array.isArray(value) && value.length > 0
        ? (value as string[]).map(label).join(', ')
        : null;
  }
}
