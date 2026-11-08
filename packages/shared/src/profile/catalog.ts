import questionsData from '../../../../data/catalog/questions.json';
import rolesData from '../../../../data/catalog/roles.json';
import skillsData from '../../../../data/catalog/skills.json';
import type { CatalogQuestion, MatchTaxonomy } from './types';

/** Catalog JSON as shipped in `data/catalog/` (bundled at build time, no I/O at run time). */
export const CATALOG_QUESTIONS: readonly CatalogQuestion[] = (
  questionsData as unknown as { questions: CatalogQuestion[] }
).questions;

export const CATALOG_TAXONOMY: MatchTaxonomy = {
  skills: (skillsData as unknown as { skills: MatchTaxonomy['skills'] }).skills,
  roles: (rolesData as unknown as { roles: MatchTaxonomy['roles'] }).roles,
};

/** Labels of the `tools_known` options. */
export function catalogToolLabels(): string[] {
  const q = CATALOG_QUESTIONS.find((x) => x.id === 'tools_known');
  return (q?.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
}
