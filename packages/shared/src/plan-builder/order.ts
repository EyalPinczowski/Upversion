import type { BuildContext } from './context';
import type { Member, Resolved } from './resolve';
import { MAX_EXAM_BLOCK_HOURS } from './validate';

export interface Ordering {
  /** Member ids in plan order. */
  order: string[];
  /** For each member, the members it needs first (prerequisites, required or recommended, that are in the plan). */
  prereqs: Map<string, string[]>;
  /** For each practice member, the learning members it follows (same skill, learn before practice). */
  practiceAfter: Map<string, string[]>;
}

/** An exam of at most 2 hours is one task; a longer one gets a preparation task first. */
export function isShortExam(member: Member): boolean {
  return member.kind === 'exam' && member.item.est_hours <= MAX_EXAM_BLOCK_HOURS;
}

/** True for members whose work is learning (a course, or an exam with its own preparation task). */
function isLearning(m: Member): boolean {
  return m.kind === 'course' || (m.kind === 'exam' && !isShortExam(m));
}

/**
 * Step 8: a topological sort over the prerequisite and learn-before-practice edges. Among the
 * items that are ready, core goes before optional, then higher priority, then the lower catalog id.
 */
export function orderMembers(ctx: BuildContext, resolved: Resolved): Ordering {
  const { members, byId } = resolved;
  const prereqs = new Map<string, string[]>();
  for (const m of members) {
    prereqs.set(
      m.id,
      m.item.prerequisites.filter((p) => byId.has(p) && p !== m.id),
    );
  }
  const practiceAfter = new Map<string, string[]>();
  for (const m of members) {
    if (m.kind !== 'practice') continue;
    const after = members
      .filter(
        (l) =>
          isLearning(l) && l.id !== m.id && l.item.skills.some((s) => m.item.skills.includes(s)),
      )
      .map((l) => l.id);
    practiceAfter.set(m.id, after);
  }

  // An exam with a fixed date is an anchor: it and everything it needs go first, so they are done in time.
  const urgent = new Set<string>();
  const markUrgent = (id: string) => {
    if (urgent.has(id)) return;
    urgent.add(id);
    for (const p of prereqs.get(id) ?? []) markUrgent(p);
  };
  for (const e of ctx.request.examDates) if (byId.has(e.catalogId)) markUrgent(e.catalogId);

  const sortReady = (a: Member, b: Member) =>
    Number(urgent.has(b.id)) - Number(urgent.has(a.id)) ||
    Number(b.tier === 'core') - Number(a.tier === 'core') ||
    b.priority - a.priority ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const topo = (subset: Member[], edges: (id: string) => string[]): string[] => {
    const inSet = new Set(subset.map((m) => m.id));
    const remaining = new Map(subset.map((m) => [m.id, m]));
    const done = new Set<string>();
    const out: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining.values()].filter((m) =>
        edges(m.id).every((e) => !inSet.has(e) || done.has(e)),
      );
      // A cycle cannot happen in lint-checked catalog data; if it did, fall back to the best remaining item.
      const pool = ready.length > 0 ? ready : [...remaining.values()];
      const next = pool.sort(sortReady)[0] as Member;
      remaining.delete(next.id);
      done.add(next.id);
      out.push(next.id);
    }
    return out;
  };

  if (ctx.request.interviewPrep === 'later') {
    const learningOrder = topo(
      members.filter((m) => m.kind !== 'practice'),
      (id) => prereqs.get(id) ?? [],
    );
    const lastLearning = [...learningOrder].reverse().find((id) => {
      const m = byId.get(id);
      return m ? isLearning(m) : false;
    });
    if (lastLearning) {
      for (const [pid, after] of practiceAfter) {
        if (pid !== lastLearning && !after.includes(lastLearning)) after.push(lastLearning);
      }
    }
  }

  const order = topo(members, (id) => [
    ...(prereqs.get(id) ?? []),
    ...(practiceAfter.get(id) ?? []),
  ]);
  return { order, prereqs, practiceAfter };
}
