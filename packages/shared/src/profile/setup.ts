import { CATALOG_QUESTIONS } from './catalog';
import type { CatalogQuestion, SetupQuestion } from './types';

type Flagged = CatalogQuestion & { setup: NonNullable<CatalogQuestion['setup']> };

/**
 * The setup questions: every `questions.json` entry carrying a `setup` flag, sorted by
 * `setup.order`. `show_if` and `allow_other` are removed (setup shows the question regardless
 * of `goal_type` and takes choices only); `required` is false when `setup.optional`; `setup.why` replaces `why`.
 * Never hard-codes a question: changing the set is a data change.
 */
export function setupQuestions(
  questions: readonly CatalogQuestion[] = CATALOG_QUESTIONS,
): SetupQuestion[] {
  return questions
    .filter((q): q is Flagged => Boolean(q.setup))
    .sort((a, b) => a.setup.order - b.setup.order)
    .map((q) => {
      const out: Partial<CatalogQuestion> = {
        ...q,
        required: q.required && !q.setup.optional,
        ...(q.setup.why ? { why: q.setup.why } : {}),
      };
      delete out.show_if;
      delete out.allow_other;
      return out as SetupQuestion;
    });
}
