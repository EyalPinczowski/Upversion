import { CATALOG_TAXONOMY } from './catalog';
import type { AnswerResult, CatalogQuestion, MatchTaxonomy, QuestionOption } from './types';

function optionValues(options: readonly QuestionOption[] | undefined): string[] {
  return (options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
}

const bad = (error: string): AnswerResult => ({ ok: false, error });

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string')) return null;
  return value as string[];
}

function hasDuplicates(list: readonly unknown[]): boolean {
  return new Set(list).size !== list.length;
}

/**
 * Checks one answer against its question definition. Supported types (the setup allowlist):
 * single, multi, weekdays, number, yes_no, multi_role, multi_skill. Anything else is rejected.
 * For `multi_role` / `multi_skill` only taxonomy ids are accepted: "Other" or a typed value is
 * never valid, whatever `allow_other` says on the question.
 */
export function validateAnswer(
  question: Pick<CatalogQuestion, 'type' | 'options' | 'min' | 'max' | 'step'>,
  value: unknown,
  taxonomy: MatchTaxonomy = CATALOG_TAXONOMY,
): AnswerResult {
  switch (question.type) {
    case 'single': {
      const allowed = optionValues(question.options);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return bad('Not one of the options');
      }
      return { ok: true, value };
    }
    case 'multi': {
      const list = stringList(value);
      if (!list) return bad('Expected a list of options');
      if (hasDuplicates(list)) return bad('Duplicate options');
      const allowed = optionValues(question.options);
      if (!list.every((v) => allowed.includes(v))) return bad('Not one of the options');
      if (question.max !== undefined && list.length > question.max) return bad('Too many options');
      return { ok: true, value: list };
    }
    case 'weekdays': {
      if (!Array.isArray(value) || value.length === 0) return bad('Pick at least one day');
      const days = value as unknown[];
      if (!days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
        return bad('Days are 0 to 6');
      }
      if (hasDuplicates(days)) return bad('Duplicate days');
      return { ok: true, value: [...(days as number[])].sort((a, b) => a - b) };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('Expected a number');
      const { min, max, step } = question;
      if (min !== undefined && value < min) return bad('Below the minimum');
      if (max !== undefined && value > max) return bad('Above the maximum');
      if (step !== undefined && step > 0) {
        const steps = (value - (min ?? 0)) / step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) return bad('Not a multiple of the step');
      }
      return { ok: true, value };
    }
    case 'yes_no':
      return typeof value === 'boolean' ? { ok: true, value } : bad('Expected yes or no');
    case 'multi_role':
    case 'multi_skill': {
      const list = stringList(value);
      if (!list) return bad('Expected a list of ids');
      if (hasDuplicates(list)) return bad('Duplicate ids');
      const ids = new Set(
        (question.type === 'multi_role' ? taxonomy.roles : taxonomy.skills).map((x) => x.id),
      );
      if (!list.every((id) => ids.has(id))) return bad('Unknown id');
      if (question.max !== undefined && list.length > question.max) return bad('Too many choices');
      return { ok: true, value: list };
    }
    default:
      return bad('Question type is not allowed in setup');
  }
}
