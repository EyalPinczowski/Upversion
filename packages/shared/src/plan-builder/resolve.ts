import { closureOf, type BuildContext, type Root } from './context';
import type { CatalogItem } from './catalog';
import type { BuildItemKind, BuildItemOrigin, BuildTier } from './schemas';

/** An item in the plan: a chosen root or a prerequisite added around one. */
export interface Member {
  id: string;
  item: CatalogItem;
  kind: BuildItemKind;
  root: Root | null;
  origin: BuildItemOrigin;
  /** The paid certificate of a `free_audit` item is bought (the user opted in). */
  paidCertificate: boolean;
  /** Ids of members that list this one as a required prerequisite. */
  requiredBy: string[];
  /** Effective tier: core when the member itself or anything that requires it is core. */
  tier: BuildTier;
  /** Effective priority: the larger of its own and that of everything that requires it. */
  priority: number;
  ownPriority: number;
  /** Gap skills the item teaches. */
  gapSkills: string[];
}

export interface Resolved {
  /** In id order. */
  members: Member[];
  byId: Map<string, Member>;
  skipped: { catalogId: string; message: string }[];
}

export function kindOf(item: CatalogItem): BuildItemKind {
  return item.type === 'cert_exam' ? 'exam' : item.type === 'practice' ? 'practice' : 'course';
}

/** Gap skills the item teaches, highest priority first. */
export function gapSkillsOf(ctx: BuildContext, item: CatalogItem): string[] {
  return item.skills
    .filter((s) => ctx.gapIds.has(s))
    .sort((a, b) => {
      const pa = ctx.targetById.get(a)?.priority ?? 0;
      const pb = ctx.targetById.get(b)?.priority ?? 0;
      return pb - pa || (a < b ? -1 : 1);
    });
}

export function ownPriorityOf(ctx: BuildContext, item: CatalogItem): number {
  return gapSkillsOf(ctx, item).reduce((sum, s) => sum + (ctx.targetById.get(s)?.priority ?? 0), 0);
}

/**
 * Step 4: the plan's members for a set of roots. Each root brings the closure of its required
 * prerequisites (the roots were checked before, so the closure of each is known to be usable).
 */
export function resolveRoots(ctx: BuildContext, roots: readonly Root[]): Resolved {
  const byId = new Map<string, Member>();
  const skipped = new Map<string, string>();
  const add = (item: CatalogItem, root: Root | null, origin: BuildItemOrigin) => {
    const existing = byId.get(item.id);
    if (existing) {
      if (root && !existing.root) {
        existing.root = root;
        existing.origin = root.origin;
        existing.paidCertificate = root.paidCertificate;
      }
      return;
    }
    const own = ownPriorityOf(ctx, item);
    byId.set(item.id, {
      id: item.id,
      item,
      kind: kindOf(item),
      root,
      origin: root ? root.origin : origin,
      paidCertificate: root?.paidCertificate ?? false,
      requiredBy: [],
      tier: root ? root.tier : 'optional',
      priority: own,
      ownPriority: own,
      gapSkills: gapSkillsOf(ctx, item),
    });
  };
  const sorted = [...roots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const root of sorted) {
    const item = ctx.index.byId.get(root.id);
    if (!item) continue;
    add(item, root, root.origin);
    const closure = closureOf(ctx, item);
    if (!closure.ok) continue;
    for (const s of closure.skipped) skipped.set(s.catalogId, s.message);
    for (const pid of closure.required) {
      const p = ctx.index.byId.get(pid);
      if (p) add(p, null, 'prerequisite');
    }
  }
  const members = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of members) {
    for (const pid of m.item.prerequisites) {
      if (m.item.prerequisite_kinds[pid] === 'recommended') continue;
      byId.get(pid)?.requiredBy.push(m.id);
    }
  }
  // Tier and priority flow from dependents to prerequisites until nothing changes.
  for (let pass = 0; pass <= members.length; pass++) {
    let changed = false;
    for (const m of members) {
      for (const did of m.requiredBy) {
        const d = byId.get(did);
        if (!d) continue;
        if (d.tier === 'core' && m.tier !== 'core') {
          m.tier = 'core';
          changed = true;
        }
        if (d.priority > m.priority) {
          m.priority = d.priority;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const skippedList = [...skipped]
    .filter(([id]) => !byId.has(id))
    .map(([catalogId, message]) => ({ catalogId, message }))
    .sort((a, b) => (a.catalogId < b.catalogId ? -1 : 1));
  return { members, byId, skipped: skippedList };
}

/**
 * The roots that stay when `dropId` is removed: every root that needs it (directly or through
 * other prerequisites) goes too, so a dependent is never left without its prerequisite.
 */
export function rootsWithout(ctx: BuildContext, roots: readonly Root[], dropId: string): Root[] {
  const dropped = new Set<string>([dropId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of roots) {
      if (dropped.has(r.id)) continue;
      const item = ctx.index.byId.get(r.id);
      const closure = item ? closureOf(ctx, item) : null;
      if (closure?.ok && closure.required.some((id) => dropped.has(id))) {
        dropped.add(r.id);
        grew = true;
      }
    }
  }
  return roots.filter((r) => !dropped.has(r.id));
}

export function droppedBy(ctx: BuildContext, roots: readonly Root[], dropId: string): string[] {
  const keep = new Set(rootsWithout(ctx, roots, dropId).map((r) => r.id));
  return roots.filter((r) => !keep.has(r.id)).map((r) => r.id);
}
