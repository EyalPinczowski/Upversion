import type {
  ProfileAnswers,
  ProfileSkill,
  RoleHeld,
  SetupStatus,
  UserProfile,
} from '@upversion/shared';
import type { UserContext } from '../../db/database';

interface ProfileRow {
  answers: ProfileAnswers;
  skills: ProfileSkill[];
  roles_held: RoleHeld[];
  years_experience: string | null;
  cv_imported_at: Date | null;
  setup_status: SetupStatus;
  setup_step: string | null;
  setup_completed_at: Date | null;
}

const COLUMNS =
  'answers, skills, roles_held, years_experience, cv_imported_at, setup_status, setup_step, setup_completed_at';

export const EMPTY_PROFILE: UserProfile = {
  answers: {},
  skills: [],
  rolesHeld: [],
  yearsExperience: null,
  cvImportedAt: null,
  setupStatus: 'not_started',
  setupStep: null,
  setupCompletedAt: null,
};

export function toView(row: ProfileRow): UserProfile {
  return {
    answers: row.answers,
    skills: row.skills,
    rolesHeld: row.roles_held,
    // numeric comes back as text
    yearsExperience: row.years_experience === null ? null : Number(row.years_experience),
    cvImportedAt: row.cv_imported_at?.toISOString() ?? null,
    setupStatus: row.setup_status,
    setupStep: row.setup_step,
    setupCompletedAt: row.setup_completed_at?.toISOString() ?? null,
  };
}

/**
 * Queries on the signed-in user's own row. The user id is always the verified token's, passed by
 * the service; RLS (policies on user_id = current_user_id()) is the second wall. No query here
 * puts an answer, skill or title into SQL text: they travel only as parameters.
 */
export function createProfileRepository(ctx: UserContext) {
  const t = `${ctx.schema}.user_profiles`;
  return {
    async get(userId: string): Promise<UserProfile> {
      const { rows } = await ctx.client.query<ProfileRow>(
        `select ${COLUMNS} from ${t} where user_id = $1`,
        [userId],
      );
      return rows[0] ? toView(rows[0]) : EMPTY_PROFILE;
    },

    /** Partial merge of already validated answers (atomic: a single upsert). */
    async mergeAnswers(userId: string, answers: ProfileAnswers, now: Date): Promise<UserProfile> {
      const { rows } = await ctx.client.query<ProfileRow>(
        `insert into ${t} (user_id, answers, updated_at) values ($1, $2::jsonb, $3)
         on conflict (user_id) do update
           set answers = ${t}.answers || excluded.answers, updated_at = excluded.updated_at
         returning ${COLUMNS}`,
        [userId, JSON.stringify(answers), now],
      );
      return toView(rows[0]!);
    },

    /** The row, locked for the rest of the transaction; created empty when missing. */
    async lock(userId: string, now: Date): Promise<UserProfile> {
      await ctx.client.query(
        `insert into ${t} (user_id, updated_at) values ($1, $2) on conflict (user_id) do nothing`,
        [userId, now],
      );
      const { rows } = await ctx.client.query<ProfileRow>(
        `select ${COLUMNS} from ${t} where user_id = $1 for update`,
        [userId],
      );
      return toView(rows[0]!);
    },

    async saveImport(
      userId: string,
      next: Pick<UserProfile, 'answers' | 'skills' | 'rolesHeld' | 'yearsExperience'>,
      now: Date,
    ): Promise<UserProfile> {
      const { rows } = await ctx.client.query<ProfileRow>(
        `update ${t}
            set answers = $2::jsonb, skills = $3::jsonb, roles_held = $4::jsonb,
                years_experience = $5, cv_imported_at = $6, updated_at = $6
          where user_id = $1
        returning ${COLUMNS}`,
        [
          userId,
          JSON.stringify(next.answers),
          JSON.stringify(next.skills),
          JSON.stringify(next.rolesHeld),
          next.yearsExperience,
          now,
        ],
      );
      return toView(rows[0]!);
    },

    async setSetup(
      userId: string,
      status: SetupStatus,
      step: string | undefined,
      now: Date,
    ): Promise<UserProfile> {
      const { rows } = await ctx.client.query<ProfileRow>(
        `insert into ${t} (user_id, setup_status, setup_step, setup_completed_at, updated_at)
         values ($1, $2::text, $3, case when $2::text = 'completed' then $4::timestamptz end, $4)
         on conflict (user_id) do update
           set setup_status = excluded.setup_status,
               setup_step = coalesce($3, ${t}.setup_step),
               setup_completed_at = case when excluded.setup_status = 'completed'
                 then coalesce(${t}.setup_completed_at, excluded.updated_at)
                 else ${t}.setup_completed_at end,
               updated_at = excluded.updated_at
         returning ${COLUMNS}`,
        [userId, status, step ?? null, now],
      );
      return toView(rows[0]!);
    },

    /** "Clear my profile": everything personal goes, the row stays as `dismissed`. */
    async clear(userId: string, now: Date): Promise<UserProfile> {
      const { rows } = await ctx.client.query<ProfileRow>(
        `insert into ${t} (user_id, setup_status, updated_at) values ($1, 'dismissed', $2)
         on conflict (user_id) do update
           set answers = '{}'::jsonb, skills = '[]'::jsonb, roles_held = '[]'::jsonb,
               years_experience = null, cv_imported_at = null, setup_status = 'dismissed',
               setup_step = null, setup_completed_at = null, updated_at = excluded.updated_at
         returning ${COLUMNS}`,
        [userId, now],
      );
      return toView(rows[0]!);
    },
  };
}
