import { z } from 'zod';
import { isLocalDate, isTime, parseTime } from './dates';
import { isTimeZone } from './zone';

/**
 * Shared data shapes (spec section 4). The API validates with these schemas and the web app
 * uses the inferred types, so both sides always agree on the data. Field names follow the
 * spec, plus the fields the guided intake fills (`data/catalog/questions.json` `maps_to`).
 */

export const LocalDateSchema = z
  .string()
  .refine(isLocalDate, { message: 'Expected a valid date in YYYY-MM-DD format' });

export const TimeSchema = z.string().refine(isTime, { message: 'Expected a time in HH:MM format' });

export const TaskTypeSchema = z.enum(['course', 'cert_exam', 'practice', 'admin', 'cv_update']);
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'skipped']);
/** Where a task came from (spec 12.3: `source` and `external_ref` for future integrations). */
export const TaskSourceSchema = z.enum(['manual', 'import', 'builder', 'auto']);

export const LessonSchema = z.object({
  title: z.string().min(1),
  url: z.url().optional(),
  estMinutes: z.number().int().positive().optional(),
  summary: z.string().optional(),
  /** True until the link has been confirmed on the provider's own site. */
  needsCheck: z.boolean().default(false),
});

export const PinnedStartSchema = z.object({ date: LocalDateSchema, start: TimeSchema });

/** A taxonomy skill id: lowercase letters, digits and hyphens (same pattern as catalog ids). */
export const SkillIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: 'Expected a skill id' });

/** Most skills one task can build (catalog items list at most 4). */
export const MAX_TASK_SKILL_IDS = 10;

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    type: TaskTypeSchema,
    provider: z.string().optional(),
    url: z.url().optional(),
    estHours: z.number().positive().max(500),
    doneHours: z.number().min(0).default(0),
    status: TaskStatusSchema.default('pending'),
    order: z.number().int().min(0),
    dependsOn: z.array(z.string().min(1)).default([]),
    isAnchor: z.boolean().default(false),
    anchorDate: LocalDateSchema.optional(),
    anchorStartTime: TimeSchema.optional(),
    pinnedStart: PinnedStartSchema.optional(),
    /** The task may not be scheduled before this date (e.g. "sign up, not before Nov 1"). */
    notBefore: LocalDateSchema.optional(),
    splittable: z.boolean().default(true),
    isCertificate: z.boolean().default(false),
    certificateName: z.string().optional(),
    lessons: z.array(LessonSchema).default([]),
    howToSteps: z.array(z.string()).default([]),
    promptTemplate: z.string().optional(),
    practiceKind: z.string().optional(),
    notes: z.string().optional(),
    source: TaskSourceSchema.default('manual'),
    externalRef: z.string().optional(),
    /**
     * Optional taxonomy skills this task builds (ADR 018). Absent: the skills are read from the
     * catalog item named by `externalRef`. An empty list means "builds no skill" (e.g. booking).
     * Unknown ids are not rejected here (like the plan-level `skillIds`); progress ignores ids
     * that are not in the goal.
     */
    skillIds: z.array(SkillIdSchema).max(MAX_TASK_SKILL_IDS).optional(),
  })
  .superRefine((task, ctx) => {
    if (task.isAnchor && (!task.anchorDate || !task.anchorStartTime)) {
      ctx.addIssue({
        code: 'custom',
        message: 'An anchor task needs anchorDate and anchorStartTime',
        path: ['anchorDate'],
      });
    }
    if (task.isAnchor && task.anchorStartTime) {
      const end = parseTime(task.anchorStartTime) + Math.round(task.estHours * 60);
      if (end > 1439) {
        ctx.addIssue({
          code: 'custom',
          message: 'An anchor task must end by 23:59',
          path: ['anchorStartTime'],
        });
      }
    }
    if (task.dependsOn.includes(task.id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'A task cannot depend on itself',
        path: ['dependsOn'],
      });
    }
  });

const WeekdaySchema = z.number().int().min(0).max(6);

export const WeekPatternSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday. */
    studyWeekdays: z.array(WeekdaySchema).min(1),
    defaultHours: z.number().min(0).max(24),
    /** Optional per-weekday override, keyed "0"–"6" (e.g. { "4": 5 } = Thursday 5 h). */
    hoursByWeekday: z.record(z.string().regex(/^[0-6]$/), z.number().min(0).max(24)).default({}),
    windowStart: TimeSchema,
    windowEnd: TimeSchema,
    lunchStart: TimeSchema.optional(),
    lunchEnd: TimeSchema.optional(),
    breakEveryHours: z.number().positive().max(12).default(2),
    breakMinutes: z.number().int().min(0).max(120).default(10),
    minBlockMinutes: z.number().int().min(5).max(240).default(30),
    /** An IANA time zone the platform knows, e.g. `Asia/Jerusalem`. */
    timezone: z.string().min(1).refine(isTimeZone, { message: 'Unknown time zone' }),
  })
  .superRefine((p, ctx) => {
    if (parseTime(p.windowEnd) <= parseTime(p.windowStart)) {
      ctx.addIssue({
        code: 'custom',
        message: 'windowEnd must be after windowStart',
        path: ['windowEnd'],
      });
    }
    if ((p.lunchStart === undefined) !== (p.lunchEnd === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Set both lunchStart and lunchEnd, or neither',
        path: ['lunchStart'],
      });
    } else if (p.lunchStart && p.lunchEnd && parseTime(p.lunchEnd) <= parseTime(p.lunchStart)) {
      ctx.addIssue({
        code: 'custom',
        message: 'lunchEnd must be after lunchStart',
        path: ['lunchEnd'],
      });
    }
    if (new Set(p.studyWeekdays).size !== p.studyWeekdays.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'studyWeekdays has duplicates',
        path: ['studyWeekdays'],
      });
    }
  });

/** Overrides the weekly pattern for one date ("only 4 hours tomorrow", "add this Friday"). */
export const DayOverrideSchema = z.object({
  date: LocalDateSchema,
  isStudyDay: z.boolean(),
  capacityHours: z.number().min(0).max(24).optional(),
});

/** A time range that blocks study (an accepted, busy calendar event). */
export const BusyIntervalSchema = z
  .object({
    date: LocalDateSchema,
    start: TimeSchema,
    end: TimeSchema,
    title: z.string().optional(),
  })
  .refine((b) => parseTime(b.end) > parseTime(b.start), { message: 'end must be after start' });

export const BlockKindSchema = z.enum(['study', 'anchor', 'pinned', 'locked']);

/** One scheduled block of study time. */
export const BlockSchema = z.object({
  taskId: z.string().min(1),
  date: LocalDateSchema,
  start: TimeSchema,
  end: TimeSchema,
  minutes: z.number().int().positive(),
  kind: BlockKindSchema,
});

/**
 * The plan file format: how a whole plan is imported (the seed plan, a plan built by the plan
 * builder, or a demo plan). Spec 12.3: the seed is a JSON file in this shared format.
 */
/** Most skill ids one plan file can carry (they only feed the briefing's podcast pick). */
export const MAX_PLAN_SKILL_IDS = 50;

export const PlanFileSchema = z.object({
  formatVersion: z.literal(1),
  name: z.string().min(1),
  startDate: LocalDateSchema,
  endDate: LocalDateSchema.optional(),
  weekPattern: WeekPatternSchema,
  overrides: z.array(DayOverrideSchema).default([]),
  tasks: z.array(TaskSchema).min(1),
  /**
   * Optional taxonomy skill ids (`data/catalog/skills.json`) the plan is about. The API checks
   * them against the taxonomy and stores them in `plans.summary.skillIds`.
   */
  skillIds: z.array(z.string().min(1).max(64)).max(MAX_PLAN_SKILL_IDS).optional(),
});

/** Outcome of one task at the end of a day (spec 3.4): done, partial (with hours) or not done. */
export const TaskOutcomeKindSchema = z.enum(['done', 'partial', 'not_done']);

export const TaskOutcomeSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    outcome: TaskOutcomeKindSchema,
    /** Hours spent today. Required for `partial`. */
    hours: z.number().positive().max(24).optional(),
    /** Optional short reason, mostly for `not_done`. */
    reason: z.string().max(500).optional(),
  })
  .superRefine((o, ctx) => {
    if (o.outcome === 'partial' && o.hours === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A partial outcome needs the hours spent',
        path: ['hours'],
      });
    }
    if (o.outcome === 'not_done' && o.hours !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A not_done outcome has no hours',
        path: ['hours'],
      });
    }
  });

const ScaleSchema = z.number().int().min(1).max(5);

/**
 * The end-of-day review as the client sends it (spec 3.4). The API takes the user and plan from
 * the session and the URL, never from this body.
 * Density: 1 = too light, 3 = just right, 5 = too much.
 */
export const DayReviewInputSchema = z
  .object({
    date: LocalDateSchema,
    difficulty: ScaleSchema,
    density: ScaleSchema,
    energy: ScaleSchema,
    note: z.string().max(2000).default(''),
    outcomes: z.array(TaskOutcomeSchema).max(200).default([]),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.outcomes.forEach((o, i) => {
      if (seen.has(o.taskId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each task appears once per review',
          path: ['outcomes', i, 'taskId'],
        });
      }
      seen.add(o.taskId);
    });
  });

/** The four transparent adjustment rules (spec 3.4). */
export const AdjustmentRuleSchema = z.enum([
  'density_too_high',
  'density_too_low',
  'estimate_drift',
  'difficulty_practice',
]);

const WeekdayListSchema = z.array(WeekdaySchema).min(1).max(7);

/** What a suggestion would change. Applied by `applySuggestion` (no scheduling happens there). */
export const ProposedChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('capacityDelta'),
    scope: z.discriminatedUnion('type', [
      z.object({ type: z.literal('weekdays'), weekdays: WeekdayListSchema }),
      z.object({ type: z.literal('dateRange'), from: LocalDateSchema, to: LocalDateSchema }),
    ]),
    /** Hours added to (positive) or taken from (negative) each affected day. */
    hours: z.number().min(-24).max(24),
  }),
  z.object({
    kind: z.literal('estimateUpdate'),
    taskType: TaskTypeSchema,
    /** Multiplier for the estimates of `taskIds`, e.g. 1.3 = 30% longer. */
    factor: z.number().positive().max(10),
    taskIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('extraPractice'),
    /** The new practice task goes right after this task. */
    afterTaskId: z.string().min(1),
    hours: z.number().positive().max(24),
  }),
  z.object({
    kind: z.literal('pullForward'),
    /** The study day that gets the extra hours, so later tasks move up. */
    date: LocalDateSchema,
    hours: z.number().positive().max(24),
  }),
]);

export const SuggestionEvidenceSchema = z.object({
  reviewDates: z.array(LocalDateSchema),
  taskIds: z.array(z.string().min(1)),
});

export const SuggestionSchema = z.object({
  /** Deterministic hash of `rule` and `key`. */
  id: z.string().min(1),
  rule: AdjustmentRuleSchema,
  /** Identifies the evidence; a new key means new evidence. */
  key: z.string().min(1),
  title: z.string().min(1),
  explanation: z.string().min(1),
  /** The recommended change. */
  proposedChange: ProposedChangeSchema,
  /** Other ways to act on the same suggestion (the user picks one). */
  alternatives: z.array(ProposedChangeSchema),
  evidence: SuggestionEvidenceSchema,
});

export const SuggestionDecisionSchema = z.enum(['accepted', 'rejected']);

/** A suggestion the user already decided on (the `Adjustment` record, spec 4). */
export const DecidedSuggestionSchema = z.object({
  rule: AdjustmentRuleSchema,
  key: z.string().min(1),
  decision: SuggestionDecisionSchema,
  evidence: SuggestionEvidenceSchema.optional(),
});

export type TaskType = z.infer<typeof TaskTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;
export type WeekPattern = z.infer<typeof WeekPatternSchema>;
export type WeekPatternInput = z.input<typeof WeekPatternSchema>;
export type DayOverride = z.infer<typeof DayOverrideSchema>;
export type BusyInterval = z.infer<typeof BusyIntervalSchema>;
export type BlockKind = z.infer<typeof BlockKindSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type PlanFileInput = z.input<typeof PlanFileSchema>;

/** Validates a plan file and checks that every dependency points at a task in the plan. */
export function parsePlanFile(input: unknown): PlanFile {
  const plan = PlanFileSchema.parse(input);
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id} depends on unknown task ${dep}`);
    }
  }
  return plan;
}

export type TaskOutcomeKind = z.infer<typeof TaskOutcomeKindSchema>;
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;
export type DayReviewInput = z.input<typeof DayReviewInputSchema>;
export type DayReview = z.infer<typeof DayReviewInputSchema>;
export type AdjustmentRule = z.infer<typeof AdjustmentRuleSchema>;
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;
export type SuggestionEvidence = z.infer<typeof SuggestionEvidenceSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionDecision = z.infer<typeof SuggestionDecisionSchema>;
export type DecidedSuggestion = z.infer<typeof DecidedSuggestionSchema>;
