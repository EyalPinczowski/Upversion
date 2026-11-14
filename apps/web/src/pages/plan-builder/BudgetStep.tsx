import { useId } from 'react';
import { ErrorText, TextField } from '../../components/ui';
import { questionOptions, questionText, type BuilderState, type StepErrors } from './builder-model';

function Choice<T extends string>({
  questionId,
  value,
  onPick,
  skip,
  error,
}: {
  questionId: string;
  value: T;
  onPick: (value: T) => void;
  skip?: (value: string) => boolean;
  error?: string;
}) {
  const legend = useId();
  const options = questionOptions(questionId).filter((o) => !skip?.(o.value));
  return (
    <fieldset className="space-y-1" aria-describedby={error ? `${legend}-e` : undefined}>
      <legend id={legend} className="font-bold">
        {questionText(questionId)}
      </legend>
      {options.map((o) => (
        <label key={o.value} className="flex min-h-11 items-center gap-3 py-1">
          <input
            type="radio"
            name={questionId}
            className="size-6 shrink-0"
            checked={value === o.value}
            onChange={() => onPick(o.value as T)}
          />
          <span>{o.label}</span>
        </label>
      ))}
      {error ? <ErrorText id={`${legend}-e`}>{error}</ErrorText> : null}
    </fieldset>
  );
}

/**
 * Step 4: budget, certificates and interview practice. The questions and their choices are read
 * from `questions.json`. Prices in the catalog are in US dollars and there is no exchange rate, so
 * the budget is entered in dollars and the other currencies are not offered.
 */
export function BudgetStep({
  state,
  errors,
  onChange,
}: {
  state: BuilderState;
  errors: StepErrors;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Choice
          questionId="budget"
          value={state.budgetMode}
          onPick={(budgetMode) => onChange({ budgetMode })}
        />
        <p className="text-muted">
          Catalog prices are in US dollars. Prices change, so check each one before you pay.
        </p>
        {state.budgetMode === 'limit' ? (
          <TextField
            label="Most you want to spend in total (US dollars)"
            type="number"
            inputMode="decimal"
            min={1}
            step="any"
            value={state.amount}
            error={errors.amount}
            onChange={(event) => onChange({ amount: event.target.value })}
          />
        ) : null}
        {state.budgetMode !== 'free' ? (
          <TextField
            label="Most for a single course or exam (US dollars, optional)"
            type="number"
            inputMode="decimal"
            min={1}
            step="any"
            value={state.maxItemPrice}
            error={errors.maxItemPrice}
            hint="For example, nothing over 150."
            onChange={(event) => onChange({ maxItemPrice: event.target.value })}
          />
        ) : null}
      </div>
      <Choice
        questionId="certificates"
        value={state.certPreference}
        onPick={(certPreference) => onChange({ certPreference })}
      />
      <Choice
        questionId="interview_prep"
        value={state.interviewPrep}
        onPick={(interviewPrep) => onChange({ interviewPrep })}
      />
    </div>
  );
}
