import {
  extractProfileFromText,
  setupQuestions,
  validateAnswer,
  type CvExtraction,
  type ProfileImport,
  type SetupQuestion,
} from '@upversion/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { ProfileView } from '../../api/client';
import { useProfile, useImportProfile, useSaveAnswers, useSetSetup } from '../../api/profile-hooks';
import { Loading, ServerProblem } from '../../components/status';
import { Button, ErrorText, ProgressBar } from '../../components/ui';
import { CalendarStep } from './CalendarStep';
import { CvReviewStep } from './CvReviewStep';
import { CvStep } from './CvStep';
import { BuildPlanLink } from '../../plan/BuildPlanLink';
import { DoneStep } from './DoneStep';
import { isAnswered } from './question-model';
import { QuestionStep } from './QuestionStep';

/**
 * The step ids as saved in `setup_step` (at most 40 characters): `welcome`, `q:<question id>`,
 * `cv`, `calendar`, `done`. `review` is never saved: the CV text only lives in memory, so after a
 * reload the person is back at `cv`.
 */
type Step = string;
const WELCOME = 'welcome';
const CV = 'cv';
const REVIEW = 'review';
const CALENDAR = 'calendar';
const DONE = 'done';
const questionStep = (q: SetupQuestion) => `q:${q.id}`;

const SAVE_ERROR = 'We couldn’t save that. Check your connection and try again.';

function initialStep(profile: ProfileView, questions: SetupQuestion[]): Step {
  if (profile.setupStatus !== 'in_progress' || !profile.setupStep) return WELCOME;
  const saved = profile.setupStep;
  if (saved === REVIEW) return CV;
  if (saved === CV || saved === CALENDAR) return saved;
  if (questions.some((q) => questionStep(q) === saved)) return saved;
  return WELCOME;
}

function initialAnswers(profile: ProfileView, questions: SetupQuestion[]) {
  const out: Record<string, unknown> = {};
  // A default is a pre-filled choice the person can keep or change; it is saved with Next.
  for (const q of questions) if (q.default !== undefined) out[q.id] = q.default;
  return { ...out, ...profile.answers };
}

function Wizard({ profile }: { profile: ProfileView }) {
  const navigate = useNavigate();
  const questions = useMemo(() => setupQuestions(), []);
  const [step, setStep] = useState<Step>(() => initialStep(profile, questions));
  const [answers, setAnswers] = useState(() => initialAnswers(profile, questions));
  const [extraction, setExtraction] = useState<CvExtraction | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveAnswers = useSaveAnswers();
  const importProfile = useImportProfile();
  const setSetup = useSetSetup();
  const busy = saveAnswers.isPending || importProfile.isPending || setSetup.isPending;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const progressId = useId();
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const index = questions.findIndex((q) => questionStep(q) === step);
  const question = index >= 0 ? questions[index]! : null;

  /** Saves the new step on the server, then shows it. Stays put with a message when saving fails. */
  async function go(next: Step, status: 'in_progress' | 'completed' = 'in_progress') {
    setError(null);
    try {
      await setSetup.mutateAsync({ status, step: next === REVIEW ? CV : next });
      setStep(next);
    } catch {
      setError(SAVE_ERROR);
    }
  }

  async function dismiss() {
    setError(null);
    try {
      await setSetup.mutateAsync({ status: 'dismissed', step: step === REVIEW ? CV : step });
      void navigate('/');
    } catch {
      setError(SAVE_ERROR);
    }
  }

  const afterCv = () => go(CALENDAR);
  const { mutateAsync: setSetupAsync } = setSetup;
  const afterCalendar = useCallback(async () => {
    setError(null);
    try {
      await setSetupAsync({ status: 'completed', step: DONE });
      setStep(DONE);
    } catch {
      setError(SAVE_ERROR);
    }
  }, [setSetupAsync]);

  const finishCalendar = useCallback(() => void afterCalendar(), [afterCalendar]);

  async function next() {
    if (!question) return;
    const value = answers[question.id];
    if (!isAnswered(value)) {
      if (question.required) {
        setError('Choose an answer to continue.');
        return;
      }
      // Unticked everything on a list question that had a saved answer: save the empty list so
      // the old value does not come back. (Single-choice answers cannot be unselected, and the
      // API has no way to delete one answer, so only list questions are cleared.)
      const saved = profile.answers[question.id];
      if (Array.isArray(saved) && saved.length > 0 && Array.isArray(value)) {
        try {
          await saveAnswers.mutateAsync({ [question.id]: [] });
        } catch {
          setError(SAVE_ERROR);
          return;
        }
      }
    } else {
      const checked = validateAnswer(question, value);
      if (!checked.ok) {
        setError('That answer isn’t valid. Choose again.');
        return;
      }
      try {
        await saveAnswers.mutateAsync({ [question.id]: checked.value });
      } catch {
        setError(SAVE_ERROR);
        return;
      }
    }
    if (editing) {
      setEditing(false);
      await go(DONE, 'completed');
    } else await go(index + 1 < questions.length ? questionStep(questions[index + 1]!) : CV);
  }

  function back() {
    setError(null);
    if (editing) {
      setEditing(false);
      setStep(DONE);
    } else if (step === REVIEW) {
      setExtraction(null);
      setStep(CV);
    } else if (step === CALENDAR) setStep(CV);
    else if (step === CV) setStep(questionStep(questions[questions.length - 1]!));
    else if (index > 0) setStep(questionStep(questions[index - 1]!));
    else setStep(WELCOME);
  }

  function readText(text: string) {
    // The matcher runs here, on the device. The text itself is not kept: only the suggestions
    // (with redacted evidence) are held, until this step is left.
    setExtraction(extractProfileFromText(text));
    setError(null);
    setStep(REVIEW);
  }

  async function saveImport(payload: ProfileImport) {
    setError(null);
    try {
      await importProfile.mutateAsync(payload);
    } catch {
      setError(SAVE_ERROR);
      return;
    }
    setExtraction(null);
    await afterCv();
  }

  const calendarCount = 1;
  const total = questions.length + 1 + calendarCount;
  let heading = 'Set up your profile';
  let value = 0;
  if (question) {
    heading = `Question ${index + 1} of ${questions.length}`;
    value = index + 1;
  } else if (step === CV || step === REVIEW) {
    heading = step === REVIEW ? 'Review what we found' : 'Your CV (optional)';
    value = questions.length + 1;
  } else if (step === CALENDAR) {
    heading = 'Calendar (optional)';
    value = total;
  } else if (step === DONE) {
    heading = 'Setup complete';
    value = total;
  }

  const canSkipAll = step !== WELCOME && step !== DONE && !editing;
  const answered = question ? isAnswered(answers[question.id]) : false;

  return (
    <div className="space-y-6">
      <h1>Set up your profile</h1>
      {step !== WELCOME ? (
        <div className="space-y-1">
          <p id={progressId} className="text-muted">
            Step {value} of {total}
          </p>
          <ProgressBar labelledBy={progressId} value={value} max={total} />
        </div>
      ) : null}
      <section aria-labelledby="setup-step-heading" className="space-y-5">
        <h2
          id="setup-step-heading"
          ref={headingRef}
          tabIndex={-1}
          aria-describedby={question ? 'setup-step-question' : undefined}
        >
          {step === WELCOME ? 'Welcome' : heading}
        </h2>
        {/* Read once, with the focused heading: "Question 3 of 8", then the question itself. */}
        {question ? (
          <p id="setup-step-question" className="sr-only">
            {question.text}
          </p>
        ) : null}

        {step === WELCOME ? (
          <div className="space-y-4">
            <p>
              Answer a few questions so your plans fit your life. It takes about 3 minutes. You can
              add your CV to pre-fill your skills (it is read on this device only) and connect your
              calendar. All of it is optional and you can skip it now and come back from Settings.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void go(questionStep(questions[0]!))}
              >
                Start setup
              </Button>
              <Button disabled={busy} onClick={() => void dismiss()}>
                Skip for now
              </Button>
            </div>
          </div>
        ) : null}

        {question ? (
          <div className="space-y-5">
            <QuestionStep
              key={question.id}
              question={question}
              answers={answers}
              error={error}
              onChange={(v) => {
                setError(null);
                setAnswers((prev) => ({ ...prev, [question.id]: v }));
              }}
            />
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy} onClick={back}>
                Back
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void next()}>
                {editing ? 'Save' : answered || question.required ? 'Next' : 'Skip'}
              </Button>
            </div>
          </div>
        ) : null}

        {step === CV ? (
          <>
            <CvStep onText={readText} onSkip={() => void afterCv()} />
            <Button disabled={busy} onClick={back}>
              Back
            </Button>
          </>
        ) : null}

        {step === REVIEW && extraction ? (
          <>
            <CvReviewStep
              extraction={extraction}
              busy={importProfile.isPending || setSetup.isPending}
              error={error}
              onSave={(payload) => void saveImport(payload)}
              onDiscard={() => {
                setExtraction(null);
                void afterCv();
              }}
            />
            <Button disabled={busy} onClick={back}>
              Back
            </Button>
          </>
        ) : null}

        {step === CALENDAR ? (
          <>
            <CalendarStep onNext={finishCalendar} />
            <Button disabled={busy} onClick={back}>
              Back
            </Button>
          </>
        ) : null}

        {step === DONE ? (
          <DoneStep
            entry={<BuildPlanLink variant="primary">Build my first plan</BuildPlanLink>}
            questions={questions}
            answers={answers}
            profile={profile}
            onEdit={(id) => {
              const target = questions.find((q) => q.id === id);
              if (!target) return;
              setEditing(true);
              setStep(questionStep(target));
            }}
          />
        ) : null}

        {error && step !== REVIEW && !question ? <ErrorText>{error}</ErrorText> : null}
        {error && step === CALENDAR ? (
          <Button disabled={busy} onClick={() => void afterCalendar()}>
            Retry
          </Button>
        ) : null}
      </section>

      {canSkipAll ? (
        <div className="border-t border-border pt-4">
          <Button disabled={busy} onClick={() => void dismiss()}>
            Skip setup for now
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The first-time setup wizard (ADR 015). When the profile API is not available (404, flag off)
 * the page does not exist: it sends the person to the app's home page.
 */
export function SetupPage() {
  const profile = useProfile();
  if (profile.data === null) return <Navigate to="/" replace />;
  if (profile.data) return <Wizard profile={profile.data} />;
  if (profile.isError)
    return <ServerProblem error={profile.error} onRetry={() => void profile.refetch()} />;
  return <Loading label="Loading your setup…" />;
}
