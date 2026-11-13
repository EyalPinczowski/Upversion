import type { CatalogIndex } from './catalog';
import type { BuildRequest } from './schemas';

/** The weight an extra skill (one the user asked for by name) gets (ADR 017 step 1). */
export const EXTRA_SKILL_WEIGHT = 4;
/** Comfortable on the `skill_levels` scale. */
export const LEVEL_COMFORTABLE = 2;
export const LEVEL_BASIC = 1;
/** Role skills with at least this weight need Comfortable; the others need Basic. */
export const HEAVY_WEIGHT = 4;

export interface TargetSkill {
  skillId: string;
  /** 1 to 5 (role weight; the larger one when two roles list it; 4 for an extra skill). */
  weight: number;
  /** The level the plan aims for: 2 (Comfortable) or 1 (Basic). */
  need: number;
  /** The user's level (0 when not rated). */
  level: number;
  gap: number;
  /** weight x gap. */
  priority: number;
  /** True when the user asked for the skill by name (not only through a role). */
  extra: boolean;
  /** Role ids that list the skill. */
  roleIds: string[];
}

/** Step 1: gaps between the user's levels and what the target roles (and extra skills) need. Sorted by priority, then id. */
export function computeTargets(request: BuildRequest, index: CatalogIndex): TargetSkill[] {
  const map = new Map<string, TargetSkill>();
  const levelOf = (id: string) => request.skillLevels[id] ?? 0;
  const upsert = (
    skillId: string,
    weight: number,
    need: number,
    extra: boolean,
    roleId?: string,
  ) => {
    const current = map.get(skillId);
    if (current) {
      current.weight = Math.max(current.weight, weight);
      current.need = Math.max(current.need, need);
      current.extra = current.extra || extra;
      if (roleId && !current.roleIds.includes(roleId)) current.roleIds.push(roleId);
      return;
    }
    map.set(skillId, {
      skillId,
      weight,
      need,
      level: levelOf(skillId),
      gap: 0,
      priority: 0,
      extra,
      roleIds: roleId ? [roleId] : [],
    });
  };
  for (const roleId of request.targetRoleIds) {
    const role = index.roles.get(roleId);
    if (!role) continue;
    for (const s of role.skills) {
      upsert(
        s.skill,
        s.weight,
        s.weight >= HEAVY_WEIGHT ? LEVEL_COMFORTABLE : LEVEL_BASIC,
        false,
        roleId,
      );
    }
  }
  for (const skillId of request.extraSkillIds) {
    upsert(skillId, EXTRA_SKILL_WEIGHT, LEVEL_COMFORTABLE, true);
  }
  const targets = [...map.values()];
  for (const t of targets) {
    t.gap = Math.max(0, t.need - t.level);
    t.priority = t.weight * t.gap;
  }
  return targets.sort((a, b) => b.priority - a.priority || (a.skillId < b.skillId ? -1 : 1));
}
