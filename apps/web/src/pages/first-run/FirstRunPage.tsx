import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAiUsage } from '../../api/ai-hooks';
import type { ProfileView } from '../../api/client';
import {
  PREVIEW_DEBOUNCE_MS,
  useBuildPreview,
  useDebounced,
  useLastGood,
} from '../../api/plan-builder-hooks';
import { useProfile, useSaveAnswers, useSetSetup } from '../../api/profile-hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Loading, ServerProblem } from '../../components/status';
import { Button, ErrorText, ProgressBar } from '../../components/ui';
import { markFirstRunSkipped } from '../../lib/first-run';
import { markWelcomeSeen } from '../../lib/welcome';
import { dateInZone } from '../../lib/zoned-date';
import { useActivePlan } from '../../plan/context';
import {
  browserTimeZone,
  initialState,
  requestKey,
  toRequest,
  validateStep,
  type BuilderState,
  type StepErrors,
} from '../plan-builder/builder-model';
import { BudgetStep } from '../plan-builder/BudgetStep';
import { DraftStep } from '../plan-builder/DraftStep';
import { SkillsStep } from '../plan-builder/SkillsStep';
import { StartPlan } from '../plan-builder/StartPlan';
import { TargetStep } from '../plan-builder/TargetStep';
import { TimeStep } from '../plan-builder/TimeStep';
import { CvPrefill } from './CvPrefill';
import {
  answersForStep,
  FIRST_RUN_STEPS,
  LAST_STEP,
  resumeStep,
  savedStep,
} from './first-run-model';
import { RoleDiscovery } from './RoleDiscovery';

const SAVE_NOTE =
  'We couldn’t save your answers to your profile. Your plan still works; they just won’t be remembered.';

/**
 * `/start`: the first run (ADR 018), four screens after sign-in and the Terms: your goal, where
 * you are now, time and money, then the draft with "Start this plan". It reuses the plan builder's
 * steps, preview and start flow. The plan builder (`FEATURE_PLAN_BUILDER`) must be on; with it off
 * the page does not exist and the person goes to the setup wizard or Today.
 */
export function FirstRunPage() {
  const usage = useAiUsage();
  const profile = useProfile();
  const { plans, query: plansQuery } = useActivePlan();
  if (usage.isPending) return <Loading label="Loading…" />;
  if (usage.isError)
    return <ServerProblem error={usage.error} onRetry={() => void usage.refetch()} />;
  // Builder off: no dead end. The setup wizard (when the profile feature is on) or Today.
  if (usage.data.features.planBuilder !== true) {
    return <Navigate to={profile.data ? '/setup' : '/'} replace />;
  }
  if (profile.isPending) return <Loading label="Loading your profile…" />;
  if (profile.isError) {
    return <ServerProblem error={profile.error} onRetry={() => void profile.refetch()} />;
  }
  if (plansQuery.isPending) return <Loading label="Loading…" />;
  // Anyone who already has a plan skips the first run.
  if (plans.length > 0) return <Navigate to="/" replace />;
  return <FirstRun profile={profile.data} />;
}

function FirstRun({ profile }: { profile: ProfileView | null }) {
  const navigate = useNavigate();
  const { state: auth } = useAuth();
  const userId = auth.status === 'signedIn' ? auth.session.userId : null;
  const { plans, query: plansQuery, select } = useActivePlan();
  const [{ timezone, today }] = useState(() => {
    const zone = browserTimeZone();
    return {
      timezone: zone,
      today: dateInZone(Date.now(), zone) ?? dateInZone(Date.now(), 'UTC')!,
    };
  });
  const [state, setState] = useState<BuilderState>(
    () => initialState(profile, today, timezone).state,
  );
  // The levels and where they came from follow the profile, so a CV import shows up at once.
  const prefill = useMemo(
    () => initialState(profile, today, timezone).prefill,
    [profile, today, timezone],
  );
  const [errors, setErrors] = useState<StepErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [params, setParams] = useSearchParams();
  const saveAnswers = useSaveAnswers();
  const setSetup = useSetSetup();
  const heading = useRef<HTMLHeadingElement>(null);
  const progressLabel = useId();

  const request = useMemo(() => toRequest(state, prefill), [state, prefill]);

  // The step is in the address (?step=2), so the browser's Back and Forward move between screens.
  // With no step in the address, a saved first-run step resumes; otherwise screen 1.
  const asked = Number(params.get('step'));
  const wanted =
    Number.isInteger(asked) && asked >= 1 && asked <= LAST_STEP
      ? asked
      : (resumeStep(profile?.setupStep) ?? 1);
  // A screen is only reachable when the ones before it are finished.
  const step =
    Object.keys(validateStep(1, state)).length > 0
      ? 1
      : wanted === LAST_STEP && request === null
        ? 3
        : wanted;

  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) heading.current?.focus();
    mounted.current = true;
  }, [step]);

  const change = (patch: Partial<BuilderState>) => {
    setState((s) => ({ ...s, ...patch }));
    setErrors({});
  };
  const go = (to: number) => setParams({ step: String(to) });

  const settled = useDebounced(request, PREVIEW_DEBOUNCE_MS);
  const onDraft = step === LAST_STEP;
  const preview = useBuildPreview(onDraft ? settled : null);
  const updating =
    onDraft &&
    request !== null &&
    (requestKey(request) !== requestKey(settled) ||
      preview.isFetching ||
      preview.isPlaceholderData);
  const draft = preview.data;
  const lastGood = useLastGood(preview);

  // The server's own status: a first run in progress, or one that was never started. Anything else
  // (completed, skipped) is never moved back.
  const writable =
    profile !== null &&
    (profile.setupStatus === 'not_started' || profile.setupStatus === 'in_progress');

  async function next() {
    const found = { ...validateStep(step, state), ...(step === 3 ? validateStep(4, state) : {}) };
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setNote(null);
    setSaving(true);
    // Saving is best effort: a failed save never blocks the plan.
    if (profile !== null) {
      try {
        const answers = answersForStep(step, state);
        if (Object.keys(answers).length > 0) await saveAnswers.mutateAsync(answers);
        if (writable)
          await setSetup.mutateAsync({ status: 'in_progress', step: savedStep(step + 1) });
      } catch {
        setNote(SAVE_NOTE);
      }
    }
    setSaving(false);
    go(step + 1);
  }

  async function skip() {
    if (userId) markFirstRunSkipped(userId);
    if (writable) {
      try {
        await setSetup.mutateAsync({ status: 'dismissed', step: savedStep(step) });
      } catch {
        // The browser remembers the skip.
      }
    }
    void navigate('/');
  }

  function started(planId: string) {
    select(planId);
    if (userId) markWelcomeSeen(userId);
    if (writable) setSetup.mutate({ status: 'completed', step: 'done' });
    void navigate('/');
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1>Let’s build your plan</h1>
        <p id={progressLabel} className="font-bold tabular-nums">
          Step {step} of {LAST_STEP}: {FIRST_RUN_STEPS[step - 1]!.title}
        </p>
        <ProgressBar value={step} max={LAST_STEP} labelledBy={progressLabel} />
      </div>

      <section aria-labelledby="first-run-heading" className="space-y-5">
        <h2 id="first-run-heading" ref={heading} tabIndex={-1}>
          {FIRST_RUN_STEPS[step - 1]!.title}
        </h2>

        {step === 1 ? (
          <>
            <TargetStep state={state} errors={errors} onChange={change} />
            <RoleDiscovery state={state} onChange={change} />
          </>
        ) : null}

        {step === 2 ? (
          <SkillsStep
            state={state}
            prefill={prefill}
            onChange={change}
            intro={
              <>
                <p>
                  Be honest: the plan only adds what is missing. Your levels are kept with the plan
                  as your starting point, and the app only ever suggests changing them.
                </p>
                {profile !== null ? <CvPrefill /> : null}
              </>
            }
          />
        ) : null}

        {step === 3 ? (
          <>
            <TimeStep state={state} errors={errors} onChange={change} />
            <section
              aria-labelledby="money-heading"
              className="space-y-4 border-t border-border pt-6"
            >
              <h3 id="money-heading" className="text-lg font-bold">
                Money
              </h3>
              <BudgetStep part="money" state={state} errors={errors} onChange={change} />
            </section>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <details className="rounded-md border border-border p-4">
              <summary className="flex min-h-11 cursor-pointer items-center font-bold">
                Certificates and interview practice (optional)
              </summary>
              <div className="pt-3">
                <BudgetStep part="extras" state={state} errors={errors} onChange={change} />
              </div>
            </details>
            <DraftStep
              state={state}
              onChange={change}
              query={preview}
              lastGood={lastGood}
              updating={updating}
              blocker={null}
            />
          </>
        ) : null}
      </section>

      <div role="status" aria-live="polite">
        {note ? <ErrorText>{note}</ErrorText> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        {step > 1 ? (
          <Button disabled={saving} onClick={() => go(step - 1)}>
            Back
          </Button>
        ) : null}
        {step < LAST_STEP ? (
          <Button variant="primary" disabled={saving} onClick={() => void next()}>
            Next
          </Button>
        ) : (
          <StartPlan
            request={settled}
            draftHash={draft?.draftHash ?? null}
            canStart={
              !!draft && !updating && !preview.isError && draft.items.length > 0 && request !== null
            }
            plans={plans}
            plansLoading={plansQuery.isPending}
            refetchPlans={async () => (await plansQuery.refetch()).data?.plans ?? null}
            refreshDraft={() => void preview.refetch()}
            onStarted={started}
          />
        )}
        <Button variant="secondary" disabled={saving} onClick={() => void skip()}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}
