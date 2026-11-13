import { Link } from 'react-router';
import { levelLabel, LEVEL_LABELS } from '@upversion/shared';
import { linkClass } from '../../components/ui';
import {
  levelOf,
  levelSource,
  relevantSkillIds,
  roleSkills,
  skillName,
  type BuilderState,
  type Prefill,
} from './builder-model';

/**
 * Step 2: how comfortable the person is with each skill the plan needs. Each row says where its
 * level came from. Edits here are used for this plan only; the profile is not changed.
 */
export function SkillsStep({
  state,
  prefill,
  onChange,
}: {
  state: BuilderState;
  prefill: Prefill;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  const ids = relevantSkillIds(state);
  const weights = new Map<string, number>();
  for (const roleId of state.roleIds) {
    for (const { skill, weight } of roleSkills(roleId)) {
      weights.set(skill, Math.max(weights.get(skill) ?? 0, weight));
    }
  }
  return (
    <div className="space-y-5">
      <p>
        Be honest: the plan only adds what is missing. Your changes here are used for this plan only
        and are not saved to your profile.
      </p>
      <p>
        Levels from a CV can be out of date.{' '}
        <Link to="/settings/cv" className={linkClass}>
          Change my CV
        </Link>{' '}
        and come back to build a plan again; what you chose so far on this page is not kept.
      </p>
      <ul className="divide-y divide-border">
        {ids.map((id) => {
          const level = levelOf(state, prefill, id);
          const source = levelSource(state, prefill, id);
          const weight = weights.get(id);
          const selectId = `level-${id}`;
          return (
            <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <div className="min-w-0 grow basis-52">
                <label htmlFor={selectId} className="block font-bold">
                  {skillName(id)}
                </label>
                <p className="text-muted">
                  {source}
                  {weight ? ` · the role weights it ${weight} of 5` : ' · extra skill'}
                </p>
              </div>
              <select
                id={selectId}
                value={level}
                onChange={(event) =>
                  onChange({ edited: { ...state.edited, [id]: Number(event.target.value) } })
                }
                className="min-h-11 rounded-sm border border-border bg-surface px-3 py-2 text-text"
              >
                {LEVEL_LABELS.map((_, value) => (
                  <option key={value} value={value}>
                    {levelLabel(value)}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
