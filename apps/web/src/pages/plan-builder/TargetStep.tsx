import { matchSkillsInText, type TextSkillHit } from '@upversion/shared';
import { useId, useState } from 'react';
import { Button, ErrorText, TextAreaField } from '../../components/ui';
import {
  MAX_EXTRAS,
  MAX_ROLES,
  ROLES,
  SKILLS,
  skillName,
  type BuilderState,
  type StepErrors,
} from './builder-model';

/**
 * Step 1: the role(s) and any extra skills. A pasted job post is read in this browser only: the
 * matcher runs here, the person confirms which skills it found, and only those skill ids go into
 * the request. The post, and the words it used, are kept in this component's state, shown on the
 * screen and dropped when the step closes. They are never sent, stored or logged.
 */
export function TargetStep({
  state,
  errors,
  onChange,
}: {
  state: BuilderState;
  errors: StepErrors;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  const rolesLegend = useId();
  const [pick, setPick] = useState('');
  const full = state.roleIds.length >= MAX_ROLES;
  const extrasFull = state.extraSkillIds.length >= MAX_EXTRAS;

  function toggleRole(id: string, on: boolean) {
    onChange({
      roleIds: on ? [...state.roleIds, id] : state.roleIds.filter((r) => r !== id),
    });
  }

  function addSkill(id: string) {
    if (!id || state.extraSkillIds.includes(id) || extrasFull) return;
    onChange({ extraSkillIds: [...state.extraSkillIds, id] });
  }

  return (
    <div className="space-y-8">
      <fieldset
        className="space-y-3"
        aria-describedby={errors.roles ? `${rolesLegend}-e` : undefined}
      >
        <legend id={rolesLegend} className="font-bold">
          Which role are you aiming for?
        </legend>
        <p className="text-muted">
          Choose up to {MAX_ROLES}. Each role needs a different mix of skills and certificates.
        </p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {ROLES.map((role) => {
            const checked = state.roleIds.includes(role.id);
            return (
              <label key={role.id} className="flex min-h-11 items-center gap-3 py-1">
                <input
                  type="checkbox"
                  className="size-6 shrink-0"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(event) => toggleRole(role.id, event.target.checked)}
                />
                <span>{role.title}</span>
              </label>
            );
          })}
        </div>
        {full ? (
          <p className="text-muted">You have chosen {MAX_ROLES} roles, the most allowed.</p>
        ) : null}
        {errors.roles ? <ErrorText id={`${rolesLegend}-e`}>{errors.roles}</ErrorText> : null}
      </fieldset>

      <section
        aria-labelledby="extra-skills-heading"
        className="space-y-3 border-t border-border pt-6"
      >
        <h3 id="extra-skills-heading" className="text-lg font-bold">
          Extra skills (optional)
        </h3>
        <p className="text-muted">Add skills you want on top of the role, up to {MAX_EXTRAS}.</p>
        {state.extraSkillIds.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Extra skills you chose">
            {state.extraSkillIds.map((id) => (
              <li
                key={id}
                className="flex items-center gap-1 rounded-sm border border-border bg-surface-2 pl-3"
              >
                <span>{skillName(id)}</span>
                <Button
                  aria-label={`Remove ${skillName(id)}`}
                  className="border-0 bg-transparent"
                  onClick={() =>
                    onChange({ extraSkillIds: state.extraSkillIds.filter((s) => s !== id) })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="extra-skill-select" className="block font-bold">
              Add a skill
            </label>
            <select
              id="extra-skill-select"
              value={pick}
              disabled={extrasFull}
              onChange={(event) => setPick(event.target.value)}
              className="min-h-11 max-w-full rounded-sm border border-border bg-surface px-3 py-2 text-text"
            >
              <option value="">Choose a skill</option>
              {SKILLS.filter((s) => !state.extraSkillIds.includes(s.id)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={!pick || extrasFull}
            onClick={() => {
              addSkill(pick);
              setPick('');
            }}
          >
            Add skill
          </Button>
        </div>
        {extrasFull ? (
          <p className="text-muted">You have {MAX_EXTRAS} extra skills, the most allowed.</p>
        ) : null}
      </section>

      <JobPost state={state} onChange={onChange} />
    </div>
  );
}

function JobPost({
  state,
  onChange,
}: {
  state: BuilderState;
  onChange: (patch: Partial<BuilderState>) => void;
}) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<TextSkillHit[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [added, setAdded] = useState<string | null>(null);
  const room = MAX_EXTRAS - state.extraSkillIds.length;

  function find() {
    setAdded(null);
    // Runs here, in the browser: the text goes nowhere.
    const found = matchSkillsInText(text).filter((h) => !state.extraSkillIds.includes(h.skillId));
    setHits(found);
    setChosen(found.slice(0, Math.max(room, 0)).map((h) => h.skillId));
  }

  function toggle(id: string, on: boolean) {
    setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  }

  function add() {
    const ids = chosen.slice(0, Math.max(room, 0));
    onChange({ extraSkillIds: [...state.extraSkillIds, ...ids] });
    setAdded(
      `Added ${ids.length} ${ids.length === 1 ? 'skill' : 'skills'}. The job post was cleared from this screen.`,
    );
    // The post and the words it used are dropped as soon as the skills are confirmed.
    setText('');
    setHits(null);
    setChosen([]);
  }

  return (
    <details className="border-t border-border pt-4">
      <summary className="flex min-h-11 cursor-pointer items-center font-bold">
        Paste a job post (optional)
      </summary>
      <div className="space-y-3 pt-3">
        <p className="text-muted">
          The post is read in your browser to find skills. It is not sent anywhere and not saved.
          Only the skills you confirm are used.
        </p>
        <TextAreaField
          label="Job post"
          rows={6}
          value={text}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            setHits(null);
          }}
        />
        <Button disabled={text.trim() === ''} onClick={find}>
          Find skills in the post
        </Button>
        <div role="status" aria-live="polite" className="space-y-3">
          {added ? <p className="font-bold text-ok">{added}</p> : null}
          {hits && hits.length === 0 ? <p>No new catalog skills were found in the post.</p> : null}
        </div>
        {hits && hits.length > 0 ? (
          <fieldset className="space-y-2">
            <legend className="font-bold">Skills found. Tick the ones to add.</legend>
            {room <= 0 ? (
              <p className="text-muted">
                You already have {MAX_EXTRAS} extra skills. Remove one first.
              </p>
            ) : null}
            {hits.map((hit) => {
              const on = chosen.includes(hit.skillId);
              return (
                <label key={hit.skillId} className="flex min-h-11 items-start gap-3 py-1">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-6 shrink-0"
                    checked={on}
                    disabled={(!on && chosen.length >= room) || room <= 0}
                    onChange={(event) => toggle(hit.skillId, event.target.checked)}
                  />
                  <span>
                    {skillName(hit.skillId)}
                    {hit.terms.length > 0 ? (
                      <span className="text-muted">
                        {' – '}
                        {hit.terms.map((t) => `“${t}”`).join(', ')}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            <Button variant="primary" disabled={chosen.length === 0} onClick={add}>
              Add the ticked skills
            </Button>
          </fieldset>
        ) : null}
      </div>
    </details>
  );
}
