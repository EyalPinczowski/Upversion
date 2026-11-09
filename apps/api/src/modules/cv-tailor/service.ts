import {
  buildCvTailorPrompt,
  CATALOG_TAXONOMY,
  checkTailoredOutput,
  CvTailorPromptError,
  findCvPii,
  keywordGaps,
  knownIdentifiersFor,
  parseTailorOutput,
  PiiLeakError,
  type CvTailorNote,
  type CvTailorRequest,
  type TailorFlag,
} from '@upversion/shared';
import type { AIUsageStore } from '../../ai/budget';
import { AIUnavailableError, AIUserCapError, type AIGateway } from '../../ai/gateway';
import type { AIPurpose } from '../../ai/provider';
import type { AIRegistry } from '../../ai/registry';
import { buildSafeRequest } from '../../ai/safe-request';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import { getIdentity } from '../practice/repository';

/**
 * The only providers that may receive CV text, in the order they are tried (ADR 016 section 2.3).
 * The ids are the ones in `docs/setup/ai-providers.md`.
 */
export const CV_TAILOR_PROVIDERS = ['cloudflare-ai', 'groq'] as const;

const PURPOSE: AIPurpose = 'cv_tailor';
const MAX_OUTPUT_TOKENS = 1500;
const MAX_NOTES = 40;
const MAX_NOTE_TEXT = 200;
const MAX_FLAGS = 100;
/** What the client can offer instead (ADR 016 section 3). */
const FALLBACKS = ['keyword_list'];
const CAP_FALLBACKS = ['keyword_list', 'copy_prompt'];

export interface CvTailorDeps {
  db: Database;
  gateway: AIGateway;
  registry: AIRegistry;
  usage: AIUsageStore;
  /** The per-user daily cap (config `userCaps.cv_tailor`). */
  userCap: number;
  /** The app-wide daily cap over all users (config `cvTailorDailyTotal`). */
  dailyTotal: number;
}

export interface CvTailorResult {
  text: string;
  notes: CvTailorNote[];
  flags: TailorFlag[];
  providers: { id: string; label: string }[];
  usage: { used: number; cap: number };
}

const unavailable = () =>
  new HttpError(503, 'ai_unavailable', 'CV tailoring is not available right now.', {
    fallbacks: FALLBACKS,
  });

const note = (kind: CvTailorNote['kind'], text: string): CvTailorNote => ({
  kind,
  text: text.slice(0, MAX_NOTE_TEXT),
});

const flagKind = (kind: TailorFlag['kind']): CvTailorNote['kind'] =>
  kind === 'number' ? 'check_number' : kind === 'skill' ? 'check_skill' : 'check_term';

/**
 * CV tailoring (ADR 016). Nothing here stores, caches or logs the CV text, the job text, the
 * prompt or the answer: they live in local variables of one call and in the response. The only
 * trace is the per-user counter the gateway reserves in `ai_usage_daily`.
 */
export function createCvTailorService(deps: CvTailorDeps) {
  const { db, gateway, registry, usage } = deps;

  return {
    async tailor(userId: string, body: CvTailorRequest): Promise<CvTailorResult> {
      // 1. The target role is a catalog id; anything else is a 400 (never free text).
      const role =
        body.roleId === undefined
          ? undefined
          : CATALOG_TAXONOMY.roles.find((r) => r.id === body.roleId);
      if (body.roleId !== undefined && !role) {
        throw new HttpError(400, 'unknown_role', 'The target role is not in the role list.');
      }

      // 2. The check, before anything that costs: the text as received, with the account's own
      //    identifiers. Found something: 422, no cap reserved, no provider called, nothing changed.
      const identity = await db.withUser(userId, (ctx) => getIdentity(ctx, userId));
      const knownIdentifiers = knownIdentifiersFor({
        email: identity.email,
        displayName: identity.displayName,
      });
      const kinds = [
        ...new Set([
          ...findCvPii(body.cvText, { knownIdentifiers }),
          ...findCvPii(body.jobText, { knownIdentifiers }),
        ]),
      ];
      if (kinds.length > 0) throw new PiiLeakError(kinds);

      // 3. The app-wide cap, counted in the database (all users, today, UTC).
      const total = await usage.cvTailorTotalToday(userId);
      if (total >= deps.dailyTotal) {
        throw new HttpError(
          429,
          'ai_feature_cap',
          'CV tailoring has reached its daily limit for everyone. Try again tomorrow.',
          { fallbacks: CAP_FALLBACKS },
        );
      }

      // 4. The prompt and the request.
      let prompt;
      try {
        prompt = buildCvTailorPrompt({
          cvText: body.cvText,
          jobText: body.jobText,
          ...(role ? { targetRole: role.title } : {}),
        });
      } catch (error) {
        if (error instanceof CvTailorPromptError) {
          if (error.code === 'pii_blocked') throw new PiiLeakError(['identifier']);
          throw new HttpError(422, 'too_long', 'The CV and the job post are too long to send.');
        }
        throw error;
      }
      // The window of the two allowed providers only, never the minimum over every registered one.
      const windows = CV_TAILOR_PROVIDERS.flatMap((id) => {
        const p = registry.get(id);
        return p ? [p.maxContextChars] : [];
      });
      if (windows.length > 0 && prompt.system.length + prompt.user.length > Math.min(...windows)) {
        throw new HttpError(422, 'too_long', 'The CV and the job post are too long to send.');
      }
      const request = buildSafeRequest(
        {
          purpose: PURPOSE,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          json: false,
        },
        knownIdentifiers,
        { allowToolNames: true },
      );

      // 5. The gateway: restricted to the two providers, the remaining budget checked before the
      //    user's call is reserved.
      let answer;
      try {
        answer = await gateway.generate({
          userId,
          request,
          userCap: 'reserve',
          providers: CV_TAILOR_PROVIDERS,
        });
      } catch (error) {
        // Fixed bodies: no provider information (the text may or may not have been received).
        if (error instanceof AIUnavailableError) throw unavailable();
        if (error instanceof AIUserCapError) {
          throw new HttpError(
            429,
            'ai_user_cap',
            'You have used today’s CV tailoring runs. Try again tomorrow.',
            { fallbacks: CAP_FALLBACKS },
          );
        }
        throw error;
      }

      // 6. The answer: parsed, checked against the CV, personal details removed.
      const options = { knownIdentifiers };
      const parsed = parseTailorOutput(answer.text, options);
      const raw = parsed.ok ? parsed.text : parsed.plainText;
      const checked = checkTailoredOutput(raw, body.cvText, {
        ...options,
        ...(role ? { targetRole: role.title } : {}),
      });

      const gaps = keywordGaps(body.cvText, body.jobText, {
        ...(role ? { roleId: role.id } : {}),
      });
      const redacted = checked.redacted + (parsed.ok ? parsed.notesRedacted : parsed.redacted);
      const notes: CvTailorNote[] = [];
      if (redacted > 0) {
        notes.push(note('output_redacted', 'Personal details in the answer were removed.'));
      }
      for (const f of checked.flags) notes.push(note(flagKind(f.kind), f.text));
      for (const m of gaps.missing) notes.push(note('missing_keyword', m.name));
      for (const m of gaps.matched) notes.push(note('matched_keyword', m.name));
      if (parsed.ok) {
        for (const g of parsed.gaps) notes.push(note('model_note', `gap: ${g}`));
        for (const k of parsed.keywords) notes.push(note('model_note', `keyword: ${k}`));
      } else {
        notes.push(
          note('model_note', 'The answer did not follow the expected format; shown as plain text.'),
        );
      }
      if (checked.truncated)
        notes.push(note('model_note', 'The answer was cut at its length limit.'));

      const labelOf = (id: string) => gateway.providers().find((p) => p.id === id)?.label ?? id;
      const sent = answer.sentTo.length > 0 ? answer.sentTo : [answer.providerId ?? ''];
      const used = await usage
        .snapshot(userId)
        .then((s) => s.user[PURPOSE].used)
        .catch(() => 0);

      return {
        text: checked.text,
        notes: notes.slice(0, MAX_NOTES),
        flags: checked.flags
          .slice(0, MAX_FLAGS)
          .map((f) => ({ kind: f.kind, text: f.text.slice(0, MAX_NOTE_TEXT) })),
        providers: sent.filter((id) => id !== '').map((id) => ({ id, label: labelOf(id) })),
        usage: { used, cap: deps.userCap },
      };
    },
  };
}
