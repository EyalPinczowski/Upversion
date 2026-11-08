import type { EducationLevel } from './schemas';

/** A setup-flagged entry of `questions.json` (`setup` field, ADR 015 section 1). */
export interface SetupFlag {
  order: number;
  ignore_show_if?: boolean;
  choices_only?: boolean;
  optional?: boolean;
  /** Replaces `why` in setup only. */
  why?: string;
}

export type QuestionOption = string | { value: string; label: string };

/** A question as stored in `questions.json` (only the fields the profile code reads). */
export interface CatalogQuestion {
  id: string;
  stage: string;
  text: string;
  why?: string;
  type: string;
  options?: QuestionOption[];
  options_source?: string;
  allow_other?: boolean;
  show_if?: Record<string, unknown>;
  hint_if?: Record<string, unknown>;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  maps_to: string;
  required: boolean;
  privacy?: unknown;
  setup?: SetupFlag;
}

/** A question as the setup wizard renders it: no `show_if`, no `allow_other`. */
export type SetupQuestion = Omit<CatalogQuestion, 'show_if' | 'allow_other'>;

export type AnswerResult = { ok: true; value: unknown } | { ok: false; error: string };

/** The taxonomy the matcher reads (shape of `skills.json` / `roles.json`). */
export interface MatchTaxonomy {
  skills: readonly { id: string; name: string; keywords: readonly string[] }[];
  roles: readonly {
    id: string;
    title: string;
    aliases: readonly string[];
    /** Catalog skills of the role (`roles.json`); optional for matcher-only taxonomies. */
    skills?: readonly { skill: string; weight: number }[];
  }[];
}

export interface CvMatchOptions {
  taxonomy?: MatchTaxonomy;
  /** Labels of the `tools_known` options; default: read from `questions.json`. */
  tools?: readonly string[];
  /** Used for "Present" in date ranges. Default: the current time. */
  now?: Date;
}

export interface SkillSuggestion {
  skillId: string;
  /** Only ever 1 (Basic) or 2 (Comfortable). */
  level: 1 | 2;
  strength: 'strong' | 'weak';
  /** Default state of the review checkbox. */
  checked: boolean;
  /** Redacted snippet, at most 80 characters; empty when no safe line exists. */
  evidence: string;
}

export interface RoleSuggestion {
  roleId: string | null;
  title: string;
  years: number | null;
  checked: boolean;
  evidence: string;
}

export interface EducationSuggestion {
  value: EducationLevel;
  evidence: string;
}

export interface ToolSuggestion {
  tool: string;
  evidence: string;
}

export interface CvExtraction {
  skills: SkillSuggestion[];
  rolesHeld: RoleSuggestion[];
  yearsExperience: number | null;
  education: EducationSuggestion | null;
  tools: ToolSuggestion[];
}
