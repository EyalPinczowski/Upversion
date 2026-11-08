import type { Database, UserContext, UserRow } from '../../db/database';
import { unconfiguredAuthAdmin, type AuthAdmin } from './auth-admin';
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENTS, type LegalDocument } from './legal';

export interface MeView {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  createdAt: string;
  lastSeenAt: string | null;
  legal: {
    terms: { currentVersion: string; accepted: boolean };
    privacy: { currentVersion: string; accepted: boolean };
    allAccepted: boolean;
  };
}

async function legalStatus(ctx: UserContext, userId: string) {
  const { rows } = await ctx.client.query<{ document: LegalDocument; version: string }>(
    `select document, version from ${ctx.schema}.legal_acceptances where user_id = $1`,
    [userId],
  );
  const accepted = (doc: LegalDocument) =>
    rows.some((r) => r.document === doc && r.version === CURRENT_LEGAL_VERSIONS[doc]);
  const status = (doc: LegalDocument) => ({
    currentVersion: CURRENT_LEGAL_VERSIONS[doc],
    accepted: accepted(doc),
  });
  return {
    terms: status('terms'),
    privacy: status('privacy'),
    allAccepted: LEGAL_DOCUMENTS.every(accepted),
  };
}

async function toMe(ctx: UserContext, user: UserRow): Promise<MeView> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at.toISOString(),
    lastSeenAt: user.last_seen_at?.toISOString() ?? null,
    legal: await legalStatus(ctx, user.id),
  };
}

/**
 * Every table with a `user_id` column, as an export section (key in the JSON, table, order).
 * app_users is exported as `user`. A test (accounts.test.ts) compares this list with the tables
 * of the database, so a new user-owned table cannot be left out of the export.
 */
export const EXPORT_SECTIONS = {
  legalAcceptances: { table: 'legal_acceptances', order: 'accepted_at, document' },
  plans: { table: 'plans', order: 'created_at, id' },
  weekPatterns: { table: 'week_patterns', order: 'plan_id' },
  dayOverrides: { table: 'day_overrides', order: 'plan_id, date' },
  tasks: { table: 'tasks', order: 'plan_id, sort_order' },
  logs: { table: 'logs', order: 'date, created_at, id' },
  events: { table: 'events', order: 'created_at, id' },
  daySessions: { table: 'day_sessions', order: 'date, plan_id' },
  scheduleDays: { table: 'schedule_days', order: 'date, plan_id' },
  dayReviews: { table: 'day_reviews', order: 'date, plan_id' },
  adjustments: { table: 'adjustments', order: 'decided_at, suggestion_id' },
  practiceContexts: { table: 'practice_contexts', order: 'plan_id' },
  practiceSessions: { table: 'practice_sessions', order: 'started_at, id' },
  practiceMessages: { table: 'practice_messages', order: 'session_id, seq' },
  practiceFeedback: { table: 'practice_feedback', order: 'created_at, session_id' },
  aiUsageDaily: { table: 'ai_usage_daily', order: 'day, purpose' },
  aiCache: { table: 'ai_cache', order: 'created_at, key' },
  // Person-level setup answers, skills and roles (ADR 015); the user's own data, exported whole.
  userProfiles: { table: 'user_profiles', order: 'created_at' },
  // The refresh token is never exported, not even as ciphertext: the column list leaves it out.
  calendarConnections: {
    table: 'calendar_connections',
    order: 'created_at',
    columns:
      'user_id, provider, app_calendar_id, status, granted_scopes, last_synced_at, last_error_code, created_at, updated_at',
  },
  calendarEventLinks: { table: 'calendar_event_links', order: 'plan_id, block_key' },
  calendarLockedBlocks: { table: 'calendar_locked_blocks', order: 'plan_id, block_key' },
  calendarBusy: { table: 'calendar_busy', order: 'date, external_event_id' },
  // The sync token is bookkeeping, not the user's data.
  calendarSources: {
    table: 'calendar_sources',
    order: 'calendar_id',
    columns: 'user_id, calendar_id, name, blocks_time',
  },
} as const;

/**
 * User-owned tables that are deliberately not exported: short-lived login state that holds only
 * hashes and ciphertext of secrets (the OAuth state and the PKCE verifier).
 */
export const EXPORT_EXCLUDED_TABLES = ['calendar_oauth_states'] as const;
export type ExportSectionKey = keyof typeof EXPORT_SECTIONS;

/** Account operations. Every query runs inside db.withUser, so row-level security applies. */
export function createAccountService(
  db: Database,
  authAdmin: AuthAdmin = unconfiguredAuthAdmin,
  hooks: { beforeDelete?: (userId: string) => Promise<void> } = {},
) {
  return {
    /** First call creates the profile (allowlist and cap are enforced in the database). */
    provision: (userId: string, email: string | null) => db.provision(userId, email ?? ''),

    /** True when the user accepted the current version of every legal document (spec 9). */
    hasAcceptedCurrentLegal: (userId: string) =>
      db.withUser(userId, async (ctx) => (await legalStatus(ctx, userId)).allAccepted),

    getMe: (userId: string) =>
      db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<UserRow>(
          `update ${ctx.schema}.app_users set last_seen_at = now() where id = $1 returning *`,
          [userId],
        );
        return toMe(ctx, rows[0]!);
      }),

    updateDisplayName: (userId: string, displayName: string | null) =>
      db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<UserRow>(
          `update ${ctx.schema}.app_users set display_name = $2 where id = $1 returning *`,
          [userId, displayName],
        );
        return toMe(ctx, rows[0]!);
      }),

    /** Idempotent: accepting the same version twice keeps the first acceptance time. */
    acceptLegal: (userId: string, document: LegalDocument, version: string) =>
      db.withUser(userId, async (ctx) => {
        await ctx.client.query(
          `insert into ${ctx.schema}.legal_acceptances (user_id, document, version)
           values ($1, $2, $3) on conflict do nothing`,
          [userId, document, version],
        );
        const { rows } = await ctx.client.query<UserRow>(
          `select * from ${ctx.schema}.app_users where id = $1`,
          [userId],
        );
        return toMe(ctx, rows[0]!);
      }),

    /** Everything the account holds. Table names are fixed here; none comes from a request. */
    exportData: (userId: string) =>
      db.withUser(userId, async (ctx) => {
        const select = async (table: string, column: string, order: string, columns = '*') => {
          const { rows } = await ctx.client.query(
            `select ${columns} from ${ctx.schema}.${table} where ${column} = $1 order by ${order}`,
            [userId],
          );
          return rows as Record<string, unknown>[];
        };
        const user = (await select('app_users', 'id', 'id'))[0]!;
        const sections: Record<string, Record<string, unknown>[]> = {};
        for (const [key, section] of Object.entries(EXPORT_SECTIONS)) {
          const columns = 'columns' in section ? section.columns : undefined;
          sections[key] = await select(section.table, 'user_id', section.order, columns);
        }
        return {
          exportedAt: new Date().toISOString(),
          formatVersion: 1 as const,
          user,
          ...(sections as Record<ExportSectionKey, Record<string, unknown>[]>),
        };
      }),

    /**
     * Deletes the Upversion rows, then the Supabase Auth user, in ONE transaction: if the Auth
     * deletion fails the rows come back (rollback) and the whole request can simply be retried.
     * The reverse needs no special case: if the Auth user is deleted but the commit then fails,
     * the retry finds no Auth user (404 counts as success) and deletes the rows.
     * Why not commit first: delete_account() also removes the email from the allowlist, so the
     * guard answers 403 to a retry and the Auth user could never be removed afterwards.
     * Only the verified user's own id is ever sent to Supabase.
     * Before that, `hooks.beforeDelete` runs (calendar cleanup); it never blocks the deletion.
     */
    deleteAccount: async (userId: string) => {
      // Outside the transaction on purpose: it talks to Google, and its own database changes
      // (the calendar rows) must not depend on the Auth deletion below. A retry runs it again.
      await hooks.beforeDelete?.(userId);
      return db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<{ ok: boolean }>(
          `select ${ctx.schema}.delete_account() as ok`,
        );
        await authAdmin.deleteUser(userId);
        return rows[0]!.ok;
      });
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
