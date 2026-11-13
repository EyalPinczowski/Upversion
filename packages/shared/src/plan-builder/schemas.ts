import { z } from 'zod';
import { LocalDateSchema, PlanFileSchema, TimeSchema, WeekPatternSchema } from '../schemas';
import { MAX_PROFILE_SKILLS } from '../profile/schemas';

/**
 * Plan builder inputs and outputs (ADR 017 sections 2 and 4). The request carries ids, numbers,
 * dates and times only: no free text of any kind, so no personal data can enter the builder.
 */

/** A catalog id (item, role or skill): lowercase letters, digits and hyphens. */
const IdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: 'Expected a catalog id' });

/** Prices are in US dollars: every catalog price is USD and the app has no exchange rate (owner, Q12). */
export const BUDGET_MODES = ['free', 'limit', 'flexible'] as const;
export const CERT_PREFERENCES = ['must', 'nice', 'none'] as const;
export const INTERVIEW_PREP_CHOICES = ['yes', 'later', 'no'] as const;

export const MAX_TARGET_ROLES = 2;
/** `target_skills.max` in `questions.json`. */
export const MAX_EXTRA_SKILLS = 5;
export const MAX_CERTIFICATE_OPT_INS = 10;
export const MAX_EXAM_DATES = 10;
export const MAX_ID_LIST = 30;

export const BudgetSchema = z.strictObject({
  mode: z.enum(BUDGET_MODES),
  /** USD. Required when `mode` is `limit`; caps the total cost. */
  amount: z.number().positive().max(1_000_000).optional(),
  /** USD. A cap on the price of any single item, on top of the mode's rule. */
  maxItemPrice: z.number().positive().max(1_000_000).optional(),
});

/**
 * The same rules as `WeekPatternSchema`, but unknown keys are rejected. The times are checked
 * first: `WeekPatternSchema` reads them inside its own checks and would throw on a bad one
 * instead of reporting it, and a request must never throw while it is being validated.
 */
export const BuildWeekPatternSchema = z
  .looseObject({
    windowStart: TimeSchema,
    windowEnd: TimeSchema,
    lunchStart: TimeSchema.optional(),
    lunchEnd: TimeSchema.optional(),
  })
  // The cast restores the plain input/output types of `WeekPatternSchema`; at run time this is the
  // pipe above (times checked first, then the strict schema).
  .pipe(WeekPatternSchema.strict()) as unknown as z.ZodType<
  z.output<typeof WeekPatternSchema>,
  z.input<typeof WeekPatternSchema>
>;

export const ExamDateSchema = z.strictObject({
  catalogId: IdSchema,
  date: LocalDateSchema,
  start: TimeSchema,
});

export const BuildRequestSchema = z
  .strictObject({
    targetRoleIds: z.array(IdSchema).min(1).max(MAX_TARGET_ROLES),
    extraSkillIds: z.array(IdSchema).max(MAX_EXTRA_SKILLS).default([]),
    /** Skill id to level (0 never used, 1 basic, 2 comfortable, 3 could teach it). */
    skillLevels: z.record(IdSchema, z.number().int().min(0).max(3)).default({}),
    startDate: LocalDateSchema,
    deadline: LocalDateSchema,
    weekPattern: BuildWeekPatternSchema,
    budget: BudgetSchema,
    certPreference: z.enum(CERT_PREFERENCES),
    interviewPrep: z.enum(INTERVIEW_PREP_CHOICES),
    certificateOptIns: z.array(IdSchema).max(MAX_CERTIFICATE_OPT_INS).default([]),
    examDates: z.array(ExamDateSchema).max(MAX_EXAM_DATES).default([]),
    mustInclude: z.array(IdSchema).max(MAX_ID_LIST).default([]),
    exclude: z.array(IdSchema).max(MAX_ID_LIST).default([]),
    priorityOverrides: z.record(IdSchema, z.enum(['core', 'optional'])).default({}),
  })
  .superRefine((r, ctx) => {
    if (r.budget.mode === 'limit' && r.budget.amount === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A budget limit needs an amount',
        path: ['budget', 'amount'],
      });
    }
    if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(r.weekPattern.timezone)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Expected an IANA time zone name',
        path: ['weekPattern', 'timezone'],
      });
    }
    if (Object.keys(r.skillLevels).length > MAX_PROFILE_SKILLS) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MAX_PROFILE_SKILLS} skill levels`,
        path: ['skillLevels'],
      });
    }
    if (Object.keys(r.priorityOverrides).length > MAX_ID_LIST) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MAX_ID_LIST} priority overrides`,
        path: ['priorityOverrides'],
      });
    }
  });

/** What `buildPlan` takes: the request plus today's date in the request's time zone (computed by the caller). */
export const BuildInputSchema = z.strictObject({
  request: BuildRequestSchema,
  today: LocalDateSchema,
});

export type BuildRequest = z.infer<typeof BuildRequestSchema>;
export type BuildRequestInput = z.input<typeof BuildRequestSchema>;
export type BuildInput = z.infer<typeof BuildInputSchema>;
export type BuildInputShape = z.input<typeof BuildInputSchema>;

// ---------------------------------------------------------------------------------------------
// Output

export const BuildTierSchema = z.enum(['core', 'optional']);
export const BuildItemKindSchema = z.enum(['course', 'exam', 'practice']);
export const BuildItemOriginSchema = z.enum([
  'gap',
  'prerequisite',
  'certificate',
  'opt_in',
  'must_include',
  'practice',
  'free_alternative',
]);

export const ItemCostSchema = z.object({
  /**
   * The catalog price of one purchase (USD), or null when the catalog has none ("price varies").
   * For a subscription it is the price of ONE period (a month, or a year), not the total; every
   * member of a subscription group shows the full group price, and the group is paid once per
   * month (see `months` and `CostReport.total`). Never add the item amounts up: use the total.
   */
  amount: z.number().nullable(),
  kind: z.enum(['free', 'one_time', 'subscription', 'certificate']),
  /** Subscription items: the months the plan uses it for (a group is paid once per month). */
  months: z.number().int().positive().optional(),
});

export const BuildItemSchema = z.object({
  catalogId: z.string(),
  title: z.string(),
  provider: z.string(),
  kind: BuildItemKindSchema,
  tier: BuildTierSchema,
  origin: BuildItemOriginSchema,
  taskIds: z.array(z.string()),
  hours: z.number(),
  /** Gap skills this item teaches. */
  skillIds: z.array(z.string()),
  priority: z.number(),
  /** The "why this is here" line (a template, no AI). */
  why: z.string(),
  cost: ItemCostSchema,
  needsCheckLink: z.boolean(),
  needsCheckPrice: z.boolean(),
  priceVaries: z.boolean(),
  isCertificate: z.boolean(),
});

export const EXCLUDED_REASONS = [
  'excluded_by_user',
  'free_only',
  'price_unknown',
  'over_item_price',
  'over_budget',
  'no_link',
  'needs_prerequisite',
  'dropped_to_fit_time',
  'dropped_to_fit_budget',
  'certificate_not_allowed',
  'exam_date_not_used',
] as const;

export const ExcludedItemSchema = z.object({
  catalogId: z.string(),
  reason: z.enum(EXCLUDED_REASONS),
  message: z.string(),
  /** The item that caused it (a missing prerequisite). */
  relatedId: z.string().optional(),
});

export const SkippedPrerequisiteSchema = z.object({
  catalogId: z.string(),
  message: z.string(),
});

export const CostLineSchema = z.object({
  catalogId: z.string(),
  kind: z.enum(['one_time', 'subscription', 'certificate']),
  amount: z.number().nullable(),
  priceVerified: z.boolean(),
  /** Subscriptions: months (or years for a yearly price) paid. */
  periods: z.number().int().positive().optional(),
  subscriptionGroup: z.string().nullable().optional(),
});

export const CostReportSchema = z.object({
  currency: z.literal('USD'),
  /** Sum of the known prices. Prices that are null are not in it (see `pricesToCheck`). */
  total: z.number(),
  /** True when any included item has a price that is not verified. */
  estimated: z.boolean(),
  /** How many included items have a price that is not verified (the number behind `estimated`). */
  unverifiedPriceCount: z.number().int(),
  /**
   * Subscriptions (a group name, or a catalog id) that are not scheduled at all: they are counted
   * as one month, because there is no schedule to count months from.
   */
  assumedOneMonth: z.array(z.string()),
  /**
   * True when the plan does not fit before the deadline: the cost counts only what is scheduled up
   * to the deadline, so subscriptions (and the total) may be higher once the plan runs longer.
   */
  mayBeHigher: z.boolean(),
  /** Items whose price is unknown ("+ N prices to check"). */
  pricesToCheck: z.number().int(),
  lines: z.array(CostLineSchema),
  /** Months paid per subscription group (`null` key not used: groupless ones are in `lines`). */
  subscriptionMonths: z.record(z.string(), z.number().int()),
});

export const SkillNotCoveredSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  reason: z.enum(['catalog_gap', 'dropped_to_fit_time', 'dropped_to_fit_budget']),
});

export const OfferedCertificateSchema = z.object({
  catalogId: z.string(),
  title: z.string(),
  provider: z.string(),
  /** USD, null when it varies. */
  price: z.number().nullable(),
  priceVerified: z.boolean(),
});

export const FitOptionsSchema = z.object({
  /** "Finish on <date>": the date the draft finishes without the deadline (null: not within two years). */
  finishOn: z.object({ date: LocalDateSchema.nullable() }),
  /** "Study <h> hours a day": the smallest value on a 0.5 h grid that fits (null: not possible within the window). */
  hoursPerDay: z.object({
    value: z.number().nullable(),
    /** The value replaces the hours of every study day, per-weekday overrides included. */
    appliesToAllStudyDays: z.literal(true),
  }),
  /**
   * "Keep only the essentials": the items to drop (add them to `exclude`) and the skills that are
   * lost. Exams and items the user asked for (opt-in, exam date, mustInclude) are never in it.
   */
  essentials: z.object({
    possible: z.boolean(),
    droppedItemIds: z.array(z.string()),
    lostSkillIds: z.array(z.string()),
  }),
});

export const BuildWarningSchema = z.object({
  code: z.enum([
    'subscription_months_assumed',
    'cost_may_be_higher',
    'thin_role',
    'no_free_items',
    'catalog_gap',
    'schedule',
    'estimates',
    'unknown_exam_length',
  ]),
  message: z.string(),
  catalogId: z.string().optional(),
});

export const BuildSummarySchema = z.object({
  /** The first day the schedule can use: the later of the start date and today. */
  scheduleFrom: LocalDateSchema,
  deadline: LocalDateSchema,
  /** The last scheduled day of the draft (null when nothing is scheduled). */
  finishDate: LocalDateSchema.nullable(),
  totalHours: z.number(),
  cost: CostReportSchema,
  skillsAsked: z.number().int(),
  skillsCovered: z.array(z.string()),
  /** Skills the user already rated high enough ("already covered"). */
  skillsAlreadyCovered: z.array(z.string()),
  skillsNotCovered: z.array(SkillNotCoveredSchema),
  certificatesIncluded: z.array(z.string()),
  certificatesOffered: z.array(OfferedCertificateSchema),
});

export const BuildDraftSchema = z.object({
  /** A normal plan file: it parses with `parsePlanFile` and the engine can schedule it. */
  plan: PlanFileSchema,
  items: z.array(BuildItemSchema),
  excluded: z.array(ExcludedItemSchema),
  skippedPrerequisites: z.array(SkippedPrerequisiteSchema),
  summary: BuildSummarySchema,
  /** True when the engine finishes the plan on or before the deadline with nothing left unplaced. */
  fits: z.boolean(),
  /** Set only when `fits` is false. The builder never applies one of these by itself. */
  options: FitOptionsSchema.nullable(),
  /** True when the known cost is still above the limit after the one swap/drop pass. */
  overBudget: z.boolean(),
  /** When `overBudget`: items to remove so the known cost is within the limit. */
  removeToFit: z.array(z.string()),
  warnings: z.array(BuildWarningSchema),
  /** A change detector for preview and create (not a security hash). */
  draftHash: z.string(),
});

export type BuildTier = z.infer<typeof BuildTierSchema>;
export type BuildItemKind = z.infer<typeof BuildItemKindSchema>;
export type BuildItemOrigin = z.infer<typeof BuildItemOriginSchema>;
export type ItemCost = z.infer<typeof ItemCostSchema>;
export type BuildItem = z.infer<typeof BuildItemSchema>;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];
export type ExcludedItem = z.infer<typeof ExcludedItemSchema>;
export type SkippedPrerequisite = z.infer<typeof SkippedPrerequisiteSchema>;
export type CostLine = z.infer<typeof CostLineSchema>;
export type CostReport = z.infer<typeof CostReportSchema>;
export type SkillNotCovered = z.infer<typeof SkillNotCoveredSchema>;
export type OfferedCertificate = z.infer<typeof OfferedCertificateSchema>;
export type FitOptions = z.infer<typeof FitOptionsSchema>;
export type BuildWarning = z.infer<typeof BuildWarningSchema>;
export type BuildSummary = z.infer<typeof BuildSummarySchema>;
export type BuildDraft = z.infer<typeof BuildDraftSchema>;
