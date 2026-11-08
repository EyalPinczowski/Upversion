import {
  CATALOG_TAXONOMY,
  MAX_ROLE_TITLE_LENGTH,
  MAX_YEARS,
  redactPii,
  toImportPayload,
  type CvExtraction,
  type ProfileImport,
} from '@upversion/shared';
import { useId, useState, type ReactNode } from 'react';
import { Button, ErrorText } from '../../components/ui';

const SKILL_NAMES = new Map(CATALOG_TAXONOMY.skills.map((s) => [s.id, s.name]));
const LEVELS = [
  { value: 1, label: 'Basic' },
  { value: 2, label: 'Comfortable' },
  { value: 3, label: 'Strong' },
];
const EDUCATION_LABELS: Record<string, string> = {
  high_school: 'High school',
  some_college: 'Some college / courses',
  bachelor: 'Bachelor’s degree',
  master: 'Master’s or higher',
};

const rowClass = 'flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2';
const boxClass = 'h-5 w-5 shrink-0 accent-[var(--color-accent)]';

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="font-bold">{legend}</legend>
      <ul className="divide-y divide-border">{children}</ul>
    </fieldset>
  );
}

/** The evidence snippet is already redacted by the matcher; it is shown here and never sent. */
function Evidence({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span dir="auto" className="basis-full pl-8 text-muted">
      {text}
    </span>
  );
}

/**
 * Review of what the CV matcher suggested. Nothing is sent until the person presses the save
 * button, and only checked rows go into the payload, which `toImportPayload` builds from an
 * allowlist (no evidence, no raw text, no file name).
 */
export function CvReviewStep({
  extraction,
  busy,
  error,
  onSave,
  onDiscard,
}: {
  extraction: CvExtraction;
  busy: boolean;
  error: string | null;
  onSave: (payload: ProfileImport) => void;
  onDiscard: () => void;
}) {
  const ids = useId();
  const [skills, setSkills] = useState(() =>
    extraction.skills.map((s) => ({ checked: s.checked, level: s.level as number })),
  );
  // The one place in setup with typed text: a role title taken from the CV, to confirm or fix.
  // It goes through `toImportPayload`, which drops a title holding personal details.
  const [roles, setRoles] = useState(() =>
    extraction.rolesHeld.map((r) => ({
      checked: r.checked,
      title: r.title,
      years: r.years === null ? '' : String(r.years),
    })),
  );
  const [roleError, setRoleError] = useState<{
    row: number;
    field: 'title' | 'years';
    text: string;
  } | null>(null);
  const [years, setYears] = useState(extraction.yearsExperience !== null);
  const [education, setEducation] = useState(extraction.education !== null);
  const [tools, setTools] = useState(() => extraction.tools.map(() => true));

  const empty =
    extraction.skills.length === 0 &&
    extraction.rolesHeld.length === 0 &&
    extraction.yearsExperience === null &&
    !extraction.education &&
    extraction.tools.length === 0;

  function save() {
    for (const [i, r] of roles.entries()) {
      if (!r.checked) continue;
      const years = r.years.trim() === '' ? null : Number(r.years);
      if (r.title.trim() === '') {
        setRoleError({
          row: i,
          field: 'title',
          text: `Role ${i + 1} needs a title, or untick it.`,
        });
        return;
      }
      if (redactPii(r.title).count > 0) {
        setRoleError({
          row: i,
          field: 'title',
          text: `Role ${i + 1}: remove the email, link, phone number or handle from the title.`,
        });
        return;
      }
      if (years !== null && !(years >= 0 && years <= MAX_YEARS)) {
        setRoleError({
          row: i,
          field: 'years',
          text: `Role ${i + 1}: years must be between 0 and ${MAX_YEARS}.`,
        });
        return;
      }
    }
    setRoleError(null);
    onSave(
      toImportPayload({
        skills: extraction.skills
          .map((s, i) => ({ skillId: s.skillId, level: skills[i]!.level, on: skills[i]!.checked }))
          .filter((s) => s.on),
        rolesHeld: extraction.rolesHeld.flatMap((r, i) =>
          roles[i]!.checked
            ? [
                {
                  roleId: r.roleId,
                  title: roles[i]!.title,
                  years: roles[i]!.years.trim() === '' ? null : Number(roles[i]!.years),
                },
              ]
            : [],
        ),
        yearsExperience: years ? extraction.yearsExperience : null,
        education: education ? (extraction.education?.value ?? null) : null,
        tools: extraction.tools.filter((_, i) => tools[i]).map((t) => t.tool),
      }),
    );
  }

  if (empty) {
    return (
      <div className="space-y-4">
        <p>
          We didn’t find anything to suggest in that text. You can try a different file, or continue
          without it.
        </p>
        <Button onClick={onDiscard}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p>
        These are suggestions from your CV, matched on this device. Untick anything that is wrong.
        Only ticked items are saved. Nothing has been saved yet.
      </p>

      {extraction.skills.length > 0 ? (
        <Group legend="Skills">
          {extraction.skills.map((s, i) => {
            const name = SKILL_NAMES.get(s.skillId) ?? s.skillId;
            return (
              <li key={s.skillId} className={rowClass}>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className={boxClass}
                    checked={skills[i]!.checked}
                    onChange={(e) =>
                      setSkills((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)),
                      )
                    }
                  />
                  <span>{name}</span>
                </label>
                <select
                  aria-label={`Level for ${name}`}
                  className="ml-auto min-h-11 rounded-sm border border-border bg-surface px-2 text-text"
                  value={skills[i]!.level}
                  onChange={(e) =>
                    setSkills((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, level: Number(e.target.value) } : x)),
                    )
                  }
                >
                  {LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <Evidence text={s.evidence} />
              </li>
            );
          })}
        </Group>
      ) : null}

      {extraction.rolesHeld.length > 0 ? (
        <Group legend="Roles you have held">
          {extraction.rolesHeld.map((r, i) => (
            <li key={`${r.title}-${i}`} className={rowClass}>
              <span id={`${ids}-inc-${i}`} className="sr-only">
                Include
              </span>
              <input
                type="checkbox"
                className={`${boxClass} mt-9`}
                aria-labelledby={`${ids}-inc-${i} ${ids}-titlelabel-${i}`}
                checked={roles[i]!.checked}
                onChange={(e) =>
                  setRoles((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)),
                  )
                }
              />
              <div className="min-w-0 grow basis-48 space-y-1">
                <label
                  id={`${ids}-titlelabel-${i}`}
                  htmlFor={`${ids}-title-${i}`}
                  className="block text-muted"
                >
                  Role {i + 1} title
                </label>
                <input
                  id={`${ids}-title-${i}`}
                  type="text"
                  dir="auto"
                  maxLength={MAX_ROLE_TITLE_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={
                    roleError?.row === i && roleError.field === 'title' ? true : undefined
                  }
                  aria-describedby={
                    roleError?.row === i && roleError.field === 'title'
                      ? `${ids}-role-err`
                      : undefined
                  }
                  className="min-h-11 w-full rounded-sm border border-border bg-surface px-3 text-text"
                  value={roles[i]!.title}
                  onChange={(e) =>
                    setRoles((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${ids}-years-${i}`} className="block text-muted">
                  Role {i + 1} years
                </label>
                <input
                  id={`${ids}-years-${i}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={MAX_YEARS}
                  step={0.5}
                  aria-invalid={
                    roleError?.row === i && roleError.field === 'years' ? true : undefined
                  }
                  aria-describedby={
                    roleError?.row === i && roleError.field === 'years'
                      ? `${ids}-role-err`
                      : undefined
                  }
                  className="min-h-11 w-24 rounded-sm border border-border bg-surface px-3 text-text"
                  value={roles[i]!.years}
                  onChange={(e) =>
                    setRoles((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, years: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <Evidence text={r.evidence} />
            </li>
          ))}
        </Group>
      ) : null}

      {extraction.yearsExperience !== null || extraction.education ? (
        <Group legend="About you">
          {extraction.yearsExperience !== null ? (
            <li className={rowClass}>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className={boxClass}
                  checked={years}
                  onChange={(e) => setYears(e.target.checked)}
                />
                <span>Years of experience: {extraction.yearsExperience}</span>
              </label>
            </li>
          ) : null}
          {extraction.education ? (
            <li className={rowClass}>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className={boxClass}
                  checked={education}
                  onChange={(e) => setEducation(e.target.checked)}
                />
                <span>
                  Education:{' '}
                  {EDUCATION_LABELS[extraction.education.value] ?? extraction.education.value}
                </span>
              </label>
              <Evidence text={extraction.education.evidence} />
            </li>
          ) : null}
        </Group>
      ) : null}

      {extraction.tools.length > 0 ? (
        <Group legend="Tools you have used">
          {extraction.tools.map((t, i) => (
            <li key={t.tool} className={rowClass}>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className={boxClass}
                  checked={tools[i]}
                  onChange={(e) =>
                    setTools((prev) => prev.map((x, j) => (j === i ? e.target.checked : x)))
                  }
                />
                <span>{t.tool}</span>
              </label>
              <Evidence text={t.evidence} />
            </li>
          ))}
        </Group>
      ) : null}

      {roleError ? <ErrorText id={`${ids}-role-err`}>{roleError.text}</ErrorText> : null}
      {error ? <ErrorText id={`${ids}-err`}>{error}</ErrorText> : null}
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save these to my profile'}
        </Button>
        <Button onClick={onDiscard} disabled={busy}>
          Don’t save any of it
        </Button>
      </div>
    </div>
  );
}
