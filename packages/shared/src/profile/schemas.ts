import { z } from 'zod';

/** Spec 12.3 / ADR 015: the person-level profile filled by setup and the CV import. */

export const SETUP_STATUSES = ['not_started', 'in_progress', 'completed', 'dismissed'] as const;
export const SetupStatusSchema = z.enum(SETUP_STATUSES);
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export const SKILL_SOURCES = ['cv', 'setup', 'manual'] as const;
export const SkillSourceSchema = z.enum(SKILL_SOURCES);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** Education levels, the values of the `education` question. */
export const EDUCATION_LEVELS = ['high_school', 'some_college', 'bachelor', 'master'] as const;
export const EducationLevelSchema = z.enum(EDUCATION_LEVELS);
export type EducationLevel = z.infer<typeof EducationLevelSchema>;

export const MAX_PROFILE_SKILLS = 60;
export const MAX_ROLES_HELD = 15;
export const MAX_ROLE_TITLE_LENGTH = 80;
export const MAX_YEARS = 50;

const SkillIdSchema = z.string().min(1).max(80);
const RoleIdSchema = z.string().min(1).max(80);
/** Skill level on the `skill_levels` scale: 0 none, 1 basic, 2 comfortable, 3 strong. */
const LevelSchema = z.number().int().min(0).max(3);
const YearsSchema = z.number().min(0).max(MAX_YEARS);

export const ProfileSkillSchema = z.strictObject({
  skillId: SkillIdSchema,
  level: LevelSchema,
  source: SkillSourceSchema,
});
export type ProfileSkill = z.infer<typeof ProfileSkillSchema>;

export const RoleHeldSchema = z.strictObject({
  roleId: RoleIdSchema.nullable(),
  title: z.string().trim().min(1).max(MAX_ROLE_TITLE_LENGTH),
  years: YearsSchema.nullable(),
});
export type RoleHeld = z.infer<typeof RoleHeldSchema>;

/** Setup answers keyed by `questions.json` id (validated per question with `validateAnswer`). */
export const ProfileAnswersSchema = z.record(z.string().min(1).max(60), z.unknown());
export type ProfileAnswers = z.infer<typeof ProfileAnswersSchema>;

export const UserProfileSchema = z.strictObject({
  answers: ProfileAnswersSchema,
  skills: z.array(ProfileSkillSchema).max(MAX_PROFILE_SKILLS),
  rolesHeld: z.array(RoleHeldSchema).max(MAX_ROLES_HELD),
  yearsExperience: YearsSchema.nullable(),
  cvImportedAt: z.string().nullable(),
  setupStatus: SetupStatusSchema,
  setupStep: z.string().max(40).nullable(),
  setupCompletedAt: z.string().nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** Body of a setup status change (`PATCH /me/profile/setup`). */
export const SetupStatusUpdateSchema = z.strictObject({
  status: SetupStatusSchema,
  step: z.string().max(40).optional(),
});
export type SetupStatusUpdate = z.infer<typeof SetupStatusUpdateSchema>;

/** What the CV review screen may send: an allowlist, no evidence, no raw text, no file name. */
export const ProfileImportSchema = z.strictObject({
  skills: z
    .array(z.strictObject({ skillId: SkillIdSchema, level: LevelSchema }))
    .max(MAX_PROFILE_SKILLS),
  rolesHeld: z.array(RoleHeldSchema).max(MAX_ROLES_HELD),
  yearsExperience: YearsSchema.nullable(),
  education: EducationLevelSchema.nullable(),
  tools: z.array(z.string().min(1).max(40)).max(30),
});
export type ProfileImport = z.infer<typeof ProfileImportSchema>;
