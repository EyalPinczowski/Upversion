import { createHash, randomUUID } from 'node:crypto';
import {
  FEEDBACK_BLOCK_INSTRUCTION,
  FEEDBACK_JSON_INSTRUCTION,
  GENERIC_RUBRIC_STEPS,
  PERSONAS,
  PiiLeakError,
  addDays,
  buildPracticePrompt,
  knownIdentifiersFor,
  localDateOf,
  normalizeEnteredScore,
  parseFeedbackBlock,
  parseModelFeedback,
  redactPii,
  RETRY_JSON_INSTRUCTION,
  sanitizeUserText,
  rubricFeedback,
  trendsByKind,
  type BuiltPracticePrompt,
  type PracticePromptInput,
} from '@upversion/shared';
import { ZodError } from 'zod';
import { reserveUserCap, utcDay, type AIUsageStore } from '../../ai/budget';
import {
  AIUnavailableError,
  AIUserCapError,
  type AIGateway,
  type GatewayResult,
} from '../../ai/gateway';
import type { AIPurpose } from '../../ai/provider';
import { buildSafeRequest, truncateHistory, type SafeMessage } from '../../ai/safe-request';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { requireWritablePlan } from '../plans/guard';
import * as plansRepo from '../plans/repository';
import type { createTaskService } from '../tasks/service';
import type { TaskView } from '../tasks/schemas';
import * as repo from './repository';
import type {
  FeedbackRow,
  MessageRow,
  NewFeedback,
  PromptInputsRecord,
  SessionRow,
} from './repository';
import {
  HISTORY_MAX_LIMIT,
  TREND_SESSION_LIMIT,
  type FeedbackView,
  type FinishBody,
  type MessageView,
  type PasteFeedbackBody,
  type SendMessageBody,
  type SessionView,
} from './schemas';

export type TaskService = ReturnType<typeof createTaskService>;

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');
const unprocessable = (message: string) => new HttpError(422, 'unprocessable', message);
/** 409 with the running session's id in the body, so the client can carry on with it. */
const activeConflict = (sessionId: string) =>
  new HttpError(
    409,
    'practice_session_active',
    `This task already has an active practice session (${sessionId}).`,
    { sessionId },
  );
const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);

/** The kind a practice task without a `practiceKind` is stored under. */
export const DEFAULT_KIND = 'general';
/** How many "studied this week" topics a prompt carries. */
const MAX_TOPICS = 10;
/** A week is today and the six days before it (plan-local). */
const TOPIC_WINDOW_DAYS = 6;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

const iso = (d: Date) => d.toISOString();

/** What the in-app chat needs besides the database. Absent means in-app practice is off. */
export interface ChatDeps {
  gateway: AIGateway;
  usage: AIUsageStore;
  userCaps: Readonly<Record<AIPurpose, number>>;
  /** The gateway's whole-turn limit; a pending marker only goes stale well after it. */
  turnTimeoutMs: number;
}

/** The least time a pending marker is believed. */
export const MIN_STALE_PENDING_MS = 60_000;
/**
 * A turn that has been pending longer than this is treated as dead (a crash). It must outlast
 * a live turn: an AI finish can make two gateway calls, each up to the turn limit.
 */
export const stalePendingMs = (turnTimeoutMs: number): number =>
  Math.max(MIN_STALE_PENDING_MS, 2 * turnTimeoutMs + 15_000);
/** What the client can do instead of the in-app chat. */
const FALLBACKS = ['copy_prompt', 'self_rubric'];
/** A model name or provider id is shown to the client only if it looks like a plain slug. */
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const safeSlug = (value: string | null | undefined, max: number): string | null =>
  typeof value === 'string' && value.length <= max && SAFE_SLUG.test(value) ? value : null;
const MAX_REPLY_STORED = 8000;
const MAX_SYSTEM_CHARS = 19_000;

const aiUnavailable = () =>
  new HttpError(503, 'ai_unavailable', 'In-app practice is not available right now.', {
    fallbacks: FALLBACKS,
  });
const turnInProgress = () =>
  new HttpError(409, 'turn_in_progress', 'The previous turn is still being answered. Try again.');

/** Provider and gateway failures as client answers. Never carries provider text. */
function chatError(error: unknown): unknown {
  if (error instanceof AIUnavailableError) return aiUnavailable();
  if (error instanceof ZodError) return unprocessable('That text cannot be sent to the model.');
  return error;
}
const minutesBetween = (a: Date, b: Date) =>
  Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/**
 * A stable uuid for the one log a session writes, so a retried finish cannot log twice. It is a
 * hash of the session id, not the session id itself, so it does not collide with a log id the
 * client chose (only a deliberate SHA-256 match could; not by accident).
 */
export function sessionLogId(sessionId: string): string {
  const h = createHash('sha256').update(`practice-log:${sessionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The fixed first message of an in-app session. No model writes it. */
function openerText(personaId: keyof typeof PERSONAS, task: TaskView, minutes: number): string {
  const step = task.howToSteps.map((x) => x.trim()).find((x) => x.length > 0);
  const label = PERSONAS[personaId].label;
  return clip(
    `Welcome to your ${label.toLowerCase()} session. You have about ${minutes} minutes. ` +
      (step ? `Start with this: ${step} ` : '') +
      'Tell me when you are ready and we begin.',
    1000,
  );
}

const toMessageView = (m: MessageRow): MessageView => ({
  id: m.id,
  seq: m.seq,
  role: m.role,
  content: m.content,
  providerId: m.providerId,
  model: m.model,
  redacted: m.redacted,
  createdAt: iso(m.createdAt),
});

const toSessionView = (s: SessionRow): SessionView => ({
  id: s.id,
  planId: s.planId,
  taskId: s.taskId,
  kind: s.kind,
  persona: s.persona,
  channel: s.channel,
  status: s.status,
  plannedMinutes: s.plannedMinutes,
  startedAt: iso(s.startedAt),
  endedAt: s.endedAt ? iso(s.endedAt) : null,
  prompt: s.prompt,
  inputs: s.inputs,
});

const toFeedbackView = (f: FeedbackRow): FeedbackView => ({
  source: f.source,
  score: f.score,
  strengths: f.strengths,
  improve: f.improve,
  nextFocus: f.nextFocus,
  raw: f.raw,
  createdAt: iso(f.createdAt),
});

interface Topic {
  id: string;
  title: string;
}

/** What the prompt is built from, besides the task. */
interface Gathered {
  jobDescription: string;
  nextFocus: { sessionId: string; nextFocus: string } | null;
  knownIdentifiers: string[];
}

interface Built {
  /** With the job description: what the user copies. */
  full: BuiltPracticePrompt;
  /** Without it: what a session stores. */
  stored: BuiltPracticePrompt;
}

const kindOf = (task: TaskView) => clip(task.practiceKind?.trim() || DEFAULT_KIND, 100);

/** The allowlisted prompt input for a task, cut to the prompt schema's limits. */
function promptInput(
  task: TaskView,
  topics: Topic[],
  g: Gathered,
  withJobDescription: boolean,
): PracticePromptInput {
  return {
    practiceKind: clip(kindOf(task), 60),
    task: {
      title: clip(task.title, 200),
      ...(task.promptTemplate ? { promptTemplate: clip(task.promptTemplate, 4000) } : {}),
      howToSteps: task.howToSteps.slice(0, 30).map((s) => clip(s, 500)),
      plannedMinutes: Math.min(600, Math.max(1, Math.round(task.estHours * 60))),
    },
    ...(g.nextFocus ? { nextFocus: clip(g.nextFocus.nextFocus, 1000) } : {}),
    weekTopics: topics.map((t) => ({ title: clip(t.title, 200) })),
    ...(withJobDescription && g.jobDescription ? { jobDescription: g.jobDescription } : {}),
  };
}

/** Builds both prompts. A leak or an invalid input is a 422, never a 500, and never echoes text. */
function build(task: TaskView, topics: Topic[], g: Gathered): Built {
  const options = { knownIdentifiers: g.knownIdentifiers };
  try {
    return {
      full: buildPracticePrompt(promptInput(task, topics, g, true), options),
      stored: buildPracticePrompt(promptInput(task, topics, g, false), options),
    };
  } catch (error) {
    if (error instanceof PiiLeakError) {
      throw new HttpError(
        422,
        'pii_blocked',
        'The prompt still contained personal details after removing them. Edit the task text or the job description.',
      );
    }
    if (error instanceof ZodError) {
      throw unprocessable('The task cannot be turned into a practice prompt.');
    }
    throw error;
  }
}

async function gather(
  ctx: UserContext,
  userId: string,
  planId: string,
  kind: string,
): Promise<Gathered> {
  // One after the other: a transaction has a single connection.
  const identity = await repo.getIdentity(ctx, userId);
  const context = await repo.getContext(ctx, userId, planId);
  const nextFocus = await repo.lastNextFocus(ctx, userId, planId, kind);
  return {
    jobDescription: context?.jobDescription ?? '',
    nextFocus,
    knownIdentifiers: knownIdentifiersFor({
      email: identity.email,
      displayName: identity.displayName,
    }),
  };
}

const sameFeedback = (a: FeedbackRow, b: NewFeedback) =>
  a.source === b.source &&
  a.score === b.score &&
  a.strengths === b.strengths &&
  a.improve === b.improve &&
  a.nextFocus === b.nextFocus &&
  a.raw === b.raw;

/** The finish options the two finishing routes share. */
interface Completion {
  markDone: boolean;
  logHours: number | null;
}

interface FinishRequest extends Completion {
  /** The feedback this call brings; null when it brings none. */
  feedback: NewFeedback | null;
  /** Pasted text: its parse result is reported back. */
  parsed?: boolean;
  /** AI finish: the turn marker this call set; if it is gone the model result is dropped. */
  pendingTurnId?: string;
}

export interface FinishResult {
  session: SessionView;
  feedback: FeedbackView | null;
  loggedHours: number | null;
  task: { status: TaskView['status']; doneHours: number };
  replayed: boolean;
  /** Only for pasted feedback. */
  parsed?: boolean;
}

/**
 * Practice sessions without a model (spec 3.3): the job description, the dynamic prompt, sessions
 * on practice tasks, pasted or self-scored feedback, history and trends.
 *
 * Rules this module keeps:
 * - Facts about tasks (type, steps, estimate, status) and every change to them (logging hours,
 *   marking done) go through the tasks service. This module's SQL never reads the tasks table.
 * - A task is marked done only when the request says `markDone: true`, and only by
 *   `completeTask`. Finishing a session otherwise leaves the task status alone.
 * - The job description (Tier 2) lives in practice_contexts. It is never stored in a session's
 *   prompt, an event or a log line.
 * - The user id is the verified caller's. It is never read from a request.
 */
export function createPracticeService(
  db: Database,
  tasks: TaskService,
  now: () => Date = () => new Date(),
  chat: ChatDeps | null = null,
) {
  const staleMs = stalePendingMs(chat?.turnTimeoutMs ?? 0);
  const isFresh = (pending: { since: Date } | null): boolean =>
    pending !== null && now().getTime() - pending.since.getTime() < staleMs;

  /** True when at least one provider could take a call now. */
  const aiAvailable = (): boolean =>
    chat !== null &&
    chat.gateway
      .providers()
      .some((p) => p.configured && p.budget !== null && p.cooldownUntil === null);

  /** Best effort: a failed clear is recovered by the stale-pending rule. */
  const clearPendingQuietly = async (userId: string, sessionId: string, turnId: string) => {
    try {
      await db.withUser(userId, (ctx) => repo.clearPending(ctx, userId, sessionId, turnId));
    } catch {
      // Stale after 60 s.
    }
  };

  /** The model's view of the session: system text and the user/assistant turns. */
  function chatContext(session: SessionRow, messages: MessageRow[], historyChars: number) {
    const persona = PERSONAS[session.persona as keyof typeof PERSONAS] ?? PERSONAS.generic_coach;
    let setup = session.prompt;
    if (setup.startsWith(persona.system)) setup = setup.slice(persona.system.length).trimStart();
    const at = setup.lastIndexOf(FEEDBACK_BLOCK_INSTRUCTION);
    if (at >= 0) setup = setup.slice(0, at).trimEnd();
    // The opener (everything before the first user turn) goes into the system text, so the
    // transcript starts with the user, which every provider accepts.
    let opener = '';
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      if (m.role === 'note') continue;
      if (m.role === 'assistant' && !turns.some((t) => t.role === 'user')) {
        opener = m.content;
        continue;
      }
      // Older unanswered user messages (a failed turn the user did not retry) are dropped:
      // only the newest of a run counts, so the size stays bounded.
      const last = turns[turns.length - 1];
      if (last && last.role === m.role) last.content = m.content;
      else turns.push({ role: m.role, content: m.content });
    }
    // Newest 60 turns, starting with the user, then cut to the size limit (which keeps the
    // "earlier turns omitted" note on the oldest kept turn).
    let recent = turns.slice(-60);
    while (recent[0]?.role === 'assistant' && recent.length > 1) recent = recent.slice(1);
    const system = clip(
      `${persona.system}\n\n${setup}${
        opener ? `\n\nYou already opened the session with: ${opener}` : ''
      }\n\nThe user now answers. Do not write a feedback block unless asked.`,
      MAX_SYSTEM_CHARS,
    );
    const history: SafeMessage[] = truncateHistory(recent, historyChars);
    return { system, history };
  }

  /** A user instruction after the transcript (merged into a trailing user turn if there is one). */
  function withInstruction(history: SafeMessage[], instruction: string): SafeMessage[] {
    const last = history[history.length - 1];
    if (last && last.role === 'user') {
      return [
        ...history.slice(0, -1),
        { role: 'user', content: `${last.content}\n\n${instruction}` },
      ];
    }
    return [...history, { role: 'user', content: instruction }];
  }

  /** The task, or 404; 422 when it is not a practice task. */
  async function practiceTask(userId: string, planId: string, taskId: string): Promise<TaskView> {
    const task = await tasks.getTask(userId, planId, taskId);
    if (task.type !== 'practice') throw unprocessable('This task is not a practice.');
    return task;
  }

  /** The other tasks the user logged time on in the last 7 plan-local days, newest first. */
  async function weekTopics(userId: string, planId: string, taskId: string): Promise<Topic[]> {
    const timezone = await db.withUser(userId, (ctx) =>
      plansRepo.planTimezone(ctx, userId, planId),
    );
    if (!timezone) return [];
    const today = localDateOf(now(), timezone);
    const logs = await tasks.listLogs(userId, planId, addDays(today, -TOPIC_WINDOW_DAYS), today);
    const logged = new Set(logs.map((l) => l.taskId));
    logged.delete(taskId);
    if (logged.size === 0) return [];
    const titles = new Map((await tasks.listTasks(userId, planId)).map((t) => [t.id, t.title]));
    const topics: Topic[] = [];
    const seen = new Set<string>();
    for (const log of [...logs].reverse()) {
      if (!logged.has(log.taskId) || seen.has(log.taskId)) continue;
      const title = titles.get(log.taskId);
      if (title === undefined) continue;
      seen.add(log.taskId);
      topics.push({ id: log.taskId, title });
      if (topics.length === MAX_TOPICS) break;
    }
    return topics;
  }

  async function sessionDetail(ctx: UserContext, userId: string, session: SessionRow) {
    const messages = await repo.listMessages(ctx, userId, session.id);
    const feedback = await repo.getFeedback(ctx, userId, session.id);
    return {
      session: toSessionView(session),
      messages: messages.map(toMessageView),
      feedback: feedback ? toFeedbackView(feedback) : null,
    };
  }

  /** The feedback a finish call brings: a self-check, an entered score, or none. */
  function feedbackFromFinish(task: TaskView, body: FinishBody): NewFeedback | null {
    if (body.rubric) {
      const own = task.howToSteps.some((s) => s.trim().length > 0);
      const steps = own ? task.howToSteps : [...GENERIC_RUBRIC_STEPS];
      const checkedSteps = [...new Set(body.rubric.checkedSteps)];
      if (checkedSteps.some((i) => i >= steps.length)) {
        throw unprocessable('A ticked step is not one of the steps of this practice.');
      }
      const checked = steps.map((_, i) => checkedSteps.includes(i));
      const feedback = rubricFeedback(steps, checked);
      if (!feedback) throw unprocessable('This practice has no steps to score.');
      return {
        source: 'self_rubric',
        score: feedback.score,
        strengths: feedback.strengths,
        improve: feedback.improve,
        nextFocus: feedback.next_focus,
        raw: null,
      };
    }
    if (body.enteredScore) {
      const { score, max } = body.enteredScore;
      const normalised = normalizeEnteredScore(score, max);
      if (normalised === null)
        throw unprocessable('That score cannot be turned into a 0 to 10 score.');
      return {
        source: 'self_rubric',
        score: normalised,
        strengths: `Score you entered: ${score} out of ${max}.`,
        improve: '',
        nextFocus: '',
        raw: null,
      };
    }
    return null;
  }

  /**
   * A session that is already finished. The same request again (same feedback, same options)
   * answers the stored result and changes nothing; anything else is a 409. Nothing is applied on
   * a replay, not even a `markDone` that the first call did not have.
   */
  async function replay(
    ctx: UserContext,
    userId: string,
    session: SessionRow,
    request: FinishRequest,
  ): Promise<Omit<FinishResult, 'task'>> {
    const stored = await repo.getFeedback(ctx, userId, session.id);
    const event = await repo.finishedEventPayload(ctx, userId, session.planId, session.id);
    const hours = request.logHours && request.logHours > 0 ? request.logHours : null;
    const sameOptions =
      event !== null &&
      event.markedDone === request.markDone &&
      (event.loggedHours ?? null) === hours;
    // A call that brings no feedback accepts whatever the session ended with.
    const sameBody =
      request.feedback === null || (stored !== null && sameFeedback(stored, request.feedback));
    if (!sameOptions || !sameBody) {
      throw conflict('This practice was already finished with different feedback or options.');
    }
    return {
      session: toSessionView(session),
      feedback: stored ? toFeedbackView(stored) : null,
      loggedHours: typeof event?.loggedHours === 'number' ? event.loggedHours : null,
      replayed: true,
    };
  }

  /**
   * Finishes a session in ONE transaction, so a finish either happens completely or not at all:
   * 1. lock the session row and confirm it is still active (a racing abandon or second finish
   *    waits here, then sees the final status);
   * 2. through the tasks service, inside this same transaction: the hours log (a fixed id per
   *    session) and, only with `markDone`, `completeTask`;
   * 3. the feedback, the session's end and the `practice.finished` event.
   * Any failure, including a 409 for a conflicting repeat, rolls back every step: no log, no
   * status change, no event. Feedback never marks anything done by itself.
   */
  async function complete(
    userId: string,
    planId: string,
    sessionId: string,
    prepare: (task: TaskView) => FinishRequest,
  ): Promise<FinishResult> {
    // Only to read the task's steps for a rubric; the facts that decide anything are re-read
    // under the lock below.
    const taskId = await db.withUser(userId, async (ctx) => {
      const found = await repo.getSession(ctx, userId, planId, sessionId);
      if (!found) throw notFound();
      return found.taskId;
    });
    const request = prepare(await tasks.getTask(userId, planId, taskId));
    const hours = request.logHours && request.logHours > 0 ? request.logHours : null;
    const result = (r: Omit<FinishResult, 'task'>, t: TaskView): FinishResult => ({
      ...r,
      task: { status: t.status, doneHours: t.doneHours },
      ...(request.parsed === undefined ? {} : { parsed: request.parsed }),
    });

    return db.withUser(userId, async (ctx) => {
      const session = await repo.getSession(ctx, userId, planId, sessionId, true);
      if (!session) throw notFound();
      if (request.pendingTurnId !== undefined) {
        // The model result is only used if this turn still owns the session and it is active.
        const pending = await repo.getPending(ctx, userId, sessionId);
        if (session.status !== 'active' || pending?.turnId !== request.pendingTurnId) {
          throw conflict(
            'The session changed while the feedback was written. Try again.',
            'turn_superseded',
          );
        }
      }
      if (session.status === 'abandoned') throw conflict('This practice was abandoned.');
      let current = await tasks.getTaskIn(ctx, userId, planId, session.taskId);
      if (session.status === 'finished') {
        return result(await replay(ctx, userId, session, request), current);
      }
      if (request.markDone && current.status === 'skipped') {
        throw conflict('Reopen the task before marking it done.');
      }

      if (hours !== null) {
        const timezone = (await plansRepo.planTimezone(ctx, userId, planId)) ?? 'UTC';
        const logged = await tasks.addLogIn(ctx, userId, planId, session.taskId, {
          id: sessionLogId(session.id),
          date: localDateOf(session.startedAt, timezone),
          hours,
        });
        current = logged.task;
      }
      if (request.markDone) {
        current = await tasks.completeTaskIn(ctx, userId, planId, session.taskId);
      }

      const endedAt = now();
      const feedback = request.feedback
        ? await repo.insertFeedback(ctx, userId, sessionId, request.feedback, endedAt)
        : null;
      const ended = await repo.endSession(ctx, userId, planId, sessionId, 'finished', endedAt);
      await plansRepo.insertEvent(ctx, userId, planId, 'practice.finished', {
        sessionId,
        taskId: ended.taskId,
        kind: ended.kind,
        source: feedback?.source ?? null,
        score: feedback?.score ?? null,
        minutes: minutesBetween(ended.startedAt, ended.endedAt ?? endedAt),
        markedDone: request.markDone,
        loggedHours: hours,
      });
      return result(
        {
          session: toSessionView(ended),
          feedback: feedback ? toFeedbackView(feedback) : null,
          loggedHours: hours,
          replayed: false,
        },
        current,
      );
    });
  }

  /**
   * Finish an in-app session with feedback from the model. Same shape as the other finishes:
   * the model is called with no transaction open (the feedback call is reserved and the turn
   * marked pending first), then `complete` saves the feedback and finishes in one transaction.
   * Valid JSON is saved as `model_json`, JSON that needed local repair as `model_repaired`
   * (no retry), anything else gets ONE retry and then is kept as `free_text`. Marking the task
   * done still needs `markDone`.
   */
  async function aiFinish(
    userId: string,
    planId: string,
    sessionId: string,
    body: FinishBody,
  ): Promise<FinishResult> {
    const options = { markDone: body.markDone, logHours: body.logHours };
    if (!chat) throw aiUnavailable();
    const turnId = randomUUID();
    const prep = await db.withUser(userId, async (ctx) => {
      const session = await repo.getSession(ctx, userId, planId, sessionId, true);
      if (!session) throw notFound();
      if (session.channel !== 'in_app') {
        throw unprocessable('AI feedback is only for in-app sessions.');
      }
      // Finished or abandoned: the normal finish decides (replay or 409), with no model call.
      if (session.status !== 'active') return null;
      const pending = await repo.getPending(ctx, userId, sessionId);
      if (isFresh(pending)) {
        throw turnInProgress();
      }
      const messages = await repo.listMessages(ctx, userId, sessionId);
      if (!messages.some((m) => m.role === 'user')) {
        throw unprocessable('Say something in the chat before asking for feedback.');
      }
      if (!aiAvailable()) throw aiUnavailable();
      if (body.markDone) {
        // Fail before spending a call on a finish that would be refused afterwards.
        const task = await tasks.getTaskIn(ctx, userId, planId, session.taskId);
        if (task.status === 'skipped') throw conflict('Reopen the task before marking it done.');
      }
      if (
        !(await reserveUserCap(
          ctx,
          userId,
          utcDay(now()),
          'practice_feedback',
          chat.userCaps.practice_feedback,
        ))
      ) {
        throw new AIUserCapError('practice_feedback');
      }
      await repo.setPending(ctx, userId, sessionId, turnId, now());
      const identity = await repo.getIdentity(ctx, userId);
      return {
        session,
        messages,
        knownIdentifiers: knownIdentifiersFor({
          email: identity.email,
          displayName: identity.displayName,
        }),
      };
    });
    if (prep === null) {
      return complete(userId, planId, sessionId, () => ({ ...options, feedback: null }));
    }

    try {
      const { system, history } = chatContext(
        prep.session,
        prep.messages,
        chat.gateway.historyLimitChars(),
      );
      const ask = (instruction: string) =>
        chat.gateway.generate({
          userId,
          request: buildSafeRequest(
            {
              purpose: 'practice_feedback',
              system,
              messages: withInstruction(history, instruction),
              maxOutputTokens: 400,
              json: true,
            },
            prep.knownIdentifiers,
          ),
          userCap: 'already_reserved',
        });
      const toFeedback = (
        f: { score: number; strengths: string; improve: string; next_focus: string },
        source: 'model_json' | 'model_repaired',
      ): NewFeedback => ({
        source,
        score: f.score,
        strengths: f.strengths,
        improve: f.improve,
        nextFocus: f.next_focus,
        raw: null,
      });

      let feedback: NewFeedback;
      const first = await ask(FEEDBACK_JSON_INSTRUCTION);
      const parsed = parseModelFeedback(first.text);
      if (parsed.ok) {
        // A local repair saved a call.
        if (parsed.repaired) {
          await chat.usage.noteAvoided(userId, 'practice_feedback').catch(() => undefined);
        }
        feedback = toFeedback(parsed.feedback, parsed.repaired ? 'model_repaired' : 'model_json');
      } else {
        feedback = {
          source: 'free_text',
          score: null,
          strengths: '',
          improve: '',
          nextFocus: '',
          raw: parsed.freeText,
        };
        // One retry, counted against the user's cap and the provider budget, and skipped when
        // the cap is used up. Any failure here keeps the free text.
        try {
          const reserved = await db.withUser(userId, (ctx) =>
            reserveUserCap(
              ctx,
              userId,
              utcDay(now()),
              'practice_feedback',
              chat.userCaps.practice_feedback,
            ),
          );
          if (reserved) {
            const second = parseModelFeedback(
              (await ask(`${FEEDBACK_JSON_INSTRUCTION}\n\n${RETRY_JSON_INSTRUCTION}`)).text,
            );
            if (second.ok) {
              feedback = toFeedback(
                second.feedback,
                second.repaired ? 'model_repaired' : 'model_json',
              );
            }
          }
        } catch {
          // Keep the free text.
        }
      }
      return await complete(userId, planId, sessionId, () => ({
        ...options,
        feedback,
        pendingTurnId: turnId,
      }));
    } catch (error) {
      throw chatError(error);
    } finally {
      await clearPendingQuietly(userId, sessionId, turnId);
    }
  }

  return {
    // -- context ------------------------------------------------------------------------------

    getContext: (userId: string, planId: string) =>
      db.withUser(userId, async (ctx) => {
        if (!(await plansRepo.planExists(ctx, userId, planId))) throw notFound();
        const row = await repo.getContext(ctx, userId, planId);
        return {
          jobDescription: row?.jobDescription ?? '',
          updatedAt: row ? iso(row.updatedAt) : null,
        };
      }),

    putContext: (userId: string, planId: string, jobDescription: string) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        const identity = await repo.getIdentity(ctx, userId);
        const updatedAt = await repo.upsertContext(ctx, userId, planId, jobDescription, now());
        const { count } = redactPii(jobDescription, {
          knownIdentifiers: knownIdentifiersFor({
            email: identity.email,
            displayName: identity.displayName,
          }),
        });
        return { jobDescription, updatedAt: iso(updatedAt), redactionsPreview: count };
      }),

    // -- prompt -------------------------------------------------------------------------------

    prompt: async (userId: string, planId: string, taskId: string) => {
      const task = await practiceTask(userId, planId, taskId);
      const topics = await weekTopics(userId, planId, taskId);
      return db.withUser(userId, async (ctx) => {
        const g = await gather(ctx, userId, planId, kindOf(task));
        const { full } = build(task, topics, g);
        return {
          persona: { id: full.personaId, label: PERSONAS[full.personaId].label },
          prompt: full.copyText,
          inputs: {
            nextFocus: g.nextFocus?.nextFocus ?? null,
            nextFocusFrom: g.nextFocus?.sessionId ?? null,
            topics: topics.map((t) => t.title),
            jobDescriptionIncluded: g.jobDescription.length > 0,
            redactions: full.redactions,
          },
          feedbackFormat: FEEDBACK_BLOCK_INSTRUCTION,
        };
      });
    },

    /**
     * What the day briefing shows for a practice task: the same prompt as `prompt` (so the same
     * job-description rule) and the id of the active session, if any. Reads only; no model call.
     */
    briefingEntry: async (userId: string, planId: string, taskId: string) => {
      const task = await practiceTask(userId, planId, taskId);
      const topics = await weekTopics(userId, planId, taskId);
      return db.withUser(userId, async (ctx) => {
        const g = await gather(ctx, userId, planId, kindOf(task));
        const { full } = build(task, topics, g);
        const active = await repo.activeSessionId(ctx, userId, planId, taskId);
        return { prompt: full.copyText, practiceSessionId: active };
      });
    },

    // -- sessions -----------------------------------------------------------------------------

    /**
     * Idempotent on the client's session id: the same id with the same task and channel answers
     * the stored session (`created: false`); the same id for anything else is a 409, and so is a
     * second active session on the task. The stored prompt never holds the job description.
     */
    createSession: async (
      userId: string,
      planId: string,
      taskId: string,
      input: { id: string; channel: 'in_app' | 'external' | 'self' },
    ) => {
      const task = await practiceTask(userId, planId, taskId);
      const topics = await weekTopics(userId, planId, taskId);
      const result = await db.withUser(userId, async (ctx) => {
        // One writer per plan at a time, so "one active session per task" cannot race. An
        // archived plan takes no new session (ADR 017 section 4.1).
        await requireWritablePlan(ctx, userId, planId);
        const existing = await repo.getSessionById(ctx, userId, input.id);
        if (existing) {
          if (
            existing.planId !== planId ||
            existing.taskId !== taskId ||
            existing.channel !== input.channel
          ) {
            throw conflict('This session id was already used for different data.');
          }
          return {
            created: false,
            session: toSessionView(existing),
            messages: (await repo.listMessages(ctx, userId, existing.id)).map(toMessageView),
          };
        }
        const active = await repo.activeSessionId(ctx, userId, planId, taskId);
        if (active) {
          throw activeConflict(active);
        }
        if (input.channel === 'in_app' && !aiAvailable()) throw aiUnavailable();
        const kind = kindOf(task);
        const g = await gather(ctx, userId, planId, kind);
        const { stored } = build(task, topics, g);
        const inputs: PromptInputsRecord = {
          nextFocusFromSession: g.nextFocus?.sessionId ?? null,
          topicTaskIds: topics.map((t) => t.id),
          jobDescriptionIncluded: g.jobDescription.length > 0,
          redactions: stored.redactions,
        };
        // A savepoint, so a unique violation leaves the transaction usable for the read below.
        await ctx.client.query('savepoint insert_session');
        let created;
        try {
          created = await repo.insertSession(ctx, userId, {
            id: input.id,
            planId,
            taskId,
            kind,
            persona: stored.personaId,
            channel: input.channel,
            plannedMinutes: Math.min(1440, Math.max(1, Math.round(task.estHours * 60))),
            startedAt: now(),
            prompt: stored.copyText,
            inputs,
          });
        } catch (error: unknown) {
          // The plan lock above makes this unreachable; the unique index is the backstop.
          const pg = error as { code?: string; constraint?: string };
          if (pg.code === '23505' && pg.constraint === 'practice_sessions_one_active_idx') {
            await ctx.client.query('rollback to savepoint insert_session');
            const running = await repo.activeSessionId(ctx, userId, planId, taskId);
            if (running) throw activeConflict(running);
            throw conflict(
              'This task already has an active practice session.',
              'practice_session_active',
            );
          }
          throw error;
        }
        await plansRepo.insertEvent(ctx, userId, planId, 'practice.started', {
          sessionId: created.id,
          taskId,
          kind,
          channel: created.channel,
        });
        const messages: MessageView[] = [];
        if (input.channel === 'in_app') {
          // No model call: the opener is fixed text built from the task.
          const opener = await repo.insertMessage(
            ctx,
            userId,
            created.id,
            {
              id: randomUUID(),
              role: 'assistant',
              content: openerText(stored.personaId, task, created.plannedMinutes),
              providerId: null,
              model: null,
              redacted: false,
            },
            created.startedAt,
          );
          messages.push(toMessageView(opener));
        }
        return { created: true, session: toSessionView(created), messages };
      });
      if (result.created && input.channel === 'in_app') {
        await chat?.usage.noteAvoided(userId, 'practice_message').catch(() => undefined);
      }
      return result;
    },

    /**
     * One chat turn. The user's text is cleaned and stored, the user's daily call is reserved
     * and the turn is marked pending, all in one short transaction that commits BEFORE the model
     * is called. The call itself runs with no transaction open. The reply is stored in a second
     * short transaction. A failure clears the marker and keeps the user's message, so sending
     * the same id again retries. The same id after an answer returns the stored pair.
     */
    sendMessage: async (
      userId: string,
      planId: string,
      sessionId: string,
      body: SendMessageBody,
      signal?: AbortSignal,
    ) => {
      if (!chat) throw aiUnavailable();
      const turnId = randomUUID();
      const cap = chat.userCaps.practice_message;
      const usageNow = async (): Promise<{ used: number; cap: number }> => {
        try {
          const snap = await chat.usage.snapshot(userId);
          return { used: snap.user.practice_message.used, cap };
        } catch {
          return { used: 0, cap };
        }
      };
      const toReply = (m: MessageRow) => ({
        id: m.id,
        content: m.content,
        providerId: m.providerId,
        model: m.model,
      });

      const prep = await db.withUser(userId, async (ctx) => {
        // A new message on an archived plan is refused. The second transaction below, which stores
        // the reply of a turn that was already running, is not guarded.
        await requireWritablePlan(ctx, userId, planId);
        const session = await repo.getSession(ctx, userId, planId, sessionId, true);
        if (!session) throw notFound();
        if (session.channel !== 'in_app') throw unprocessable('This is not an in-app session.');
        const identity = await repo.getIdentity(ctx, userId);
        const knownIdentifiers = knownIdentifiersFor({
          email: identity.email,
          displayName: identity.displayName,
        });
        // Throws PiiLeakError (422 pii_blocked) when something personal survives redaction.
        const clean = sanitizeUserText(body.content, { knownIdentifiers });
        const all = await repo.listMessages(ctx, userId, sessionId);
        const existing = all.find((m) => m.id === body.id) ?? null;
        if (existing) {
          if (existing.role !== 'user' || existing.content !== clean.text) {
            throw conflict('This message id was already used for different text.');
          }
          const after = all.filter((m) => m.seq > existing.seq && m.role !== 'note');
          if (after[0]?.role === 'assistant') {
            return { kind: 'replay', userMessage: existing, reply: after[0] } as const;
          }
          if (after.length > 0) {
            // Later messages exist but none answers this one: it was superseded, not pending.
            throw conflict('A later message was sent after this one.', 'message_superseded');
          }
        }
        if (session.status !== 'active') throw conflict('This practice is not active.');
        const pending = await repo.getPending(ctx, userId, sessionId);
        if (isFresh(pending)) {
          throw turnInProgress();
        }
        if (!aiAvailable()) throw aiUnavailable();
        const userMessage =
          existing ??
          (await repo.insertMessage(
            ctx,
            userId,
            sessionId,
            {
              id: body.id,
              role: 'user',
              content: clean.text,
              providerId: null,
              model: null,
              redacted: clean.count > 0,
            },
            now(),
          ));
        // Reserved before the call and committed with this transaction. A failed call still
        // counts (conservative), and so does a retry.
        if (!(await reserveUserCap(ctx, userId, utcDay(now()), 'practice_message', cap))) {
          throw new AIUserCapError('practice_message');
        }
        await repo.setPending(ctx, userId, sessionId, turnId, now());
        const messages = existing ? all : [...all, userMessage];
        return { kind: 'turn', session, userMessage, messages, knownIdentifiers } as const;
      });

      if (prep.kind === 'replay') {
        return {
          userMessage: toMessageView(prep.userMessage),
          reply: toReply(prep.reply),
          switched: null,
          usage: await usageNow(),
          replayed: true,
        };
      }

      // No transaction is open from here until the reply is stored.
      let answer: GatewayResult;
      try {
        const { system, history } = chatContext(
          prep.session,
          prep.messages,
          chat.gateway.historyLimitChars(),
        );
        const request = buildSafeRequest(
          {
            purpose: 'practice_message',
            system,
            messages: history,
            maxOutputTokens: 600,
            json: false,
          },
          prep.knownIdentifiers,
        );
        answer = await chat.gateway.generate({
          userId,
          request,
          userCap: 'already_reserved',
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        await clearPendingQuietly(userId, sessionId, turnId);
        throw chatError(error);
      }

      const providerId = safeSlug(answer.providerId, 64);
      const model = safeSlug(answer.model, 100);
      const labelOf = (id: string) =>
        chat.gateway.providers().find((p) => p.id === id)?.label ?? id;
      const switched =
        answer.switched && safeSlug(answer.switched.from, 64) && providerId
          ? {
              from: answer.switched.from,
              fromLabel: labelOf(answer.switched.from),
              to: providerId,
              toLabel: labelOf(providerId),
              reason: answer.switched.reason,
            }
          : null;
      let reply: MessageRow;
      try {
        reply = await db.withUser(userId, async (ctx) => {
          const locked = await repo.getSession(ctx, userId, planId, sessionId, true);
          const pending = await repo.getPending(ctx, userId, sessionId);
          // Finished or abandoned meanwhile, or a newer turn took over after this one went
          // stale: drop the reply (nothing appended, nothing cleared that is not ours).
          if (!locked || locked.status !== 'active' || pending?.turnId !== turnId) {
            throw conflict(
              'The session changed while the reply was written. Try again.',
              'turn_superseded',
            );
          }
          if (switched) {
            await repo.insertMessage(
              ctx,
              userId,
              sessionId,
              {
                id: randomUUID(),
                role: 'note',
                content: `Continuing on ${switched.toLabel}.`,
                providerId: null,
                model: null,
                redacted: false,
              },
              now(),
            );
          }
          const stored = await repo.insertMessage(
            ctx,
            userId,
            sessionId,
            {
              id: randomUUID(),
              role: 'assistant',
              content: clip(answer.text, MAX_REPLY_STORED),
              providerId,
              model,
              redacted: false,
            },
            now(),
          );
          if (providerId) await repo.addProviderUsed(ctx, userId, sessionId, providerId);
          await repo.clearPending(ctx, userId, sessionId, turnId);
          return stored;
        });
      } catch (error) {
        await clearPendingQuietly(userId, sessionId, turnId);
        throw error;
      }
      return {
        userMessage: toMessageView(prep.userMessage),
        reply: toReply(reply),
        switched,
        usage: await usageNow(),
        replayed: false,
      };
    },

    getSession: (userId: string, planId: string, sessionId: string) =>
      db.withUser(userId, async (ctx) => {
        const session = await repo.getSession(ctx, userId, planId, sessionId);
        if (!session) throw notFound();
        return sessionDetail(ctx, userId, session);
      }),

    /**
     * Saves a pasted feedback block (or plain text, which is kept as free text with no error) and
     * finishes the session in the same call, with the same `markDone` and `logHours` options as
     * `finish`. Pasted feedback replaces a self-check: this call carries no rubric.
     */
    pasteFeedback: (userId: string, planId: string, sessionId: string, body: PasteFeedbackBody) => {
      const parsed = parseFeedbackBlock(body.text);
      const feedback: NewFeedback = parsed.ok
        ? {
            source: 'pasted_block',
            score: parsed.feedback.score,
            strengths: parsed.feedback.strengths,
            improve: parsed.feedback.improve,
            nextFocus: parsed.feedback.next_focus,
            raw: body.text,
          }
        : {
            source: 'free_text',
            score: null,
            strengths: '',
            improve: '',
            nextFocus: '',
            raw: body.text,
          };
      return complete(userId, planId, sessionId, () => ({
        markDone: body.markDone,
        logHours: body.logHours,
        feedback,
        parsed: parsed.ok,
      }));
    },

    /** Finishes with a self-check, an entered score, or no feedback at all. */
    finish: (userId: string, planId: string, sessionId: string, body: FinishBody) =>
      body.aiFeedback
        ? aiFinish(userId, planId, sessionId, body)
        : complete(userId, planId, sessionId, (task) => ({
            markDone: body.markDone,
            logHours: body.logHours,
            feedback: feedbackFromFinish(task, body),
          })),

    /** Active to abandoned: nothing is logged and no event is written. Idempotent. */
    abandon: (userId: string, planId: string, sessionId: string) =>
      db.withUser(userId, async (ctx) => {
        const session = await repo.getSession(ctx, userId, planId, sessionId, true);
        if (!session) throw notFound();
        if (session.status === 'finished') throw conflict('This practice is already finished.');
        if (session.status === 'abandoned') return { session: toSessionView(session) };
        const ended = await repo.endSession(ctx, userId, planId, sessionId, 'abandoned', now());
        return { session: toSessionView(ended) };
      }),

    // -- history and trends -------------------------------------------------------------------

    history: (
      userId: string,
      planId: string,
      q: {
        kind?: string | undefined;
        from?: string | undefined;
        to?: string | undefined;
        limit: number;
      },
    ) =>
      db.withUser(userId, async (ctx) => {
        if (!(await plansRepo.planExists(ctx, userId, planId))) throw notFound();
        const timezone = (await plansRepo.planTimezone(ctx, userId, planId)) ?? 'UTC';
        const rows = await repo.listFinished(ctx, userId, planId, {
          ...q,
          limit: Math.min(q.limit, HISTORY_MAX_LIMIT),
          scoredOnly: false,
          timezone,
        });
        return {
          sessions: rows.map((r) => ({
            id: r.id,
            taskId: r.taskId,
            kind: r.kind,
            channel: r.channel,
            startedAt: iso(r.startedAt),
            minutes: minutesBetween(r.startedAt, r.endedAt),
            score: r.score,
            source: r.source,
          })),
        };
      }),

    /** Score points per kind, oldest first; the summary numbers come from the shared code. */
    trends: (
      userId: string,
      planId: string,
      q: { from?: string | undefined; to?: string | undefined },
    ) =>
      db.withUser(userId, async (ctx) => {
        if (!(await plansRepo.planExists(ctx, userId, planId))) throw notFound();
        const timezone = (await plansRepo.planTimezone(ctx, userId, planId)) ?? 'UTC';
        const newestFirst = await repo.listFinished(ctx, userId, planId, {
          ...q,
          limit: TREND_SESSION_LIMIT,
          scoredOnly: true,
          timezone,
        });
        const rows = [...newestFirst].reverse();
        const summaries = trendsByKind(
          rows.map((r) => ({ practiceKind: r.kind, score: r.score, at: iso(r.startedAt) })),
        );
        return {
          kinds: summaries.map((s) => ({
            kind: s.practiceKind,
            points: rows
              .filter((r) => r.kind === s.practiceKind && r.score !== null && r.source !== null)
              .map((r) => ({ date: r.localDate, score: r.score as number, source: r.source! })),
            last: s.last,
            average: s.average,
            delta: s.delta,
          })),
        };
      }),
  };
}

export type PracticeService = ReturnType<typeof createPracticeService>;
