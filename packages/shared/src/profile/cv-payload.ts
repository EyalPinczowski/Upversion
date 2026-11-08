import { redactPii } from '../practice/redact';
import { catalogToolLabels, CATALOG_TAXONOMY } from './catalog';
import type { EducationLevel, ProfileImport } from './schemas';
import {
  EDUCATION_LEVELS,
  MAX_PROFILE_SKILLS,
  MAX_ROLE_TITLE_LENGTH,
  MAX_ROLES_HELD,
  MAX_YEARS,
  ProfileImportSchema,
} from './schemas';
import type { MatchTaxonomy } from './types';

/** What the review screen holds after the user ticked and edited rows (extra fields are ignored). */
export interface ConfirmedImport {
  skills: readonly { skillId: string; level: number }[];
  rolesHeld: readonly { roleId?: string | null; title: string; years?: number | null }[];
  yearsExperience?: number | null;
  education?: string | null;
  tools?: readonly string[];
}

export interface ImportPayloadOptions {
  taxonomy?: MatchTaxonomy;
  tools?: readonly string[];
}

const clampYears = (y: number): number => Math.min(MAX_YEARS, Math.max(0, Math.round(y * 2) / 2));

/**
 * Builds the request body from an allowlist of fields: `skills[{skillId, level}]`,
 * `rolesHeld[{roleId, title, years}]`, `yearsExperience`, `education`, `tools[]`.
 * Nothing else can pass: no evidence, no raw text, no file name, no contact details (titles go
 * through `redactPii` again and a title that held personal details is dropped).
 * Unknown skill or role ids, unknown tools and unknown education values are dropped.
 */
export function toImportPayload(
  confirmed: ConfirmedImport,
  options: ImportPayloadOptions = {},
): ProfileImport {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const skillIds = new Set(taxonomy.skills.map((s) => s.id));
  const roleIds = new Set(taxonomy.roles.map((r) => r.id));
  const toolLabels = options.tools ?? catalogToolLabels();

  const seenSkills = new Set<string>();
  const skills: ProfileImport['skills'] = [];
  for (const s of confirmed.skills) {
    if (!skillIds.has(s.skillId) || seenSkills.has(s.skillId)) continue;
    if (!Number.isFinite(s.level)) continue;
    seenSkills.add(s.skillId);
    skills.push({ skillId: s.skillId, level: Math.min(3, Math.max(0, Math.round(s.level))) });
  }

  const rolesHeld: ProfileImport['rolesHeld'] = [];
  for (const r of confirmed.rolesHeld) {
    const red = redactPii(String(r.title));
    if (red.count > 0) continue;
    const title = red.text.replace(/\s+/g, ' ').trim().slice(0, MAX_ROLE_TITLE_LENGTH).trim();
    if (title === '') continue;
    const roleId = r.roleId && roleIds.has(r.roleId) ? r.roleId : null;
    const years =
      typeof r.years === 'number' && Number.isFinite(r.years) ? clampYears(r.years) : null;
    rolesHeld.push({ roleId, title, years });
  }

  const years = confirmed.yearsExperience;
  const education = (EDUCATION_LEVELS as readonly string[]).includes(confirmed.education ?? '')
    ? (confirmed.education as EducationLevel)
    : null;
  const tools = toolLabels.filter((t) => confirmed.tools?.includes(t));

  return ProfileImportSchema.parse({
    skills: skills.slice(0, MAX_PROFILE_SKILLS),
    rolesHeld: rolesHeld.slice(0, MAX_ROLES_HELD),
    yearsExperience: typeof years === 'number' && Number.isFinite(years) ? clampYears(years) : null,
    education,
    tools,
  });
}
