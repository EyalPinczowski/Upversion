import { useTasks } from '../api/hooks';
import { QueryView } from '../components/QueryView';
import { formatHours } from '../lib/format';
import { buildCurriculum } from './curriculum';

/** Read-only: the curriculum groups with their planned hours. */
export function SubjectsList({ planId }: { planId: string }) {
  const tasks = useTasks(planId);
  return (
    <section
      aria-labelledby="subjects-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id="subjects-heading">Subjects</h3>
      <QueryView query={tasks} label="Loading your subjects…">
        {({ tasks: list }) => (
          <ul className="space-y-1">
            {buildCurriculum(list).map((group) => (
              <li key={group.type} className="flex justify-between gap-3 tabular-nums">
                <span>{group.title}</span>
                <span className="text-muted">{formatHours(group.plannedHours)} planned</span>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
      <p className="text-sm text-muted">Editing subjects is not available yet.</p>
    </section>
  );
}
