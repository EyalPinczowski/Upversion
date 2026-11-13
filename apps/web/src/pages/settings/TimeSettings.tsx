import { WEEKDAY_NAMES } from '@upversion/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { DayOverride, PlanDetail, WeekPattern } from '../../api/client';
import { usePlan, usePreviewSchedule, useSaveTimeSettings } from '../../api/hooks';
import type { TimeSettingsChange } from '../../api/hooks';
import { QueryView } from '../../components/QueryView';
import { Button, ErrorText, TextField } from '../../components/ui';
import { formatDate, formatHours } from '../../lib/format';
import { describeError } from '../../lib/messages';
import { PlanGate } from '../../plan/PlanGate';
import { StartDate } from './StartDate';
import {
  diffTimeSettings,
  draftFromPattern,
  isEmptyChange,
  patternFromDraft,
  previewRequest,
  type PatternDraft,
} from './time-draft';

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: the plan's own zone is still offered.
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

const inputClass = 'min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text';

function OverrideRow({ override, onRemove }: { override: DayOverride; onRemove: () => void }) {
  const text = !override.isStudyDay
    ? 'Day off'
    : override.capacityHours !== undefined
      ? `Study day, ${formatHours(override.capacityHours)}`
      : 'Study day';
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border py-1">
      <span className="grow">
        <strong>{formatDate(override.date, 'short')}</strong>: {text}
      </span>
      <Button onClick={onRemove}>
        Remove{' '}
        <span className="sr-only">the exception for {formatDate(override.date, 'short')}</span>
      </Button>
    </li>
  );
}

function AddOverride({ onAdd }: { onAdd: (override: DayOverride) => void }) {
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'study' | 'off'>('off');
  const [hours, setHours] = useState('');
  const [error, setError] = useState<string | null>(null);
  const kindId = useId();

  function add() {
    if (date === '') return setError('Choose a date first.');
    let capacityHours: number | undefined;
    if (kind === 'study' && hours.trim() !== '') {
      capacityHours = Number(hours);
      if (!Number.isFinite(capacityHours)) return setError('Enter the hours as a number.');
    }
    setError(null);
    onAdd({
      date,
      isStudyDay: kind === 'study',
      ...(capacityHours !== undefined ? { capacityHours } : {}),
    });
    setDate('');
    setHours('');
  }

  return (
    <fieldset className="space-y-3">
      <legend className="font-bold">Add an exception for one day</legend>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <div className="space-y-1">
          <label htmlFor={kindId} className="block font-bold">
            That day is
          </label>
          <select
            id={kindId}
            value={kind}
            onChange={(event) => setKind(event.target.value as 'study' | 'off')}
            className={inputClass}
          >
            <option value="off">A day off</option>
            <option value="study">A study day</option>
          </select>
        </div>
        {kind === 'study' ? (
          <TextField
            label="Hours (optional)"
            type="number"
            inputMode="decimal"
            step="0.25"
            min="0"
            max="24"
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        ) : null}
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button onClick={add}>Add exception</Button>
    </fieldset>
  );
}

function Form({
  planId,
  pattern,
  overrides,
  onSaved,
}: {
  planId: string;
  pattern: WeekPattern;
  overrides: DayOverride[];
  onSaved: () => void;
}) {
  const preview = usePreviewSchedule(planId);
  const save = useSaveTimeSettings(planId);
  const [draft, setDraft] = useState<PatternDraft>(() => draftFromPattern(pattern));
  const [draftOverrides, setDraftOverrides] = useState<DayOverride[]>(overrides);
  const [formError, setFormError] = useState<string | null>(null);
  // The change the person is looking at. Only Approve saves it.
  const [proposal, setProposal] = useState<{ change: TimeSettingsChange; text: string } | null>(
    null,
  );

  /** Any edit makes an earlier preview stale, so it is dropped. */
  function edit(apply: () => void) {
    apply();
    setProposal(null);
    setFormError(null);
    preview.reset();
    save.reset();
  }
  const set = <K extends keyof PatternDraft>(key: K, value: PatternDraft[K]) =>
    edit(() => setDraft((d) => ({ ...d, [key]: value })));

  const zones = timeZones(draft.timezone);

  function onPreview(event: FormEvent) {
    event.preventDefault();
    const built = patternFromDraft(draft);
    if ('error' in built) return setFormError(built.error);
    const change = diffTimeSettings(
      { pattern, overrides },
      { pattern: built.pattern, overrides: draftOverrides },
    );
    if (isEmptyChange(change)) return setFormError('Nothing has changed yet.');
    setFormError(null);
    setProposal(null);
    preview.mutate(previewRequest(change), {
      onSuccess: (result) => setProposal({ change, text: result.summary.text }),
    });
  }

  return (
    <form onSubmit={onPreview} noValidate className="space-y-5">
      <fieldset className="space-y-1">
        <legend className="font-bold">Study days</legend>
        <div className="flex flex-wrap gap-x-4">
          {WEEKDAY_NAMES.map((name, day) => (
            <label key={name} className="inline-flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                className="size-5"
                checked={draft.weekdays.includes(day)}
                onChange={(event) =>
                  set(
                    'weekdays',
                    event.target.checked
                      ? [...draft.weekdays, day]
                      : draft.weekdays.filter((d) => d !== day),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Hours per study day"
          type="number"
          inputMode="decimal"
          step="0.25"
          min="0"
          max="24"
          value={draft.defaultHours}
          onChange={(event) => set('defaultHours', event.target.value)}
        />
        <div className="space-y-1">
          <label htmlFor="time-zone" className="block font-bold">
            Time zone
          </label>
          <select
            id="time-zone"
            value={draft.timezone}
            onChange={(event) => set('timezone', event.target.value)}
            className={inputClass}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="Study window starts"
          type="time"
          value={draft.windowStart}
          onChange={(event) => set('windowStart', event.target.value)}
        />
        <TextField
          label="Study window ends"
          type="time"
          value={draft.windowEnd}
          onChange={(event) => set('windowEnd', event.target.value)}
        />
        <TextField
          label="Lunch starts (optional)"
          type="time"
          value={draft.lunchStart}
          onChange={(event) => set('lunchStart', event.target.value)}
        />
        <TextField
          label="Lunch ends (optional)"
          type="time"
          value={draft.lunchEnd}
          onChange={(event) => set('lunchEnd', event.target.value)}
        />
        <TextField
          label="Break every (hours)"
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
          value={draft.breakEveryHours}
          onChange={(event) => set('breakEveryHours', event.target.value)}
        />
        <TextField
          label="Break length (minutes)"
          type="number"
          inputMode="numeric"
          min="0"
          value={draft.breakMinutes}
          onChange={(event) => set('breakMinutes', event.target.value)}
        />
        <TextField
          label="Shortest block (minutes)"
          type="number"
          inputMode="numeric"
          min="5"
          value={draft.minBlockMinutes}
          onChange={(event) => set('minBlockMinutes', event.target.value)}
        />
      </div>

      {draft.weekdays.length > 0 ? (
        <fieldset className="space-y-3">
          <legend className="font-bold">Hours on specific days (optional)</legend>
          <p className="text-muted">
            Leave a day empty to use “Hours per study day” ({draft.defaultHours.trim() || '…'}).
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {[...draft.weekdays]
              .sort((a, b) => a - b)
              .map((day) => (
                <TextField
                  key={day}
                  label={`${WEEKDAY_NAMES[day]} hours`}
                  type="number"
                  inputMode="decimal"
                  step="0.25"
                  min="0"
                  max="24"
                  placeholder={draft.defaultHours}
                  value={draft.hoursByWeekday[day] ?? ''}
                  onChange={(event) =>
                    set('hoursByWeekday', { ...draft.hoursByWeekday, [day]: event.target.value })
                  }
                />
              ))}
          </div>
        </fieldset>
      ) : null}

      <div className="space-y-3">
        <h4 className="font-bold">Exceptions for single days</h4>
        {draftOverrides.length === 0 ? (
          <p className="text-muted">None. Every day follows the weekly pattern.</p>
        ) : (
          <ul>
            {[...draftOverrides]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((override) => (
                <OverrideRow
                  key={override.date}
                  override={override}
                  onRemove={() =>
                    edit(() =>
                      setDraftOverrides((list) => list.filter((o) => o.date !== override.date)),
                    )
                  }
                />
              ))}
          </ul>
        )}
        <AddOverride
          onAdd={(added) =>
            edit(() =>
              setDraftOverrides((list) => [...list.filter((o) => o.date !== added.date), added]),
            )
          }
        />
      </div>

      {formError ? <ErrorText>{formError}</ErrorText> : null}
      {preview.isError ? (
        <ErrorText>{describeError(preview.error, 'The change could not be checked.')}</ErrorText>
      ) : null}

      {proposal ? null : (
        <Button type="submit" variant="primary" disabled={preview.isPending}>
          {preview.isPending ? 'Checking…' : 'Preview the change'}
        </Button>
      )}

      <div aria-live="polite">
        {proposal ? (
          <div className="space-y-3 border-l-4 border-accent bg-accent-soft p-4 text-accent-soft-text">
            <h4 className="font-bold">What this would change</h4>
            <p role="status">{proposal.text}</p>
            <p>Nothing is saved until you approve.</p>
            {save.isError ? (
              <ErrorText>{describeError(save.error, 'The change could not be saved.')}</ErrorText>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() => save.mutate(proposal.change, { onSuccess: onSaved })}
              >
                {save.isPending ? 'Saving…' : 'Approve'}
              </Button>
              <Button
                disabled={save.isPending}
                onClick={() => {
                  setProposal(null);
                  preview.reset();
                  save.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </form>
  );
}

function Loaded({ plan, onSaved }: { plan: PlanDetail; onSaved: () => void }) {
  if (!plan.weekPattern) {
    return <p className="text-muted">This plan has no weekly time settings yet.</p>;
  }
  return (
    <Form
      planId={plan.id}
      pattern={plan.weekPattern}
      overrides={plan.overrides}
      onSaved={onSaved}
    />
  );
}

function Editor({ planId }: { planId: string }) {
  const plan = usePlan(planId);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  // The form is rebuilt after a save, which drops focus; the message takes it.
  const savedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (saved) savedRef.current?.focus();
  }, [saved, version]);
  return (
    <QueryView query={plan} label="Loading your time settings…">
      {(data) => (
        <div className="space-y-3">
          <div ref={savedRef} tabIndex={-1} aria-live="polite">
            {saved ? (
              <p className="font-bold text-ok">Saved. Your schedule now uses the new settings.</p>
            ) : null}
          </div>
          <Loaded
            key={version}
            plan={data}
            onSaved={() => {
              setSaved(true);
              setVersion((v) => v + 1);
            }}
          />
          <StartDate plan={data} />
        </div>
      )}
    </QueryView>
  );
}

/** When you study: the weekly pattern and single-day exceptions. Every change is previewed first. */
export function TimeSettings() {
  return (
    <section
      aria-labelledby="time-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id="time-heading">Study time</h3>
      <PlanGate
        banner={false}
        empty={<p className="text-muted">Import a plan from Today to set when you study.</p>}
      >
        {(plan) =>
          plan.status === 'archived' ? (
            <p className="text-muted">
              This plan is archived (read-only), so its study time can’t be changed.
            </p>
          ) : (
            <Editor key={plan.id} planId={plan.id} />
          )
        }
      </PlanGate>
    </section>
  );
}
