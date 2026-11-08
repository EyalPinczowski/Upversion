import { useState, type FormEvent } from 'react';
import type { PlanDetail } from '../../api/client';
import { useSaveStartDate } from '../../api/hooks';
import { Button, ErrorText, TextField } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { describeError } from '../../lib/messages';
import { dateInZone } from '../../lib/zoned-date';

/** Today in the plan's time zone, as the API reads it (UTC when the plan has no settings). */
function todayFor(plan: PlanDetail): string {
  const zone = plan.weekPattern?.timezone ?? 'UTC';
  return dateInZone(Date.now(), zone) ?? dateInZone(Date.now(), 'UTC')!;
}

/**
 * The day the plan starts. It can be moved to today or later (and not past the end date); the
 * whole schedule then starts from that day. Saving is an explicit action.
 */
export function StartDate({ plan }: { plan: PlanDetail }) {
  const save = useSaveStartDate(plan.id);
  const [value, setValue] = useState(plan.startDate);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const earliest = todayFor(plan);
  const latest = plan.endDate ?? undefined;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(null);
    if (value === '') return setError('Choose a date first.');
    if (value === plan.startDate) return setError('That is already the start date.');
    if (value < earliest) {
      return setError(`Choose ${formatDate(earliest)} or a later day.`);
    }
    if (latest && value > latest) {
      return setError(`The start date can’t be after the end date, ${formatDate(latest)}.`);
    }
    setError(null);
    save.mutate(value, { onSuccess: () => setSaved(value) });
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby="start-date-heading"
      className="space-y-3 border-t border-border pt-4"
    >
      <h4 id="start-date-heading" className="font-bold">
        Start date
      </h4>
      <p className="text-muted">
        Moves the whole schedule: nothing is planned before this day. Earliest allowed:{' '}
        {formatDate(earliest)}
        {latest ? `. Latest: ${formatDate(latest)}` : ''}.
      </p>
      <p className="text-muted">
        The start date can only be moved while the plan has not started; once a study day has begun
        it is fixed.
      </p>
      <TextField
        label="Plan start date"
        type="date"
        value={value}
        min={earliest}
        max={latest}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
          setSaved(null);
          save.reset();
        }}
        error={error}
        className="max-w-60"
      />
      {save.isError ? (
        <ErrorText>{describeError(save.error, 'The start date could not be saved.')}</ErrorText>
      ) : null}
      <div role="status">
        {saved ? (
          <p className="font-bold text-ok">
            Saved. Your schedule now starts on {formatDate(saved)}.
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save start date'}
      </Button>
    </form>
  );
}
