import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useAiUsage } from '../../api/ai-hooks';
import type { ProfileView } from '../../api/client';
import {
  PREVIEW_DEBOUNCE_MS,
  useBuildPreview,
  useLastGood,
  useDebounced,
} from '../../api/plan-builder-hooks';
import { useProfile } from '../../api/profile-hooks';
import { Loading, ServerProblem } from '../../components/status';
import { Button, linkClass, ProgressBar } from '../../components/ui';
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
} from './builder-model';
import { BudgetStep } from './BudgetStep';
import { DraftStep } from './DraftStep';
import { SkillsStep } from './SkillsStep';
import { StartPlan } from './StartPlan';
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
  const lastGood = useLastGood(preview);

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
            lastGood={lastGood}
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
