import catalogData from '../../../../data/catalog/catalog.json';
import rolesData from '../../../../data/catalog/roles.json';
import skillsData from '../../../../data/catalog/skills.json';
import type { BuildCatalog, CatalogItem, CatalogRole, CatalogSkill } from './catalog';

/**
 * The catalog JSON of `data/catalog/`, bundled at build time. Only the API imports this (through
 * `@upversion/shared/plan-builder`); the web must not pull it into its main bundle.
 */
export const BUNDLED_CATALOG: BuildCatalog = {
  items: (catalogData as unknown as { items: CatalogItem[] }).items,
  roles: (rolesData as unknown as { roles: CatalogRole[] }).roles,
  skills: (skillsData as unknown as { skills: CatalogSkill[] }).skills,
};
