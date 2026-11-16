import { useId, useState } from 'react';
import { Button } from '../../components/ui';
import {
  MAX_ROLES,
  questionText,
  roleTitle,
  type BuilderState,
} from '../plan-builder/builder-model';
import {
  DISCOVER_ENJOY_ID,
  DISCOVER_STYLE_ID,
  enjoyMax,
  enjoyOptions,
  styleOptions,
  suggestRoles,
} from './first-run-model';

/**
 * "Not sure" on screen 1: the discovery questions of `questions.json`, then 3 or 4 roles from
 * `roles.json` to pick from. Rule-based, in the browser; nothing here is sent anywhere.
 */
export function RoleDiscovery({
  state,
  onChange,
}: {
  state: BuilderState;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  const ids = useId();
  const [enjoy, setEnjoy] = useState<string[]>([]);
  const [style, setStyle] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const max = enjoyMax();
  const full = state.roleIds.length >= MAX_ROLES;

  return (
    <details className="rounded-md border border-border p-4">
      <summary className="flex min-h-11 cursor-pointer items-center font-bold">
        Not sure which role? Help me choose
      </summary>
      <div className="space-y-5 pt-3">
        <fieldset className="space-y-1">
          <legend className="font-bold">{questionText(DISCOVER_ENJOY_ID)}</legend>
          <p className="text-muted">Pick up to {max}.</p>
          {enjoyOptions().map((o) => {
            const on = enjoy.includes(o.value);
            return (
              <label key={o.value} className="flex min-h-11 items-center gap-3 py-1">
                <input
                  type="checkbox"
                  className="size-6 shrink-0"
                  checked={on}
                  disabled={!on && enjoy.length >= max}
                  onChange={(e) => {
                    setSuggested(null);
                    setEnjoy((c) =>
                      e.target.checked ? [...c, o.value] : c.filter((v) => v !== o.value),
                    );
                  }}
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="font-bold">{questionText(DISCOVER_STYLE_ID)} (optional)</legend>
          {styleOptions().map((o) => (
            <label key={o.value} className="flex min-h-11 items-center gap-3 py-1">
              <input
                type="radio"
                name={`${ids}-style`}
                className="size-6 shrink-0"
                checked={style === o.value}
                onChange={() => {
                  setSuggested(null);
                  setStyle(o.value);
                }}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
        <Button
          disabled={enjoy.length === 0}
          onClick={() => setSuggested(suggestRoles(enjoy, style))}
        >
          Suggest roles
        </Button>
        <div role="status" aria-live="polite">
          {suggested && suggested.length === 0 ? (
            <p>No roles matched. Choose a role from the list above.</p>
          ) : null}
        </div>
        {suggested && suggested.length > 0 ? (
          <fieldset className="space-y-1">
            <legend className="font-bold">
              These roles could fit. Tick one or two to aim for.
            </legend>
            {suggested.map((id) => {
              const on = state.roleIds.includes(id);
              return (
                <label key={id} className="flex min-h-11 items-center gap-3 py-1">
                  <input
                    type="checkbox"
                    className="size-6 shrink-0"
                    checked={on}
                    disabled={!on && full}
                    onChange={(e) =>
                      onChange({
                        roleIds: e.target.checked
                          ? [...state.roleIds, id]
                          : state.roleIds.filter((r) => r !== id),
                      })
                    }
                  />
                  <span>{roleTitle(id)}</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
      </div>
    </details>
  );
}
