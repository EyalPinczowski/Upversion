import { useEffect, useRef, useState } from 'react';
import type { DayOverride, Schedule, Task } from '../../api/client';
import { usePlan, usePreviewSchedule, useSaveTimeSettings } from '../../api/hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, ErrorText, TextField } from '../../components/ui';
import { formatHours } from '../../lib/format';
import { describeError } from '../../lib/messages';
import {
  addedMinutes,
  EXTRA_HOUR_CHOICES,
  hasPassedBlock,
  todayCapacity,
  workAheadEffect,
} from './work-ahead';

interface Proposal {
  override: DayOverride;
  /** What the extra time does to the next work, then the engine's own change summary. */
  text: string;
  /** Minutes of study the schedule really gains today (the study window may be the limit). */
  addedMinutes: number;
  /** A new or changed block for today starts before the current time. */
  passed: boolean;
}

const requestedMinutes = (override: DayOverride, currentHours: number) =>
  ((override.capacityHours ?? 0) - currentHours) * 60;

/**
 * "Work ahead": the person adds study hours to today, or makes today a study day. It reuses the
 * day exception (isStudyDay and capacityHours) that Settings edits. The change is previewed and
 * saved only when the person approves; "Back to normal" removes the exception again. Nothing here
 * runs on its own, and no task is ever marked done.
 */
export function WorkAhead({
  planId,
  schedule,
  tasksById,
}: {
  planId: string;
  schedule: Schedule;
  tasksById: Map<string, Task>;
}) {
  const plan = usePlan(planId);
  const preview = usePreviewSchedule(planId);
  const save = useSaveTimeSettings(planId);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // The pressed button is replaced after a save, so focus moves to the result message.
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  const data = plan.data;
  if (!data?.weekPattern) return null;
  const cap = todayCapacity(data.weekPattern, data.overrides, schedule.today);
  const titleOf = (id: string) => tasksById.get(id)?.title ?? id;

  function reset() {
    setProposal(null);
    setFieldError(null);
    preview.reset();
    save.reset();
  }

  function propose(override: DayOverride) {
    reset();
    setMessage(null);
    preview.mutate(
      { today: schedule.today, overrides: [override] },
      {
        onSuccess: (result) => {
          const effect = workAheadEffect(
            schedule.blocks,
            result.proposed.blocks,
            schedule.today,
            titleOf,
          );
          setProposal({
            override,
            text: [effect, result.summary.text].filter(Boolean).join(' '),
            addedMinutes: addedMinutes(schedule.blocks, result.proposed.blocks, schedule.today),
            passed: hasPassedBlock(
              schedule.blocks,
              result.proposed.blocks,
              schedule.today,
              Date.now(),
              data!.weekPattern!.timezone,
            ),
          });
        },
      },
    );
  }

  function chooseExtra(extra: number) {
    propose({
      date: schedule.today,
      isStudyDay: true,
      capacityHours: Math.round((cap.hours + extra) * 100) / 100,
    });
  }

  function chooseStudyDay() {
    const value = Number(hours);
    if (hours.trim() === '' || !Number.isFinite(value) || value <= 0) {
      return setFieldError('Enter how many hours you want to study today.');
    }
    if (value > 24) return setFieldError('A day has at most 24 hours.');
    propose({ date: schedule.today, isStudyDay: true, capacityHours: value });
  }

  function approve() {
    if (!proposal) return;
    const { override } = proposal;
    // What today really gets: the hours it had plus the study time that fits, not the request.
    const resulting = Math.round((cap.hours + proposal.addedMinutes / 60) * 100) / 100;
    save.mutate(
      { upsertOverrides: [override], removeOverrideDates: [] },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
          setMessage(
            `Today now has ${formatHours(resulting)} of study.${proposal.text ? ` ${proposal.text}` : ''}`,
          );
        },
      },
    );
  }

  function backToNormal() {
    setMessage(null);
    save.mutate(
      { upsertOverrides: [], removeOverrideDates: [schedule.today] },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
          setMessage('Back to normal: today follows your usual hours again.');
        },
        onSettled: () => setConfirmingReset(false),
      },
    );
  }

  const busy = preview.isPending || save.isPending;

  return (
    <section aria-labelledby="work-ahead-heading" className="space-y-3">
      <h2 id="work-ahead-heading">Work ahead</h2>
      {/* The one live region of this section: results, "checking" and "preview ready". */}
      <div ref={messageRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {message ? (
          <p className="font-bold text-ok">{message}</p>
        ) : preview.isPending ? (
          <p className="text-muted">Checking the change…</p>
        ) : proposal ? (
          <p className="text-muted">Preview ready. Check it below, then approve.</p>
        ) : null}
      </div>
      {cap.override ? (
        <p className="text-muted">
          Today has its own setting:{' '}
          {cap.override.isStudyDay
            ? `study day${cap.override.capacityHours !== undefined ? `, ${formatHours(cap.override.capacityHours)}` : ''}`
            : 'day off'}
          .
        </p>
      ) : null}
      {save.isError && !proposal ? (
        <ErrorText>{describeError(save.error, 'The change could not be saved.')}</ErrorText>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {open ? null : (
          <Button
            onClick={() => {
              setOpen(true);
              setMessage(null);
              setHours(String(Math.min(cap.windowHours, data.weekPattern!.defaultHours)));
            }}
          >
            Work ahead
          </Button>
        )}
        {cap.override ? (
          <Button onClick={() => setConfirmingReset(true)} disabled={busy}>
            Back to normal
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-3 border-l-4 border-border pl-4">
          {cap.isStudyDay ? (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="font-bold">Add study hours to today</legend>
              <p className="text-muted">
                Today has {formatHours(cap.hours)}. Tasks that come next move into today, and later
                tasks move up.
              </p>
              <div className="flex flex-wrap gap-3">
                {EXTRA_HOUR_CHOICES.map((n) => (
                  <Button key={n} onClick={() => chooseExtra(n)}>
                    {`Add ${n} ${n === 1 ? 'hour' : 'hours'}`}
                  </Button>
                ))}
              </div>
            </fieldset>
          ) : (
            <div className="space-y-2">
              <h3 className="font-bold">Today is not a study day</h3>
              <p className="text-muted">
                You can study today anyway. Choose how many hours; tasks that come next move into
                today.
              </p>
              <TextField
                label="Hours today"
                type="number"
                inputMode="decimal"
                step="0.25"
                min="0.25"
                max={24}
                value={hours}
                onChange={(event) => {
                  setHours(event.target.value);
                  setFieldError(null);
                }}
                error={fieldError}
                className="max-w-40"
              />
              <Button onClick={chooseStudyDay} disabled={busy}>
                Make today a study day
              </Button>
            </div>
          )}

          {preview.isError ? (
            <ErrorText>
              {describeError(preview.error, 'The change could not be checked.')}
            </ErrorText>
          ) : null}
          {proposal ? (
            <div className="space-y-3 border-l-4 border-accent bg-accent-soft p-4 text-accent-soft-text">
              <h3 className="font-bold">What this would change</h3>
              <p>
                {proposal.text ||
                  `Today would have ${formatHours(proposal.override.capacityHours ?? 0)} of study.`}
              </p>
              {proposal.addedMinutes <= 0 ? (
                <p>
                  Your study window ({data.weekPattern.windowStart} to {data.weekPattern.windowEnd},
                  without lunch) has no room for more today, so nothing would move. You can widen
                  the window in Plan settings.
                </p>
              ) : proposal.addedMinutes < requestedMinutes(proposal.override, cap.hours) ? (
                <p>
                  Only {formatHours(proposal.addedMinutes / 60)} more fits in your study window
                  today.
                </p>
              ) : null}
              {proposal.passed ? (
                <p className="font-bold">
                  Part of this time has already passed today, so it can’t be added now. Try again
                  with fewer hours, or leave it for tomorrow.
                </p>
              ) : null}
              <p>Nothing is saved until you approve.</p>
              {save.isError ? (
                <ErrorText>{describeError(save.error, 'The change could not be saved.')}</ErrorText>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="primary"
                  onClick={approve}
                  disabled={save.isPending || proposal.addedMinutes <= 0 || proposal.passed}
                >
                  {save.isPending
                    ? 'Saving…'
                    : cap.isStudyDay
                      ? `Add ${formatHours((proposal.override.capacityHours ?? 0) - cap.hours)} to today`
                      : 'Make today a study day'}
                </Button>
                <Button onClick={reset} disabled={save.isPending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <Button
            onClick={() => {
              setOpen(false);
              reset();
            }}
            disabled={busy}
          >
            Close
          </Button>
        </div>
      ) : null}
      {confirmingReset ? (
        <ConfirmDialog
          title="Remove today’s exception?"
          confirmLabel={save.isPending ? 'Removing…' : 'Remove the exception'}
          cancelLabel="Keep it"
          busy={save.isPending}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={backToNormal}
        >
          <p>
            Today has its own setting:{' '}
            {cap.override?.isStudyDay
              ? `a study day${cap.override.capacityHours !== undefined ? ` of ${formatHours(cap.override.capacityHours)}` : ''}`
              : 'a day off'}
            . It may have been set in Plan settings. Removing it makes today follow your usual
            weekly hours again.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
