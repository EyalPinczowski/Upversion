import { CATALOG_TAXONOMY } from '../profile/catalog';
import { extractProfileFromText, matchSkillsInText } from '../profile/cv-match';
import type { CvMatchOptions, MatchTaxonomy } from '../profile/types';

/** Catalog skills of a role with at least this weight are added to the job's skills. */
export const ROLE_SKILL_MIN_WEIGHT = 4;

export interface KeywordGapItem {
  skillId: string;
  /** Catalog name: the fallback label when no wording from the texts is available. */
  name: string;
  /**
   * The text's own wordings for the skill (job side: the job post's, CV side: the CV's), most
   * frequent first, capped, normalised, never containing contact text. Empty for a skill that
   * comes only from the picked role. Shown in the browser only.
   */
  terms: string[];
  /** What the chip shows: the first term, or the catalog name when there is none. */
  label: string;
  /** How often the job post names it (0 for a skill that comes only from the picked role). */
  hits: number;
}

export interface KeywordGaps {
  /** In the job post and in the CV: shown to the user as already covered. */
  matched: KeywordGapItem[];
  /** In the job post, not in the CV: "add them in your own words if you have them". */
  missing: KeywordGapItem[];
  /** In the CV, not in the job post. */
  cvOnly: KeywordGapItem[];
}

export interface KeywordGapOptions {
  taxonomy?: MatchTaxonomy;
  /** A `roles.json` id: the role's heavier catalog skills count as wanted. Unknown ids are ignored. */
  roleId?: string;
  now?: CvMatchOptions['now'];
}

/**
 * Deterministic keyword gaps, no AI, runs in the browser on the raw texts (matching needs the raw
 * text: `ASP.NET`, `03/2018`). Job skills come from the job-post matcher (no sections, no
 * contact-block drop); CV skills from the CV matcher. Each item carries the
 * text's own wording of the skill (`terms`, `label`): the job post's for `matched` and `missing`,
 * the CV's for `cvOnly`; the catalog name is only the fallback. `matched` and `missing` are sorted by hits in the job post, `cvOnly` by name.
 */
export function keywordGaps(
  cvText: string,
  jobText: string,
  options: KeywordGapOptions = {},
): KeywordGaps {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const names = new Map(taxonomy.skills.map((s) => [s.id, s.name]));

  const job = new Map<string, { hits: number; terms: string[] }>(
    matchSkillsInText(jobText, { taxonomy }).map((h) => [
      h.skillId,
      { hits: h.hits, terms: h.terms },
    ]),
  );
  const role = options.roleId ? taxonomy.roles.find((r) => r.id === options.roleId) : undefined;
  for (const s of role?.skills ?? []) {
    if (s.weight >= ROLE_SKILL_MIN_WEIGHT && names.has(s.skill) && !job.has(s.skill)) {
      job.set(s.skill, { hits: 0, terms: [] });
    }
  }
  const cv = new Map<string, string[]>(
    extractProfileFromText(cvText, { taxonomy, now: options.now }).skills.map((s) => [
      s.skillId,
      s.terms,
    ]),
  );

  const item = (skillId: string, hits: number, terms: string[]): KeywordGapItem => {
    const name = names.get(skillId) ?? skillId;
    return { skillId, name, hits, terms, label: terms[0] ?? name };
  };
  const byHits = (a: KeywordGapItem, b: KeywordGapItem): number =>
    b.hits - a.hits || a.name.localeCompare(b.name);

  const matched: KeywordGapItem[] = [];
  const missing: KeywordGapItem[] = [];
  for (const [id, j] of job) (cv.has(id) ? matched : missing).push(item(id, j.hits, j.terms));
  const cvOnly = [...cv]
    .filter(([id]) => !job.has(id))
    .map(([id, terms]) => item(id, 0, terms))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { matched: matched.sort(byHits), missing: missing.sort(byHits), cvOnly };
}
