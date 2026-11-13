import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { BuildDraft } from '../../api/client';
import { AlertIcon, CheckIcon, ClockIcon } from '../../components/icons';
import { Button, ErrorText, TextField } from '../../components/ui';
import { safeWebUrl } from '../../lib/links';
import { formatDate, formatHours } from '../../lib/format';
import { RetryButton } from '../../components/status';
import { describeBuildError, skillName, type BuilderState } from './builder-model';
import { costLines, EXCLUDED_REASON_TEXT, itemBadges, itemCostText, money } from './draft-text';

type Item = BuildDraft['items'][number];

function Badge({ children }: { children: string }) {
  // Words plus an icon and a border: never colour alone.
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border-2 border-warn bg-warn-soft px-2 py-0.5 text-sm font-bold text-warn">
      <AlertIcon />
      {children}
    </span>
  );
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="text-lg font-bold">
      {children}
    </h3>
  );
}

type Task = BuildDraft['plan']['tasks'][number];

interface RowProps {
  tasks: Map<string, Task>;
  state: BuilderState;
  remove: (item: Item) => void;
  setTier: (item: Item, tier: 'core' | 'optional') => void;
  setExamDate: (catalogId: string, date: string, start: string) => void;
}

function ItemRow({ item, tasks, state, remove, setTier, setExamDate }: { item: Item } & RowProps) {
  const task = tasks.get(item.taskIds[0] ?? '');
  const link = safeWebUrl(task?.url);
  const badges = itemBadges(item);
  const exam = state.examDates.find((e) => e.catalogId === item.catalogId);
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="min-w-0 grow basis-60 text-lg font-bold">{item.title}</h4>
        <span className="tabular-nums text-muted">
          {formatHours(item.hours)} · {itemCostText(item)}
        </span>
      </div>
      <p className="text-muted">{item.provider}</p>
      <p>{item.why}</p>
      {badges.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Needs check">
          {badges.map((b) => (
            <li key={b}>
              <Badge>{b}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {badges.length > 0 && task?.notes ? <p className="text-muted">{task.notes}</p> : null}
      {link ? (
        <p>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-accent underline underline-offset-2"
          >
            Open the course page <span className="sr-only">(opens in a new tab)</span>
          </a>
        </p>
      ) : null}
      {item.kind === 'exam' ? (
        <fieldset className="space-y-2">
          <legend className="font-bold">Exam date (optional)</legend>
          <div className="flex flex-wrap gap-3">
            <TextField
              label={`Date of ${item.title}`}
              type="date"
              value={exam?.date ?? ''}
              onChange={(event) =>
                setExamDate(item.catalogId, event.target.value, exam?.start ?? '09:00')
              }
            />
            <TextField
              label={`Start time of ${item.title}`}
              type="time"
              value={exam?.start ?? '09:00'}
              disabled={!exam}
              onChange={(event) =>
                exam ? setExamDate(item.catalogId, exam.date, event.target.value) : undefined
              }
            />
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => remove(item)}>
          Remove<span className="sr-only">: {item.title}</span>
        </Button>
        {item.kind !== 'exam' ? (
          item.tier === 'core' ? (
            <Button onClick={() => setTier(item, 'optional')}>
              Make optional<span className="sr-only">: {item.title}</span>
            </Button>
          ) : (
            <Button onClick={() => setTier(item, 'core')}>
              Make core<span className="sr-only">: {item.title}</span>
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}

function ItemSection({
  id,
  title,
  items,
  rows,
}: {
  id: string;
  title: string;
  items: Item[];
  rows: RowProps;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="space-y-1">
      <Heading id={id}>{title}</Heading>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <ItemRow key={item.catalogId} item={item} {...rows} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Step 5: the draft the server built from the choices ("Here is what I understood"). Nothing is
 * created until "Start this plan". Every change below edits the request, and the preview runs
 * again; the draft is never edited on this side.
 */
export function DraftStep({
  state,
  onChange,
  query,
  updating,
  blocker,
}: {
  state: BuilderState;
  onChange: (patch: Partial<BuilderState>) => void;
  query: UseQueryResult<BuildDraft>;
  /** A newer request is waiting to be sent or in flight: the draft shown may be out of date. */
  updating: boolean;
  /** Why the draft cannot be made yet (a step before it is unfinished). */
  blocker: string | null;
}) {
  if (blocker) return <ErrorText>{blocker}</ErrorText>;
  const draft = query.data;
  if (!draft) {
    if (query.isError) {
      return (
        <div className="space-y-3">
          <ErrorText>{describeBuildError(query.error)}</ErrorText>
          <RetryButton onClick={() => void query.refetch()} />
        </div>
      );
    }
    return (
      <p role="status" className="flex min-h-11 items-center gap-2 text-muted">
        <ClockIcon />
        Building your draft…
      </p>
    );
  }

  const core = draft.items.filter((i) => i.tier === 'core');
  const optional = draft.items.filter((i) => i.tier === 'optional');
  const tasks = new Map(draft.plan.tasks.map((t) => [t.id, t]));
  const { summary } = draft;

  const remove = (item: Item) => {
    if (item.origin === 'opt_in') {
      onChange({ certificateOptIns: state.certificateOptIns.filter((c) => c !== item.catalogId) });
    } else if (!state.exclude.includes(item.catalogId)) {
      onChange({ exclude: [...state.exclude, item.catalogId] });
    }
  };
  const setTier = (item: Item, tier: 'core' | 'optional') =>
    onChange({ priorityOverrides: { ...state.priorityOverrides, [item.catalogId]: tier } });
  const setExamDate = (catalogId: string, date: string, start: string) => {
    const others = state.examDates.filter((e) => e.catalogId !== catalogId);
    onChange({ examDates: date ? [...others, { catalogId, date, start }] : others });
  };

  const rows: RowProps = { tasks, state, remove, setTier, setExamDate };

  return (
    <div className="space-y-8">
      <div role="status" aria-live="polite" className="min-h-6 text-muted empty:hidden">
        {updating ? (
          <span className="inline-flex items-center gap-2">
            <ClockIcon />
            Updating the draft…
          </span>
        ) : null}
      </div>
      {query.isError ? <ErrorText>{describeBuildError(query.error)}</ErrorText> : null}

      <section aria-labelledby="draft-summary" className="space-y-3">
        <Heading id="draft-summary">Here is what I understood</Heading>
        <p className="text-muted">
          These are estimates. Hours come from the catalog, and the dates come from your study days.
          Nothing is created until you press Start this plan.
        </p>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt className="font-bold">Study time</dt>
          <dd className="tabular-nums">{formatHours(summary.totalHours)} in total</dd>
          <dt className="font-bold">Finish</dt>
          <dd>
            {summary.finishDate ? formatDate(summary.finishDate) : 'Nothing is scheduled'}
            {' · your finish date is '}
            {formatDate(summary.deadline)}
          </dd>
          <dt className="font-bold">Cost</dt>
          <dd className="space-y-1">
            {costLines(summary.cost).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </dd>
          <dt className="font-bold">Certificates</dt>
          <dd>
            {summary.certificatesIncluded.length > 0
              ? `${summary.certificatesIncluded.length} included`
              : 'None included'}
          </dd>
          <dt className="font-bold">Skills</dt>
          <dd>
            {summary.skillsCovered.length} of {summary.skillsAsked} covered
            {summary.skillsAlreadyCovered.length > 0
              ? `, ${summary.skillsAlreadyCovered.length} you already have`
              : ''}
          </dd>
        </dl>
        {draft.fits ? (
          <p className="flex items-start gap-2 font-bold">
            <CheckIcon />
            <span>This fits before your finish date.</span>
          </p>
        ) : (
          <p className="flex items-start gap-2 font-bold text-warn">
            <AlertIcon />
            <span>This does not fit before your finish date. Choose one of the options below.</span>
          </p>
        )}
        {summary.skillsNotCovered.length > 0 ? (
          <div className="space-y-1">
            <p className="font-bold">Gaps the catalog cannot fill</p>
            <ul className="list-disc pl-6">
              {summary.skillsNotCovered.map((s) => (
                <li key={s.skillId}>
                  {s.name || skillName(s.skillId)}
                  {s.reason === 'catalog_gap'
                    ? ': no suitable item in the catalog'
                    : s.reason === 'dropped_to_fit_time'
                      ? ': dropped to fit your time'
                      : ': dropped to fit your budget'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {!draft.fits && draft.options ? (
        <FitOptions draft={draft} state={state} onChange={onChange} />
      ) : null}

      {draft.overBudget ? (
        <section aria-labelledby="over-budget" className="space-y-2">
          <Heading id="over-budget">Over your budget</Heading>
          <p className="flex items-start gap-2 font-bold text-warn">
            <AlertIcon />
            <span>The known prices are above your limit. Remove these items to get within it.</span>
          </p>
          <ul className="list-disc pl-6">
            {draft.removeToFit.map((id) => (
              <li key={id}>{draft.items.find((i) => i.catalogId === id)?.title ?? id}</li>
            ))}
          </ul>
          <Button
            onClick={() =>
              onChange({ exclude: [...new Set([...state.exclude, ...draft.removeToFit])] })
            }
          >
            Remove them to fit my budget
          </Button>
        </section>
      ) : null}

      {draft.items.length === 0 ? (
        <p className="font-bold">
          The catalog has nothing for these choices. Go back and change the role, the budget or the
          skills.
        </p>
      ) : null}
      <ItemSection id="items-core" title="Core" items={core} rows={rows} />
      <ItemSection id="items-optional" title="Optional" items={optional} rows={rows} />

      {summary.certificatesOffered.length > 0 ? (
        <section aria-labelledby="certs-offered" className="space-y-2">
          <Heading id="certs-offered">Certificates you can add</Heading>
          <ul className="divide-y divide-border">
            {summary.certificatesOffered.map((c) => (
              <li key={c.catalogId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
                <div className="min-w-0 grow basis-60">
                  <p className="font-bold">{c.title}</p>
                  <p className="text-muted">
                    {c.provider} ·{' '}
                    {c.price === null
                      ? 'Price varies – check'
                      : `${money(c.price)}${c.priceVerified ? '' : ' (price not checked)'}`}
                  </p>
                </div>
                <Button
                  onClick={() =>
                    onChange({
                      certificateOptIns: [...new Set([...state.certificateOptIns, c.catalogId])],
                    })
                  }
                >
                  Include this exam<span className="sr-only">: {c.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {draft.skippedPrerequisites.length > 0 ? (
        <section aria-labelledby="skipped" className="space-y-1">
          <Heading id="skipped">Skipped</Heading>
          <ul className="list-disc pl-6">
            {draft.skippedPrerequisites.map((s) => (
              <li key={s.catalogId}>{s.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {draft.excluded.length > 0 ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center font-bold">
            Left out ({draft.excluded.length})
          </summary>
          <ul className="list-disc space-y-1 pl-6 pt-2">
            {draft.excluded.map((e) => (
              <li key={`${e.catalogId}-${e.reason}`}>
                <span className="font-bold">{EXCLUDED_REASON_TEXT[e.reason] ?? e.reason}:</span>{' '}
                {e.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {draft.warnings.length > 0 ? (
        <section aria-labelledby="warnings" className="space-y-1">
          <Heading id="warnings">Things to know</Heading>
          <ul className="list-disc pl-6">
            {draft.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The three ways to make a plan fit. None is applied by itself: each button edits the request
 * (the items to leave out, the hours per study day, the finish date) and the preview runs again.
 */
function FitOptions({
  draft,
  state,
  onChange,
}: {
  draft: BuildDraft;
  state: BuilderState;
  onChange: (patch: Partial<BuilderState>) => void;
}): ReactNode {
  const options = draft.options;
  if (!options) return null;
  const { essentials, hoursPerDay, finishOn } = options;
  return (
    <section aria-labelledby="fit-options" className="space-y-3">
      <h3 id="fit-options" className="text-lg font-bold">
        Make it fit
      </h3>
      <ul className="space-y-4">
        <li className="space-y-1">
          <p className="font-bold">Keep only the essentials</p>
          {essentials.possible ? (
            <>
              <p className="text-muted">
                Leaves out {essentials.droppedItemIds.length}{' '}
                {essentials.droppedItemIds.length === 1 ? 'item' : 'items'}
                {essentials.lostSkillIds.length > 0
                  ? `. You would lose: ${essentials.lostSkillIds.map(skillName).join(', ')}.`
                  : '.'}
              </p>
              <Button
                onClick={() =>
                  onChange({
                    exclude: [...new Set([...state.exclude, ...essentials.droppedItemIds])],
                  })
                }
              >
                Keep only the essentials
              </Button>
            </>
          ) : (
            <p className="text-muted">Not possible: dropping items would not make it fit.</p>
          )}
        </li>
        <li className="space-y-1">
          <p className="font-bold">Study more hours a day</p>
          {hoursPerDay.value !== null ? (
            <>
              <p className="text-muted">
                {formatHours(hoursPerDay.value)} a day would fit. This applies to every study day.
              </p>
              <Button onClick={() => onChange({ hours: String(hoursPerDay.value) })}>
                Study {formatHours(hoursPerDay.value)} a day
              </Button>
            </>
          ) : (
            <p className="text-muted">Not possible within your study window.</p>
          )}
        </li>
        <li className="space-y-1">
          <p className="font-bold">Finish later</p>
          {finishOn.date ? (
            <>
              <p className="text-muted">
                With your current hours it finishes on {formatDate(finishOn.date)}.
              </p>
              <Button onClick={() => onChange({ deadline: finishOn.date! })}>
                Finish on {formatDate(finishOn.date)}
              </Button>
            </>
          ) : (
            <p className="text-muted">It does not finish within two years at these hours.</p>
          )}
        </li>
      </ul>
    </section>
  );
}
