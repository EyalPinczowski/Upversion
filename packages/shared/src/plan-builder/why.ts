import { skillName } from './catalog';
import { levelLabel, type BuildContext } from './context';
import type { Member, Resolved } from './resolve';

/** "A", "A and B", "A, B and C", "A, B and 2 more": built from catalog names only. */
export function joinNames(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(', ')} and ${extra} more`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] as string}`;
}

function range(values: readonly number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/**
 * Step 12: the "why this is here" line. A fixed template filled with catalog names, skill
 * levels and numbers only; no AI and no user text.
 */
export function whyLine(ctx: BuildContext, member: Member, resolved: Resolved): string {
  switch (member.origin) {
    case 'prerequisite': {
      const titles = member.requiredBy
        .map((id) => resolved.byId.get(id)?.item.title)
        .filter((t): t is string => t !== undefined);
      return `Required before ${joinNames(titles) || 'a later item'}.`;
    }
    case 'practice':
      return 'Practice for interviews (you asked for interview prep).';
    case 'opt_in':
      return member.kind === 'exam'
        ? 'You chose to add this exam.'
        : 'You chose to add the certificate for this course.';
    case 'must_include':
      return 'You asked to include this item.';
    case 'free_alternative':
      return 'A free alternative to a paid item that was over your budget.';
    case 'certificate': {
      const names = member.item.skills
        .filter((s) => ctx.targetById.has(s))
        .map((s) => skillName(ctx.index, s));
      return names.length > 0
        ? `Official exam for ${joinNames(names)}; you asked for certificates.`
        : 'Official exam; you asked for certificates.';
    }
    case 'gap':
    default:
      return gapLine(ctx, member);
  }
}

function gapLine(ctx: BuildContext, member: Member): string {
  const roleSkills = member.gapSkills.filter((s) => !ctx.targetById.get(s)?.extra);
  const extraSkills = member.gapSkills.filter((s) => ctx.targetById.get(s)?.extra);
  const parts: string[] = [];
  if (roleSkills.length > 0) {
    const weights = roleSkills.map((s) => ctx.targetById.get(s)?.weight ?? 0);
    const levels = [...new Set(roleSkills.map((s) => ctx.targetById.get(s)?.level ?? 0))].sort(
      (a, b) => a - b,
    );
    const them = roleSkills.length === 1 ? 'it' : 'them';
    parts.push(
      `Teaches ${joinNames(roleSkills.map((s) => skillName(ctx.index, s)))} – the role weights ${them} ${range(weights)} and you rated ${them} ${joinNames(levels.map(levelLabel))}.`,
    );
  }
  if (extraSkills.length > 0) {
    parts.push(`You asked to learn ${joinNames(extraSkills.map((s) => skillName(ctx.index, s)))}.`);
  }
  if (parts.length === 0) {
    const roleTitles = ctx.request.targetRoleIds
      .map((r) => ctx.index.roles.get(r)?.title)
      .filter((t): t is string => t !== undefined);
    return `Part of the suggested path for ${joinNames(roleTitles)}.`;
  }
  return parts.join(' ');
}
