import {
  buildCvTailorPrompt,
  CATALOG_TAXONOMY,
  findCvPii,
  keywordGaps,
  knownIdentifiersFor,
  MAX_CV_TAILOR_CV,
  MAX_CV_TAILOR_JOB,
  MIN_CV_TAILOR_JOB,
  prepareCvForAi,
  prepareJobForAi,
  type KeywordGapItem,
  type PreparedText,
} from '@upversion/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useAiUsage, useCvTailor, type CvTailorResult } from '../../api/ai-hooks';
import { useMe } from '../../api/hooks';
import { cvTextSession } from '../../cv/cv-text-session';
import { Loading, ServerProblem } from '../../components/status';
import { Button, ErrorText, linkClass, TextAreaField } from '../../components/ui';
import { CvStep } from '../setup/CvStep';
import { HighlightedText } from './HighlightedText';
import {
  aiAvailable,
  CHECK_LINE,
  countPlaceholders,
  lengthProblems,
  NAME_WARNING,
  piiMessages,
  tailorProblem,
  tailorProviders,
  type TailorProblem,
} from './tailor-model';

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_TITLES: Record<Step, string> = {
  1: 'Your CV',
  2: 'The job',
  3: 'Keyword list',
  4: 'Preview and send',
  5: 'Result',
};

const ROLES = [...CATALOG_TAXONOMY.roles].sort((a, b) => a.title.localeCompare(b.title));

interface Sent {
  result: CvTailorResult;
  cv: string;
}

function KeywordList({
  title,
  items,
  empty,
}: {
  title: string;
  items: KeywordGapItem[];
  empty: string;
}) {
  return (
    <div className="space-y-1">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((i) => (
            <li key={i.skillId} className="rounded-sm border border-border bg-surface-2 px-2 py-1">
              {i.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Counter({
  id,
  value,
  max,
  min,
}: {
  id: string;
  value: number;
  max: number;
  min?: number;
}) {
  const over = value > max;
  const under = min !== undefined && value < min;
  return (
    <p id={id} className={`tabular-nums ${over ? 'font-bold text-warn' : 'text-muted'}`}>
      {value.toLocaleString('en')} of {max.toLocaleString('en')} characters
      {over ? ' (too long)' : under ? ` (at least ${min})` : ''}
    </p>
  );
}

function Tailor({ identifiers }: { identifiers: string[] }) {
  const usage = useAiUsage();
  const tailor = useCvTailor();
  const ids = useId();
  const [step, setStep] = useState<Step>(1);
  // The only copies of the texts: component state, gone when the page closes. Never storage.
  const [cvRaw, setCvRaw] = useState('');
  const [jobRaw, setJobRaw] = useState('');
  const [roleId, setRoleId] = useState('');
  const [cvEdit, setCvEdit] = useState('');
  const [jobEdit, setJobEdit] = useState('');
  const [prep, setPrep] = useState<{ cv: PreparedText; job: PreparedText } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<TailorProblem | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [fromTab, setFromTab] = useState(() => cvTextSession.has());
  const sending = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const u = usage.data!;
  const aiOn = aiAvailable(u);
  const providers = tailorProviders(u);
  const cap = u.user.cvTailor.cap;
  const role = ROLES.find((r) => r.id === roleId);

  const gaps = useMemo(
    () => (step === 3 ? keywordGaps(cvRaw, jobRaw, { roleId: roleId || undefined }) : null),
    [step, cvRaw, jobRaw, roleId],
  );

  const options = useMemo(() => ({ knownIdentifiers: identifiers }), [identifiers]);
  const piiKinds = useMemo(
    () => [...new Set([...findCvPii(cvEdit, options), ...findCvPii(jobEdit, options)])],
    [cvEdit, jobEdit, options],
  );
  const lengths = lengthProblems(cvEdit, jobEdit);
  const reasons = [
    ...piiMessages(piiKinds),
    ...lengths,
    ...(confirmed ? [] : ['Tick “I removed my name and address”.']),
  ];
  const textOk = piiKinds.length === 0 && lengths.length === 0 && confirmed;

  function go(next: Step) {
    setNote(null);
    setManual(null);
    setStep(next);
  }

  function takeCv(text: string) {
    setCvRaw(text);
    go(2);
  }

  function toPreview() {
    const cv = prepareCvForAi(cvRaw, options);
    const job = prepareJobForAi(jobRaw, options);
    setPrep({ cv, job });
    setCvEdit(cv.text);
    setJobEdit(job.text);
    setConfirmed(false);
    setProblem(null);
    go(4);
  }

  function startAgain() {
    setCvRaw('');
    setJobRaw('');
    setRoleId('');
    setCvEdit('');
    setJobEdit('');
    setPrep(null);
    setSent(null);
    setProblem(null);
    setConfirmed(false);
    go(1);
  }

  function forgetCv() {
    cvTextSession.clear();
    setFromTab(false);
    setNote('CV text removed from this tab');
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      setManual(null);
      setNote(done);
    } catch {
      setNote('We could not copy automatically. Select the text below and copy it yourself.');
      setManual(text);
    }
  }

  async function copyPrompt() {
    if (!textOk) return;
    try {
      const p = buildCvTailorPrompt({ cvText: cvEdit, jobText: jobEdit, targetRole: role?.title });
      await copy(
        `${p.system}\n\n${p.user}`,
        'Prompt copied. Nothing was sent. Paste it into your own AI assistant.',
      );
    } catch {
      setNote('The prompt could not be built from this text. Check the length and the text.');
    }
  }

  async function send() {
    if (!textOk || !aiOn || sending.current) return;
    sending.current = true;
    setProblem(null);
    const before = usage.data?.user.cvTailor.used ?? 0;
    try {
      const result = await tailor.mutateAsync({
        cvText: cvEdit.trim(),
        jobText: jobEdit.trim(),
        ...(roleId ? { roleId } : {}),
      });
      setSent({ result, cv: cvEdit });
      go(5);
    } catch (error) {
      let rose = false;
      let resetsAt: string | undefined;
      let used: number | undefined;
      try {
        const after = await usage.refetch();
        used = after.data?.user.cvTailor.used;
        rose = (used ?? 0) > before;
        resetsAt = after.data?.resetsAt;
      } catch {
        // The count is unknown: the message then claims nothing about what was sent.
      }
      setProblem(tailorProblem(error, { countRose: rose, cap, used, resetsAt }));
    } finally {
      sending.current = false;
    }
  }

  const keywordText = (g: NonNullable<typeof gaps>) =>
    [
      `In the job post and your CV: ${g.matched.map((i) => i.name).join(', ') || 'none'}`,
      `In the job post, not in your CV: ${g.missing.map((i) => i.name).join(', ') || 'none'}`,
    ].join('\n');

  const placeholders = sent ? countPlaceholders(sent.result.text) : 0;
  const tabLabelCv = `${ids}-cv`;
  const tabLabelJob = `${ids}-job`;

  return (
    <div className="space-y-6">
      <h1>Tailor my CV to a job</h1>
      <div className="space-y-1">
        <p className="font-bold">Step {step} of 5</p>
        <progress max={5} value={step} aria-label="Progress" className="block h-3 w-full" />
      </div>

      <section aria-labelledby={`${ids}-h`} className="space-y-5">
        <h2 id={`${ids}-h`} ref={headingRef} tabIndex={-1}>
          {STEP_TITLES[step]}
        </h2>

        {step === 1 ? (
          <div className="space-y-4">
            {fromTab ? (
              <div className="space-y-2">
                <p>You kept your CV text in this tab’s memory.</p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="primary"
                    onClick={() => {
                      const t = cvTextSession.get();
                      if (t) takeCv(t);
                    }}
                  >
                    Use the CV text from this tab
                  </Button>
                  <Button onClick={forgetCv}>Forget my CV text</Button>
                </div>
              </div>
            ) : null}
            {note ? <p role="status">{note}</p> : null}
            <CvStep
              onText={takeCv}
              onSkip={() => window.history.back()}
              skipLabel="Cancel"
              intro="The file is read on this device only. Nothing leaves this device until you have seen the exact text on step 4 and pressed Send to AI. Nothing is saved."
              pasteHint="Keep the line breaks. Nothing you paste is saved. It is sent only if you press Send to AI on step 4."
            />
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-muted">
              Your CV: {cvRaw.trim().length.toLocaleString('en')} characters read.
              {cvRaw.trim().length > MAX_CV_TAILOR_CV
                ? ` The AI step takes at most ${MAX_CV_TAILOR_CV.toLocaleString('en')}; you can shorten it on step 4.`
                : ''}
            </p>
            <div className="space-y-1">
              <TextAreaField
                label="The job post"
                hint="Paste the requirements part if it is longer."
                rows={10}
                dir="auto"
                value={jobRaw}
                onChange={(e) => setJobRaw(e.target.value)}
                aria-describedby={`${tabLabelJob}-count`}
                autoComplete="off"
                spellCheck={false}
              />
              <Counter
                id={`${tabLabelJob}-count`}
                value={jobRaw.trim().length}
                max={MAX_CV_TAILOR_JOB}
                min={MIN_CV_TAILOR_JOB}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${ids}-role`} className="block font-bold">
                Target role (optional)
              </label>
              <select
                id={`${ids}-role`}
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                className="min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text"
              >
                <option value="">No target role</option>
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => go(1)}>Back</Button>
              <Button
                variant="primary"
                disabled={
                  jobRaw.trim().length < MIN_CV_TAILOR_JOB ||
                  jobRaw.trim().length > MAX_CV_TAILOR_JOB
                }
                aria-describedby={`${tabLabelJob}-count`}
                onClick={() => go(3)}
              >
                Next: keyword list
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 && gaps ? (
          <div className="space-y-5">
            <p>
              Computed on this device from the job post and your CV. No AI and no request. The post
              mentions these and your CV doesn’t: if you have them, add them in your own words.
            </p>
            <KeywordList
              title="In the post and in your CV"
              items={gaps.matched}
              empty="None found."
            />
            <KeywordList
              title="In the post, not in your CV"
              items={gaps.missing}
              empty="No gaps found."
            />
            <KeywordList title="In your CV only" items={gaps.cvOnly} empty="None." />
            {note ? <p role="status">{note}</p> : null}
            {!aiOn ? (
              <p role="status">
                AI is not available right now. Your keyword list still works, and you can copy a
                prompt for your own assistant.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => go(2)}>Back</Button>
              <Button onClick={() => void copy(keywordText(gaps), 'Keyword list copied.')}>
                Copy list
              </Button>
              <Button onClick={toPreview}>Copy prompt</Button>
              {aiOn ? (
                <Button variant="primary" onClick={toPreview}>
                  Next: write a tailored version with AI
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 4 && prep ? (
          <div className="space-y-5">
            <p className="font-bold">{NAME_WARNING}</p>
            <p className="text-muted">
              Numeric dates such as 03/2018 may be removed; write them as Mar 2018 to keep them.
            </p>
            {prep.cv.dropped.length > 0 ? (
              <details>
                <summary className="min-h-11 cursor-pointer font-bold">
                  Removed before sending ({prep.cv.dropped.length} lines)
                </summary>
                <ul className="space-y-1 pt-2 text-muted">
                  {prep.cv.dropped.map((l, i) => (
                    <li key={i} dir="auto">
                      {l}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p className="text-muted">
              Personal details replaced by [removed]: {prep.cv.removed + prep.job.removed}.
            </p>
            <div className="space-y-1">
              <TextAreaField
                label="Your CV, as it will be sent"
                rows={14}
                dir="auto"
                value={cvEdit}
                onChange={(e) => setCvEdit(e.target.value)}
                aria-describedby={`${tabLabelCv}-count`}
                autoComplete="off"
                spellCheck={false}
              />
              <Counter
                id={`${tabLabelCv}-count`}
                value={cvEdit.trim().length}
                max={MAX_CV_TAILOR_CV}
                min={200}
              />
            </div>
            <div className="space-y-1">
              <TextAreaField
                label="The job post, as it will be sent"
                rows={8}
                dir="auto"
                value={jobEdit}
                onChange={(e) => setJobEdit(e.target.value)}
                aria-describedby={`${tabLabelJob}-count2`}
                autoComplete="off"
                spellCheck={false}
              />
              <Counter
                id={`${tabLabelJob}-count2`}
                value={jobEdit.trim().length}
                max={MAX_CV_TAILOR_JOB}
                min={MIN_CV_TAILOR_JOB}
              />
            </div>

            {piiKinds.length > 0 ? (
              <div role="alert" className="space-y-1 font-bold text-warn">
                {piiMessages(piiKinds).map((m) => (
                  <p key={m}>{m}</p>
                ))}
              </div>
            ) : null}

            <label className="flex min-h-11 items-center gap-3 font-bold">
              <input
                type="checkbox"
                className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I removed my name and address
            </label>

            <div className="space-y-1">
              <h3>Who receives the text</h3>
              <p>
                Send to AI sends exactly the two texts above to{' '}
                <strong>{providers[0]!.label}</strong>. If that fails, it may then also go to{' '}
                <strong>{providers[1]!.label}</strong> as a backup. No other provider is used. Copy
                prompt sends nothing: where you paste it is your choice and your own assistant’s
                terms.
              </p>
              <p className="text-muted">
                Tailoring runs today: {u.user.cvTailor.used} of {cap} used.
              </p>
            </div>

            {!textOk ? (
              <p id={`${ids}-why`} className="font-bold">
                Not ready: {reasons.join(' ')}
              </p>
            ) : null}
            {!aiOn ? (
              <p role="status">AI is not available right now, so Send to AI is off.</p>
            ) : null}
            {tailor.isPending ? <p role="status">Sending… this can take up to a minute.</p> : null}
            {problem ? <ErrorText>{problem.message}</ErrorText> : null}
            {note ? <p role="status">{note}</p> : null}
            {manual ? (
              <TextAreaField label="Prompt to copy" readOnly rows={8} dir="auto" value={manual} />
            ) : null}

            <div className="flex flex-wrap gap-3">
              <Button onClick={() => go(3)} disabled={tailor.isPending}>
                Back
              </Button>
              <Button
                disabled={!textOk}
                aria-describedby={!textOk ? `${ids}-why` : undefined}
                onClick={() => void copyPrompt()}
              >
                Copy prompt
              </Button>
              <Button
                variant="primary"
                disabled={!textOk || !aiOn || tailor.isPending}
                aria-describedby={!textOk ? `${ids}-why` : undefined}
                onClick={() => void send()}
              >
                Send to AI
              </Button>
            </div>
          </div>
        ) : null}

        {step === 5 && sent ? (
          <div className="space-y-5">
            <p className="font-bold">{CHECK_LINE}</p>
            <p>
              The text was sent to:{' '}
              {sent.result.providers.map((p) => p.label).join(', ') || 'no provider reported'}.
            </p>
            <p className="text-muted">
              Tailoring runs today: {sent.result.usage.used} of {sent.result.usage.cap} used.
            </p>
            {placeholders > 0 ? (
              <p role="alert" className="font-bold text-warn">
                {placeholders} {PLACEHOLDER_WORD(placeholders)} still need a real number. Replace
                each one with a true number or delete the line before you use this text.
              </p>
            ) : null}
            <div className="grid gap-5 lg:grid-cols-2">
              <section aria-labelledby={`${ids}-res`} className="space-y-2">
                <h3 id={`${ids}-res`}>Tailored text</h3>
                <HighlightedText
                  text={sent.result.text}
                  flags={sent.result.flags.map((f) => f.text)}
                />
              </section>
              <section aria-labelledby={`${ids}-sent`} className="space-y-2">
                <h3 id={`${ids}-sent`}>The text that was sent</h3>
                <p dir="auto" className="whitespace-pre-wrap break-words text-muted">
                  {sent.cv}
                </p>
              </section>
            </div>
            <section aria-labelledby={`${ids}-notes`} className="space-y-2">
              <h3 id={`${ids}-notes`}>Notes</h3>
              {sent.result.notes.length === 0 ? (
                <p className="text-muted">No notes.</p>
              ) : (
                <ul className="space-y-1">
                  {[...sent.result.notes]
                    .sort(
                      (a, b) =>
                        Number(!a.kind.startsWith('check')) - Number(!b.kind.startsWith('check')),
                    )
                    .map((n, i) => (
                      <li key={i} dir="auto">
                        <strong>{NOTE_LABEL[n.kind]}:</strong> {n.text}
                      </li>
                    ))}
                </ul>
              )}
            </section>
            {note ? <p role="status">{note}</p> : null}
            {manual ? (
              <TextAreaField label="Text to copy" readOnly rows={8} dir="auto" value={manual} />
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => go(3)}>Back to keyword list</Button>
              <Button
                variant="primary"
                onClick={() =>
                  void copy(
                    sent.result.text,
                    placeholders > 0
                      ? `Text copied. ${placeholders} ${PLACEHOLDER_WORD(placeholders)} still need a real number.`
                      : 'Text copied.',
                  )
                }
              >
                {placeholders > 0 ? 'Copy text anyway' : 'Copy text'}
              </Button>
              <Button onClick={startAgain}>Start again</Button>
              <Button onClick={forgetCv}>Forget my CV text</Button>
            </div>
          </div>
        ) : null}
      </section>
      <Link to="/settings" className={linkClass}>
        Back to Settings
      </Link>
    </div>
  );
}

const PLACEHOLDER_WORD = (n: number) =>
  n === 1 ? '[number?] placeholder' : '[number?] placeholders';

const NOTE_LABEL: Record<CvTailorResult['notes'][number]['kind'], string> = {
  output_redacted: 'Removed',
  check_number: 'Check number',
  check_skill: 'Check skill',
  check_term: 'Check term',
  missing_keyword: 'Missing keyword',
  matched_keyword: 'Matched keyword',
  model_note: 'AI note',
};

/** Settings > Tailor my CV (ADR 016 WP-G2). Does not exist when the server flag is off. */
export function TailorCvPage() {
  const usage = useAiUsage();
  const me = useMe();
  const identifiers = useMemo(
    () =>
      me.data
        ? knownIdentifiersFor({ email: me.data.email, displayName: me.data.displayName })
        : [],
    [me.data],
  );
  if (usage.data && !usage.data.features.cvTailor) return <Navigate to="/settings" replace />;
  const failed = usage.isError ? usage : me.isError ? me : null;
  if (failed) return <ServerProblem error={failed.error} onRetry={() => void failed.refetch()} />;
  if (!usage.data || !me.data) return <Loading label="Loading…" />;
  return <Tailor identifiers={identifiers} />;
}
