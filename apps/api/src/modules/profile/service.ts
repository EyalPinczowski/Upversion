import {
  findPii,
  setupQuestions,
  validateAnswer,
  type ProfileAnswers,
  type ProfileImport,
  type ProfileSkill,
  type SetupStatusUpdate,
  type UserProfile,
} from '@upversion/shared';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import { createProfileRepository } from './repository';

const bad = (code: string, message: string) => new HttpError(400, code, message);

const QUESTIONS = new Map(setupQuestions().map((q) => [q.id, q]));

/** Taxonomy membership through the shared validator, so the ids come from the bundled catalog. */
const allSkillIds = (ids: string[]) => validateAnswer({ type: 'multi_skill' }, ids).ok;
const allRoleIds = (ids: string[]) => validateAnswer({ type: 'multi_role' }, ids).ok;

/**
 * Profile and setup state (ADR 015). The user id is the verified token's, passed in by the
 * routes; every query runs in db.withUser, so RLS applies. Messages never echo what the client
 * sent, and nothing here logs answers, skills or titles.
 */
export function createProfileService(db: Database, now: () => Date = () => new Date()) {
  return {
    get: (userId: string): Promise<UserProfile> =>
      db.withUser(userId, (ctx) => createProfileRepository(ctx).get(userId)),

    putAnswers(userId: string, answers: ProfileAnswers): Promise<UserProfile> {
      const clean: ProfileAnswers = {};
      for (const [id, value] of Object.entries(answers)) {
        const question = QUESTIONS.get(id);
        if (!question) {
          throw bad('invalid_answer', 'An answer names a question that is not part of setup.');
        }
        const result = validateAnswer(question, value);
        if (!result.ok) {
          throw bad('invalid_answer', `An answer is not valid for its question: ${result.error}.`);
        }
        clean[id] = result.value;
      }
      return db.withUser(userId, (ctx) =>
        createProfileRepository(ctx).mergeAnswers(userId, clean, now()),
      );
    },

    importCv(userId: string, input: ProfileImport): Promise<UserProfile> {
      const skillIds = input.skills.map((s) => s.skillId);
      if (new Set(skillIds).size !== skillIds.length) {
        throw bad('invalid_import', 'A skill appears twice.');
      }
      if (!allSkillIds(skillIds)) throw bad('invalid_import', 'A skill is not in the skill list.');
      const roleIds = input.rolesHeld.flatMap((r) => (r.roleId === null ? [] : [r.roleId]));
      for (const id of roleIds) {
        if (!allRoleIds([id])) throw bad('invalid_import', 'A role is not in the role list.');
      }
      for (const r of input.rolesHeld) {
        // Defence in depth: the browser already drops titles with personal details.
        if (findPii(r.title).length > 0) {
          throw bad('invalid_import', 'A role title looks like it holds personal details.');
        }
      }
      const toolsQuestion = QUESTIONS.get('tools_known');
      let tools: unknown[] = [];
      if (input.tools.length > 0 && toolsQuestion) {
        const result = validateAnswer(toolsQuestion, input.tools);
        if (!result.ok) throw bad('invalid_import', 'A tool is not one of the options.');
        tools = result.value as unknown[];
      }

      return db.withUser(userId, async (ctx) => {
        const repo = createProfileRepository(ctx);
        const at = now();
        const current = await repo.lock(userId, at);
        // Only `cv` items are replaced; the user's own (manual, setup) win on a clash.
        const kept = current.skills.filter((s) => s.source !== 'cv');
        const own = new Set(kept.map((s) => s.skillId));
        const fromCv: ProfileSkill[] = input.skills
          .filter((s) => !own.has(s.skillId))
          .map((s) => ({ skillId: s.skillId, level: s.level, source: 'cv' }));
        // Skill ids are unique and the taxonomy is smaller than the row's cap of 60, so this fits.
        const skills = [...kept, ...fromCv];
        const answers = { ...current.answers };
        if (input.education !== null && answers.education === undefined) {
          answers.education = input.education;
        }
        if (tools.length > 0 && answers.tools_known === undefined) answers.tools_known = tools;
        return repo.saveImport(
          userId,
          { answers, skills, rolesHeld: input.rolesHeld, yearsExperience: input.yearsExperience },
          at,
        );
      });
    },

    setSetup: (userId: string, update: SetupStatusUpdate): Promise<UserProfile> =>
      db.withUser(userId, (ctx) =>
        createProfileRepository(ctx).setSetup(userId, update.status, update.step, now()),
      ),

    clear: (userId: string): Promise<UserProfile> =>
      db.withUser(userId, (ctx) => createProfileRepository(ctx).clear(userId, now())),
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
