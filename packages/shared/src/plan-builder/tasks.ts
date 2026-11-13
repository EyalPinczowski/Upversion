import type { Task } from '../schemas';
import type { CatalogItem } from './catalog';
import { linkNeedsCheck, showsLink, type BuildContext } from './context';
import type { Ordering } from './order';
import { isShortExam } from './order';
import type { Member, Resolved } from './resolve';
import { MAX_EXAM_BLOCK_HOURS } from './validate';
import { whyLine } from './why';

export const SETUP_HOURS = 0.5;
export const REVIEW_HOURS = 0.5;
export const BOOKING_HOURS = 0.25;

export const NEEDS_CHECK_LINK =
  "Needs check: link not yet verified; confirm it on the provider's site before relying on it.";
export const NEEDS_CHECK_PRICE = 'Needs check: price not verified.';
export const NEEDS_CHECK_EXAM_LENGTH = "Needs check: exam length – see the provider's page.";
export const PRICE_VARIES = "Price varies – check the price on the provider's page.";

export interface Composed {
  tasks: Task[];
  /** Task ids per member (the booking task is part of its exam's list). */
  itemTasks: Map<string, string[]>;
  /** Catalog id per task (admin tasks are not in it). */
  taskItem: Map<string, string>;
  why: Map<string, string>;
}

function makeTask(
  fields: Pick<Task, 'id' | 'title' | 'type' | 'estHours' | 'order'> & Partial<Task>,
): Task {
  return {
    doneHours: 0,
    status: 'pending',
    dependsOn: [],
    isAnchor: false,
    splittable: true,
    isCertificate: false,
    lessons: [],
    howToSteps: [],
    source: 'builder',
    ...fields,
  };
}

function money(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The price sentence of a task note. A price that is not verified is never shown as a fact. */
export function priceNote(item: CatalogItem, paidCertificate: boolean): string[] {
  const out: string[] = [];
  if (item.type !== 'practice') {
    if (item.cost_type === 'free' || item.cost_type === 'free_audit') {
      out.push(
        item.price_verified
          ? 'Price per catalog: free (prices change; re-check before relying on it).'
          : NEEDS_CHECK_PRICE,
      );
    } else if (item.price === null) {
      out.push(PRICE_VARIES);
    } else if (!item.price_verified) {
      out.push(NEEDS_CHECK_PRICE);
    } else {
      const per =
        item.cost_type === 'subscription' && item.subscription_period
          ? ` per ${item.subscription_period}`
          : '';
      out.push(
        `Price per catalog: ${money(item.price)} USD${per} (prices change; re-check before paying).`,
      );
    }
  }
  if (paidCertificate) {
    out.push(
      item.certificate_price === null
        ? 'Certificate fee varies – check the price on the provider’s page.'
        : `Needs check: certificate fee (${money(item.certificate_price)} USD per catalog, not verified).`,
    );
  }
  return out;
}

/** True when the member's price note carries a "needs check" (unverified price or unknown fee). */
export function priceNeedsCheck(item: CatalogItem, paidCertificate: boolean): boolean {
  if (paidCertificate) return true;
  if (item.type === 'practice') return false;
  return !item.price_verified;
}

export function priceVaries(item: CatalogItem, paidCertificate: boolean): boolean {
  if (paidCertificate && item.certificate_price === null) return true;
  if (item.type === 'practice') return false;
  return item.price === null && item.cost_type !== 'free' && item.cost_type !== 'free_audit';
}

function practiceKind(item: CatalogItem): string {
  const t = item.title.toLowerCase();
  if (/mock|role-play|call|phone screen|demo/.test(t)) return 'mock_interview';
  if (/timed/.test(t)) return 'timed_test';
  if (/assignment/.test(t)) return 'home_assignment';
  if (/star story|case interview/.test(t)) return 'interview_prep';
  if (/practice assessment/.test(t)) return 'exam_prep';
  return 'portfolio_project';
}

function certificateNameFor(member: Member): string | undefined {
  const { item } = member;
  if (member.kind === 'exam') return item.title;
  if (member.paidCertificate) return `${item.title} (paid certificate)`;
  if (item.cost_type === 'free_audit') return undefined;
  return item.certificate_type !== 'none' ? `${item.title} certificate` : undefined;
}

/** Whether the member's tasks are certificates (an exam, a certificate course, or a bought certificate). */
export function isCertificateMember(member: Member): boolean {
  if (member.kind === 'exam') return true;
  if (member.paidCertificate) return true;
  if (member.item.cost_type === 'free_audit') return false;
  return member.item.certificate_type !== 'none' && member.kind === 'course';
}

function joinNote(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}

function weekCapacityHours(ctx: BuildContext): number {
  const p = ctx.request.weekPattern;
  return p.studyWeekdays.reduce((s, d) => s + (p.hoursByWeekday[String(d)] ?? p.defaultHours), 0);
}

/**
 * Steps 5 (exam tasks), 7 (admin), 8 (order and dependencies) and 11 (task mapping): the plan's
 * tasks for the resolved members, in order. `dependsOn` holds prerequisite, booking and practice
 * edges only, so the engine can interleave everything else.
 */
export function composeTasks(ctx: BuildContext, resolved: Resolved, ordering: Ordering): Composed {
  const itemTasks = new Map<string, string[]>();
  const taskItem = new Map<string, string>();
  const why = new Map<string, string>();
  const last = new Map<string, string>();
  const learn = new Map<string, string>();
  const body: Task[] = [];
  const hoursOfLearning = new Map<string, number>();

  for (const id of ordering.order) {
    const m = resolved.byId.get(id);
    if (!m) continue;
    const { item } = m;
    const prereqLast = (ordering.prereqs.get(id) ?? [])
      .map((p) => last.get(p))
      .filter((t): t is string => t !== undefined);
    const practiceDeps = (ordering.practiceAfter.get(id) ?? [])
      .map((l) => learn.get(l))
      .filter((t): t is string => t !== undefined);
    const deps = [...new Set([...prereqLast, ...practiceDeps])];
    const whyText = whyLine(ctx, m, resolved);
    why.set(id, whyText);
    const common: Partial<Task> = {
      provider: item.provider,
      source: 'builder',
      externalRef: `catalog:${item.id}`,
      ...(showsLink(item) && item.url ? { url: item.url } : {}),
    };
    const linkNote = linkNeedsCheck(item) ? NEEDS_CHECK_LINK : undefined;
    const prices = priceNote(item, m.paidCertificate);
    const cert = isCertificateMember(m);
    const certName = certificateNameFor(m);
    const certFields: Partial<Task> = cert
      ? { isCertificate: true, ...(certName ? { certificateName: certName } : {}) }
      : {};
    const mine: string[] = [];
    const push = (task: Task) => {
      body.push(task);
      mine.push(task.id);
      taskItem.set(task.id, id);
    };

    if (m.kind === 'exam') {
      const short = isShortExam(m);
      const examHours = short ? item.est_hours : MAX_EXAM_BLOCK_HOURS;
      const bookingId = `b-${item.id}`;
      const examId = `x-${item.id}`;
      let prepId: string | undefined;
      if (!short) {
        prepId = `p-${item.id}`;
        const subtract = (ordering.prereqs.get(id) ?? [])
          .map((p) => resolved.byId.get(p))
          .filter((p): p is Member => p !== undefined && p.kind === 'course')
          .filter((p) => item.prerequisite_kinds[p.id] !== 'recommended')
          .reduce((s, p) => s + p.item.est_hours, 0);
        const prepHours = Math.max(1, item.est_hours - MAX_EXAM_BLOCK_HOURS - subtract);
        push(
          makeTask({
            id: prepId,
            title: `Prepare for ${item.title}`,
            type: 'course',
            estHours: Math.round(prepHours * 100) / 100,
            order: 0,
            dependsOn: prereqLast,
            ...common,
            notes: joinNote([
              whyText,
              'Preparation for the exam; the exam itself is a separate task.',
              linkNote,
            ]),
          }),
        );
        learn.set(id, prepId);
      }
      push(
        makeTask({
          id: bookingId,
          title: `Book the ${item.title} exam`,
          type: 'admin',
          estHours: BOOKING_HOURS,
          order: 0,
          notes: "Pick a date and book the exam on the provider's own page.",
          source: 'builder',
          externalRef: `catalog:${item.id}`,
        }),
      );
      const date = ctx.request.examDates.find((e) => e.catalogId === item.id);
      push(
        makeTask({
          id: examId,
          title: `${item.title} – exam`,
          type: 'cert_exam',
          estHours: examHours,
          order: 0,
          dependsOn: [...(prepId ? [prepId] : []), bookingId, ...(prepId ? [] : prereqLast)],
          splittable: false,
          ...common,
          ...certFields,
          ...(date ? { isAnchor: true, anchorDate: date.date, anchorStartTime: date.start } : {}),
          notes: joinNote([
            short ? whyText : undefined,
            NEEDS_CHECK_EXAM_LENGTH,
            linkNote,
            ...prices,
          ]),
        }),
      );
      last.set(id, examId);
      hoursOfLearning.set(examId, examHours);
      if (prepId) hoursOfLearning.set(prepId, body.find((t) => t.id === prepId)?.estHours ?? 0);
    } else {
      const taskId = `c-${item.id}`;
      const splittable =
        m.kind === 'practice'
          ? !['mock_interview', 'timed_test'].includes(practiceKind(item))
          : true;
      push(
        makeTask({
          id: taskId,
          title: item.title,
          type: m.kind === 'practice' ? 'practice' : 'course',
          estHours: item.est_hours,
          order: 0,
          dependsOn: deps,
          splittable,
          ...common,
          ...certFields,
          ...(m.kind === 'practice' ? { practiceKind: practiceKind(item) } : {}),
          notes: joinNote([
            whyText,
            m.kind === 'practice'
              ? 'A practice task from the catalog; no outside link is needed.'
              : undefined,
            linkNote,
            ...prices,
          ]),
        }),
      );
      last.set(id, taskId);
      learn.set(id, taskId);
      hoursOfLearning.set(taskId, item.est_hours);
    }
    itemTasks.set(id, mine);
  }

  // Admin tasks: one setup task first, a weekly review after about every week of planned hours.
  const ordered: Task[] = [
    makeTask({
      id: 'a-setup-1',
      title: 'Set up learning accounts and study workspace',
      type: 'admin',
      estHours: SETUP_HOURS,
      order: 0,
      notes: 'Create the accounts the plan needs and prepare a folder for notes and exercises.',
    }),
  ];
  const weekHours = weekCapacityHours(ctx);
  let cumulative = 0;
  let threshold = weekHours;
  let reviews = 0;
  body.forEach((t, i) => {
    ordered.push(t);
    cumulative += hoursOfLearning.get(t.id) ?? 0;
    const hasLater = body.slice(i + 1).some((x) => hoursOfLearning.has(x.id));
    if (weekHours > 0 && cumulative >= threshold && hasLater) {
      reviews += 1;
      ordered.push(
        makeTask({
          id: `a-review-${reviews}`,
          title: `Weekly review ${reviews}`,
          type: 'admin',
          estHours: REVIEW_HOURS,
          order: 0,
          notes: "Look back at what you finished and check next week's tasks.",
        }),
      );
      threshold = (Math.floor(cumulative / weekHours) + 1) * weekHours;
    }
  });
  ordered.forEach((t, i) => {
    t.order = i;
  });
  return { tasks: ordered, itemTasks, taskItem, why };
}
