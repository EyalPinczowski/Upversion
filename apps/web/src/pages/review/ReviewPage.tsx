import { useCallback, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useBriefing } from '../../api/briefing-hooks';
import { useTasks } from '../../api/hooks';
import { useReview, type ReviewResult } from '../../api/review-hooks';
import { QueryView } from '../../components/QueryView';
import { linkClass } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useReadOnlyPlan } from '../../plan/context';
import { PlanGate } from '../../plan/PlanGate';
import { validDate } from '../briefing/day-utils';
import { DayQueryView } from '../briefing/DayQueryView';
import { DayPractice } from '../practice-trends/DayPractice';
import { ReviewForm, type ReviewRow } from './ReviewForm';
import { ReviewTrend } from './ReviewTrend';
import { SavedReview } from './SavedReview';
import { SuggestionsPanel } from './SuggestionsPanel';

function ReviewContent({ planId, date }: { planId: string; date: string }) {
  const briefing = useBriefing(planId, date);
  const review = useReview(planId, date);
  const tasks = useTasks(planId);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const readOnly = useReadOnlyPlan();

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks.data?.tasks ?? []) map.set(t.id, t.title);
    for (const t of briefing.data?.tasks ?? []) map.set(t.taskId, t.title);
    return map;
  }, [tasks.data, briefing.data]);
  const titleOf = useCallback((id: string) => titles.get(id) ?? id, [titles]);

  return (
    <>
      <DayQueryView query={briefing} label="Loading the day…" what="review">
        {(day) => (
          <QueryView query={review} label="Loading your review…">
            {(stored) => {
              // The day's tasks, plus any task an earlier review of this day recorded an answer for.
              const rows: ReviewRow[] = day.tasks.map((t) => ({
                id: t.taskId,
                title: t.title,
                type: t.type,
              }));
              const taskType = new Map((tasks.data?.tasks ?? []).map((t) => [t.id, t.type]));
              // A task that was deleted since must not be sent again: the API refuses outcomes for
              // tasks that are not in the plan.
              const existing = tasks.data ? new Set(tasks.data.tasks.map((t) => t.id)) : null;
              for (const o of stored?.outcomes ?? []) {
                if (existing && !existing.has(o.taskId)) continue;
                if (!rows.some((r) => r.id === o.taskId)) {
                  rows.push({
                    id: o.taskId,
                    title: titleOf(o.taskId),
                    type: taskType.get(o.taskId),
                  });
                }
              }
              return (
                <>
                  {readOnly ? (
                    <p className="font-bold">
                      This plan is archived (read-only), so the review can’t be changed.
                    </p>
                  ) : (
                    <ReviewForm
                      planId={planId}
                      date={date}
                      rows={rows}
                      initial={stored}
                      onSaved={setResult}
                    />
                  )}
                  {result ? (
                    <SavedReview planId={planId} date={date} result={result} titleOf={titleOf} />
                  ) : null}
                </>
              );
            }}
          </QueryView>
        )}
      </DayQueryView>
      <DayPractice planId={planId} date={date} titleOf={titleOf} />
      {readOnly ? null : <SuggestionsPanel planId={planId} titleOf={titleOf} />}
      <ReviewTrend planId={planId} date={date} />
    </>
  );
}

/** /review/:date: the end-of-day review, the plan suggestions it leads to, and the recent trend. */
export function ReviewPage() {
  const { date: param } = useParams();
  const date = validDate(param);
  if (!date) return <Navigate to="/" replace />;
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <Link to="/" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Today
        </Link>
        <h1>End-of-day review</h1>
        <p className="text-h2 font-bold">{formatDate(date)}</p>
        <p>
          <Link
            to={`/briefing/${date}`}
            className={`${linkClass} inline-flex min-h-11 items-center`}
          >
            See the briefing for this day
          </Link>
        </p>
      </div>
      <PlanGate empty={<p className="text-muted">There is no plan yet. Import one on Today.</p>}>
        {(plan) => <ReviewContent planId={plan.id} date={date} />}
      </PlanGate>
    </div>
  );
}
