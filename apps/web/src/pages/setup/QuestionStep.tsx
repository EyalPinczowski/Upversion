import { CATALOG_TAXONOMY, type QuestionOption, type SetupQuestion } from '@upversion/shared';
import { useId } from 'react';
import { ErrorText } from '../../components/ui';
import { hintFor } from './question-model';

/** Sunday first, the same numbering as the scheduling engine (0 = Sunday). */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const optionRow = 'flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-1 py-2';
const inputClass = 'h-5 w-5 shrink-0 accent-[var(--color-accent)]';

type Choice = { value: string; label: string };

function choicesOf(question: SetupQuestion): Choice[] {
  if (question.type === 'multi_role') {
    return CATALOG_TAXONOMY.roles.map((r) => ({ value: r.id, label: r.title }));
  }
  if (question.type === 'multi_skill') {
    return CATALOG_TAXONOMY.skills.map((s) => ({ value: s.id, label: s.name }));
  }
  return (question.options ?? []).map((o: QuestionOption) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  );
}

/**
 * One question, rendered from its definition. Every control is a choice (radio, checkbox or
 * select): setup takes no typed free text, so nothing personal can be entered here.
 */
export function QuestionStep({
  question,
  answers,
  onChange,
  error,
}: {
  question: SetupQuestion;
  answers: Record<string, unknown>;
  onChange: (value: unknown) => void;
  error: string | null;
}) {
  const ids = useId();
  const value = answers[question.id];
  const why = question.why ?? null;
  const hint = hintFor(question, answers);
  const describedBy = [
    why ? `${ids}-why` : null,
    hint ? `${ids}-hint` : null,
    error ? `${ids}-err` : null,
  ]
    .filter(Boolean)
    .join(' ');

  let control;
  switch (question.type) {
    case 'single':
    case 'yes_no': {
      const choices: Choice[] =
        question.type === 'yes_no'
          ? [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]
          : choicesOf(question);
      const current =
        question.type === 'yes_no' ? (value === true ? 'yes' : value === false ? 'no' : '') : value;
      control = choices.map((c) => (
        <label key={c.value} className={optionRow}>
          <input
            type="radio"
            name={question.id}
            className={inputClass}
            checked={current === c.value}
            onChange={() => onChange(question.type === 'yes_no' ? c.value === 'yes' : c.value)}
          />
          <span>{c.label}</span>
        </label>
      ));
      break;
    }
    case 'weekdays': {
      const picked = Array.isArray(value) ? (value as number[]) : [];
      control = DAYS.map((label, day) => (
        <label key={day} className={optionRow}>
          <input
            type="checkbox"
            className={inputClass}
            checked={picked.includes(day)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...picked, day].sort((a, b) => a - b)
                  : picked.filter((d) => d !== day),
              )
            }
          />
          <span>{label}</span>
        </label>
      ));
      break;
    }
    case 'number': {
      const min = question.min ?? 0;
      const max = question.max ?? 12;
      const step = question.step ?? 1;
      const options: number[] = [];
      for (let n = min; n <= max + 1e-9; n += step) options.push(Math.round(n * 100) / 100);
      control = (
        <select
          id={`${ids}-n`}
          aria-describedby={describedBy || undefined}
          className="min-h-11 w-40 rounded-sm border border-border bg-surface px-3 py-2 text-text"
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        >
          <option value="">Choose…</option>
          {options.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? '1 hour' : `${n} hours`}
            </option>
          ))}
        </select>
      );
      break;
    }
    default: {
      // multi, multi_role, multi_skill
      const picked = Array.isArray(value) ? (value as string[]) : [];
      const atMax = question.max !== undefined && picked.length >= question.max;
      const grid = question.type === 'multi' ? '' : 'sm:grid sm:grid-cols-2 sm:gap-x-4';
      control = (
        <div className={grid}>
          {choicesOf(question).map((c) => {
            const on = picked.includes(c.value);
            return (
              <label key={c.value} className={optionRow}>
                <input
                  type="checkbox"
                  className={inputClass}
                  checked={on}
                  disabled={!on && atMax}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...picked, c.value] : picked.filter((v) => v !== c.value),
                    )
                  }
                />
                <span>{c.label}</span>
              </label>
            );
          })}
        </div>
      );
    }
  }

  const maxNote =
    question.max !== undefined &&
    (question.type === 'multi_role' || question.type === 'multi_skill' || question.type === 'multi')
      ? `Choose up to ${question.max}.`
      : null;

  if (question.type === 'number') {
    return (
      <div className="space-y-3">
        <label htmlFor={`${ids}-n`} className="block text-h2 font-bold">
          {question.text}
        </label>
        {why ? (
          <p id={`${ids}-why`} className="text-muted">
            {why}
          </p>
        ) : null}
        {hint ? (
          <p id={`${ids}-hint`} className="font-bold">
            {hint}
          </p>
        ) : null}
        <div>{control}</div>
        {error ? <ErrorText id={`${ids}-err`}>{error}</ErrorText> : null}
      </div>
    );
  }

  return (
    <fieldset aria-describedby={describedBy || undefined} className="space-y-3">
      <legend className="text-h2 font-bold">{question.text}</legend>
      {why ? (
        <p id={`${ids}-why`} className="text-muted">
          {why}
        </p>
      ) : null}
      {maxNote ? <p className="text-muted">{maxNote}</p> : null}
      {hint ? (
        <p id={`${ids}-hint`} className="font-bold">
          {hint}
        </p>
      ) : null}
      <div>{control}</div>
      {error ? <ErrorText id={`${ids}-err`}>{error}</ErrorText> : null}
    </fieldset>
  );
}
