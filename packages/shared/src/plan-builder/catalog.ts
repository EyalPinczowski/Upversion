/**
 * The catalog as the plan builder reads it (ADR 017, WP-1). `buildPlan` takes a `BuildCatalog`
 * as an argument, so tests can pass a modified copy and the API can pass the bundled one
 * (`bundled.ts`, the only file that imports the JSON).
 */

export type CatalogItemType = 'course' | 'cert_exam' | 'practice';
export type CatalogCostType = 'free' | 'free_audit' | 'one_time' | 'subscription';
export type CatalogCertificateType = 'none' | 'completion' | 'official_exam' | 'skills_test';
export type CatalogLevel = 'beginner' | 'intermediate' | 'unspecified';
export type CatalogRecognition = 'high' | 'medium' | 'low';

export interface CatalogItem {
  id: string;
  type: CatalogItemType;
  title: string;
  provider: string;
  /** Null when no link is known. Only shown on a task when `url_verified` is true. */
  url: string | null;
  url_verified: boolean;
  cost_type: CatalogCostType;
  /** USD. Null: varies by country or unknown. */
  price: number | null;
  price_verified: boolean;
  currency: string;
  subscription_period: 'month' | 'year' | null;
  subscription_group: string | null;
  certificate_price: number | null;
  certificate_type: CatalogCertificateType;
  recognition: CatalogRecognition;
  level: CatalogLevel;
  est_hours: number;
  skills: string[];
  roles: string[];
  prerequisites: string[];
  prerequisite_kinds: Record<string, 'required' | 'recommended'>;
  free_alternative_ids: string[];
  notes?: string;
}

export interface CatalogRoleSkill {
  skill: string;
  weight: number;
}

export interface CatalogRole {
  id: string;
  title: string;
  skills: CatalogRoleSkill[];
  suggested_path: {
    core: string[];
    optional: string[];
    practice: string[];
    free_only: string[];
  };
}

export interface CatalogSkill {
  id: string;
  name: string;
}

export interface BuildCatalog {
  items: readonly CatalogItem[];
  roles: readonly CatalogRole[];
  skills: readonly CatalogSkill[];
}

/** Catalog lookups, built once per `buildPlan` call. Items are sorted by id, so the order of the input never matters. */
export interface CatalogIndex {
  items: CatalogItem[];
  byId: Map<string, CatalogItem>;
  roles: Map<string, CatalogRole>;
  skillNames: Map<string, string>;
}

export function indexCatalog(catalog: BuildCatalog): CatalogIndex {
  const items = [...catalog.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    roles: new Map(catalog.roles.map((r) => [r.id, r])),
    skillNames: new Map(catalog.skills.map((s) => [s.id, s.name])),
  };
}

export function skillName(index: CatalogIndex, skillId: string): string {
  return index.skillNames.get(skillId) ?? skillId;
}
