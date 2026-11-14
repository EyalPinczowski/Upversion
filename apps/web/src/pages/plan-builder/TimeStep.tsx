import {
  addDays,
  diffDays,
  isLocalDate,
  TIME_OF_DAY_WINDOWS,
  WEEKDAY_NAMES,
} from '@upversion/shared';
import { useId } from 'react';
import { Button, ErrorText, TextField } from '../../components/ui';
import { formatDate } from '../../lib/format';
import {
  HOURS_MAX,
  HOURS_MIN,
  TIME_OF_DAY_CHOICES,
  type BuilderState,
  type StepErrors,
} from './builder-model';

const QUICK_WEEKS = [4, 8, 12] as const;

/**
 * Step 3: when to start, when to finish, and when the person studies. Whether it all fits is not
 * guessed here: the preview on step 5 runs the real scheduler.
 */
export function TimeStep({
  state,
  errors,
  onChange,
}: {
  state: BuilderState;
  errors: StepErrors;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  const daysLegend = useId();
  const window = TIME_OF_DAY_WINDOWS[state.timeOfDay];
  const weeks =
    isLocalDate(state.startDate) && isLocalDate(state.deadline)
      ? diffDays(state.startDate, state.deadline) / 7
      : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Start date"
          type="date"
          value={state.startDate}
          error={errors.startDate}
          onChange={(event) => onChange({ startDate: event.target.value })}
        />
        <TextField
          label="Finish date"
          type="date"
          value={state.deadline}
          error={errors.deadline}
          hint={
            weeks !== null && weeks > 0
              ? `That is ${Number.isInteger(weeks) ? weeks : weeks.toFixed(1)} weeks from the start.`
              : undefined
          }
          onChange={(event) => onChange({ deadline: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold" id="quick-weeks">
          Finish in
        </span>
        {QUICK_WEEKS.map((n) => (
          <Button
            key={n}
            aria-describedby="quick-weeks"
            disabled={!isLocalDate(state.startDate)}
            onClick={() => onChange({ deadline: addDays(state.startDate, n * 7) })}
          >
            {n} weeks
          </Button>
        ))}
      </div>

      <fieldset
        className="space-y-2"
        aria-describedby={errors.weekdays ? `${daysLegend}-e` : undefined}
      >
        <legend id={daysLegend} className="font-bold">
          Which days can you study?
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {WEEKDAY_NAMES.map((name, day) => (
            <label key={name} className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                className="size-6"
                checked={state.weekdays.includes(day)}
                onChange={(event) =>
                  onChange({
                    weekdays: event.target.checked
                      ? [...state.weekdays, day]
                      : state.weekdays.filter((d) => d !== day),
                  })
                }
              />
              {name}
            </label>
          ))}
        </div>
        {errors.weekdays ? <ErrorText id={`${daysLegend}-e`}>{errors.weekdays}</ErrorText> : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Hours per study day"
          type="number"
          inputMode="decimal"
          min={HOURS_MIN}
          max={HOURS_MAX}
          step={0.5}
          value={state.hours}
          error={errors.hours}
          hint="Be realistic: a plan you can keep beats an ambitious one you drop."
          onChange={(event) => onChange({ hours: event.target.value })}
        />
        <div className="space-y-1">
          <label htmlFor="time-of-day" className="block font-bold">
            When do you study best?
          </label>
          <select
            id="time-of-day"
            value={state.timeOfDay}
            onChange={(event) => onChange({ timeOfDay: event.target.value })}
            className="min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text"
          >
            {TIME_OF_DAY_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {window ? (
            <p className="text-muted">
              Study blocks are placed between {window.windowStart} and {window.windowEnd}.
            </p>
          ) : null}
        </div>
      </div>
      <p className="text-muted">
        Time zone: {state.timezone} (from your browser).
        {isLocalDate(state.startDate) ? ` The plan starts on ${formatDate(state.startDate)}.` : ''}
      </p>
    </div>
  );
}
