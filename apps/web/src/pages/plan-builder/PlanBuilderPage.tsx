import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useAiUsage } from '../../api/ai-hooks';
import type { BuildRequestBody, ProfileView } from '../../api/client';
import { isApiError } from '../../api/errors';
import {
  PREVIEW_DEBOUNCE_MS,
  useBuildPlan,
  useBuildPreview,
  useDebounced,
} from '../../api/plan-builder-hooks';
import { useProfile } from '../../api/profile-hooks';
import { Loading, ServerProblem } from '../../components/status';
import { Button, ErrorText, linkClass, ProgressBar } from '../../components/ui';
import { newId } from '../../lib/messages';
import { dateInZone } from '../../lib/zoned-date';
import { useActivePlan } from '../../plan/context';
import { ArchiveDialog } from './ArchiveDialog';
import {
  browserTimeZone,
  describeBuildError,
  initialState,
  requestKey,
  toRequest,
  validateStep,
  type BuilderState,
  type StepErrors,
} from './builder-model';
import { BudgetStep } from './BudgetStep';
import { DraftStep } from './DraftStep';
import { SkillsStep } from './SkillsStep';
import { TargetStep } from './TargetStep';
import { TimeStep } from './TimeStep';

const STEPS = [
  { title: 'Your target' },
  { title: 'Your skills' },
  { title: 'Your time' },
  { title: 'Budget and certificates' },
  { title: 'Your draft' },
] as const;

/** `/plan/new`: the builder. Shown only while the server has the plan builder on. */
export function PlanBuilderPage() {
  const usage = useAiUsage();
  const profile = useProfile();
  if (usage.isPending) return <Loading label="Loading…" />;
  if (usage.isError)
    return <ServerProblem error={usage.error} onRetry={() => void usage.refetch()} />;
  // The flag is off: the page does not exist for this person.
  if (usage.data.features.planBuilder !== true) return <Navigate to="/plan" replace />;
  if (profile.isPending) return <Loading label="Loading your profile…" />;
  // A missing profile (404, feature off) only means nothing is pre-filled; a failed read is shown.
  if (profile.isError) {
    return <ServerProblem error={profile.error} onRetry={() => void profile.refetch()} />;
  }
  return <Builder profile={profile.data} />;
}

function Builder({ profile }: { profile: ProfileView | null }) {
  const navigate = useNavigate();
  const { plans, query: plansQuery, select } = useActivePlan();
  const [{ state: first, prefill }] = useState(() => {
    const timezone = browserTimeZone();
    const today = dateInZone(Date.now(), timezone) ?? dateInZone(Date.now(), 'UTC')!;
    return initialState(profile, today, timezone);
  });
  const [state, setState] = useState<BuilderState>(first);
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<StepErrors>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const progressLabel = useId();
  const change = (patch: Partial<BuilderState>) => {
    setState((s) => ({ ...s, ...patch }));
    setErrors({});
  };

  // After a step change focus goes to the new step's heading (not on the first render).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) heading.current?.focus();
    mounted.current = true;
  }, [step]);

  function next() {
    const found = validateStep(step, state);
    setErrors(found);
    if (Object.keys(found).length === 0) setStep((n) => Math.min(5, n + 1));
  }

  const request = useMemo(() => toRequest(state, prefill), [state, prefill]);
  const settled = useDebounced(request, PREVIEW_DEBOUNCE_MS);
  const onDraft = step === 5;
  const preview = useBuildPreview(onDraft ? settled : null);
  const updating =
    onDraft &&
    request !== null &&
    (requestKey(request) !== requestKey(settled) ||
      preview.isFetching ||
      preview.isPlaceholderData);

  const blocker =
    onDraft && request === null
      ? 'Some earlier steps are unfinished. Go back and complete them.'
      : null;
  const draft = preview.data;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link to="/plan" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to the plan
        </Link>
        <h1>Build a plan</h1>
        <p id={progressLabel} className="font-bold tabular-nums">
          Step {step} of {STEPS.length}: {STEPS[step - 1]!.title}
        </p>
        <ProgressBar value={step} max={STEPS.length} labelledBy={progressLabel} />
      </div>

      <section aria-labelledby="step-heading" className="space-y-5">
        <h2 id="step-heading" ref={heading} tabIndex={-1}>
          {STEPS[step - 1]!.title}
        </h2>
        {step === 1 ? <TargetStep state={state} errors={errors} onChange={change} /> : null}
        {step === 2 ? <SkillsStep state={state} prefill={prefill} onChange={change} /> : null}
        {step === 3 ? <TimeStep state={state} errors={errors} onChange={change} /> : null}
        {step === 4 ? <BudgetStep state={state} errors={errors} onChange={change} /> : null}
        {step === 5 ? (
          <DraftStep
            state={state}
            onChange={change}
            query={preview}
            updating={updating}
            blocker={blocker}
          />
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        {step > 1 ? <Button onClick={() => setStep((n) => n - 1)}>Back</Button> : null}
        {step < 5 ? (
          <Button variant="primary" onClick={next}>
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
            onStarted={(planId) => {
              select(planId);
              void navigate('/plan');
            }}
          />
        )}
      </div>
    </div>
  );
}

function StartPlan({
  request,
  draftHash,
  canStart,
  plans,
  plansLoading,
  refetchPlans,
  refreshDraft,
  onStarted,
}: {
  request: BuildRequestBody | null;
  draftHash: string | null;
  canStart: boolean;
  plans: ReturnType<typeof useActivePlan>['plans'];
  plansLoading: boolean;
  refetchPlans: () => Promise<ReturnType<typeof useActivePlan>['plans'] | null>;
  refreshDraft: () => void;
  onStarted: (planId: string) => void;
}) {
  const build = useBuildPlan();
  const [dialog, setDialog] = useState<{ notice: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // One id per body: repeating the same body after a lost answer is safe (the server answers with
  // the stored plan); a different body (a new draft, another list of plans) is a different plan.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const active = plans.filter((p) => p.status === 'active');

  useEffect(() => {
    if (problem) statusRef.current?.focus();
  }, [problem]);

  function submit(replacesPlanIds: string[]) {
    if (!request || !draftHash) return;
    const key = JSON.stringify({ request, draftHash, replacesPlanIds });
    if (attempt.current?.key !== key) attempt.current = { key, id: newId() };
    setProblem(null);
    build.mutate(
      { id: attempt.current.id, request, draftHash, replacesPlanIds },
      {
        onSuccess: (plan) => {
          setDialog(null);
          attempt.current = null;
          onStarted(plan.id);
        },
        onError: (error) => void onFailed(error),
      },
    );
  }

  async function onFailed(error: unknown) {
    if (isApiError(error) && error.kind === 'http' && error.status === 409) {
      if (error.code === 'active_plan_changed') {
        const fresh = await refetchPlans();
        const now = (fresh ?? []).filter((p) => p.status === 'active');
        if (now.length > 0) {
          setDialog({
            notice:
              'Your active plans changed in the meantime. Check the names below and confirm again.',
          });
        } else {
          setDialog(null);
          setProblem('Your plans changed in the meantime. Press Start this plan again.');
        }
        return;
      }
      setDialog(null);
      if (error.code === 'draft_changed') {
        setProblem(
          'The catalog or your choices changed since this draft was made. The draft has been refreshed. Check it, then press Start this plan again.',
        );
        refreshDraft();
        return;
      }
      if (error.code === 'conflict') {
        setProblem(
          'A plan with this id was already started with different choices. Go back, check your choices and start again.',
        );
        attempt.current = null;
        return;
      }
    }
    setDialog(null);
    setProblem(
      isApiError(error) && error.kind !== 'http'
        ? 'Can’t reach the server. If your plan was created it will show in your plan list. Press Start this plan again to retry; it will not be created twice.'
        : describeBuildError(error),
    );
  }

  const busy = build.isPending;
  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        disabled={!canStart || plansLoading || busy}
        onClick={() => (active.length > 0 ? setDialog({ notice: null }) : submit([]))}
      >
        {busy && !dialog ? 'Starting…' : 'Start this plan'}
      </Button>
      <div ref={statusRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </div>
      {dialog ? (
        <ArchiveDialog
          plans={active}
          notice={dialog.notice}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => submit(active.map((p) => p.id))}
        />
      ) : null}
    </div>
  );
}
