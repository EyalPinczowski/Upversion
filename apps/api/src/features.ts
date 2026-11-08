import { z } from 'zod';

/** Feature flags (spec 12.3). Everything ships off; an env var can only turn a flag on. */
export const featureNames = [
  'notifications',
  'sharing',
  'offline',
  'pushNotifications',
  'aiOverview',
  'profileSetup',
  'cvTailor',
] as const;

export type FeatureName = (typeof featureNames)[number];
export type Features = Record<FeatureName, boolean>;

/** The one rule for boolean env vars: the literal strings "true" or "false", nothing else. */
export const booleanString = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'must be exactly "true" or "false"' })
    .default(fallback)
    .transform((v) => v === 'true');

export const featureEnvShape = {
  FEATURE_NOTIFICATIONS: booleanString('false'),
  FEATURE_SHARING: booleanString('false'),
  FEATURE_OFFLINE: booleanString('false'),
  FEATURE_PUSH_NOTIFICATIONS: booleanString('false'),
  /** Model-written day overview (v0.3). In v0.2 the overview is always the template. */
  FEATURE_AI_OVERVIEW: booleanString('false'),
  /** First-time setup and the user profile (ADR 015). Off: the profile routes do not exist (404). */
  FEATURE_PROFILE_SETUP: booleanString('false'),
  /** Tailor my CV to a job with the free-tier AI gateway (ADR 016). Off: the route does not exist (404). */
  FEATURE_CV_TAILOR: booleanString('false'),
};

export function toFeatures(e: z.infer<z.ZodObject<typeof featureEnvShape>>): Features {
  return {
    notifications: e.FEATURE_NOTIFICATIONS,
    sharing: e.FEATURE_SHARING,
    offline: e.FEATURE_OFFLINE,
    pushNotifications: e.FEATURE_PUSH_NOTIFICATIONS,
    aiOverview: e.FEATURE_AI_OVERVIEW,
    profileSetup: e.FEATURE_PROFILE_SETUP,
    cvTailor: e.FEATURE_CV_TAILOR,
  };
}
