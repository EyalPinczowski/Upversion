import { Link } from 'react-router';
import type { Task } from '../api/client';
import { useTasks } from '../api/hooks';
import { DeleteTask } from '../components/DeleteTask';
import { QueryView } from '../components/QueryView';
import { TaskStatusLabel, TaskTypeChip } from '../components/TaskChips';
import { linkClass } from '../components/ui';
import { formatHours } from '../lib/format';
import { anchorText, dependencyText } from '../lib/task-text';
import { TASK_TYPE_META } from '../lib/task-types';
import { buildCurriculum, type CurriculumGroup } from './curriculum';

function TaskRow({
  planId,
  task,
  titleOf,
  onDeleted,
}: {
  planId: string;
  task: Task;
  titleOf: (id: string) => string;
  onDeleted: () => void;
}) {
  const deps = dependencyText(task, titleOf);
  const anchor = anchorText(task);
  return (
    <li
      className={`space-y-2 rounded-md border border-l-4 border-border bg-surface p-4 ${TASK_TYPE_META[task.type].strip}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TaskTypeChip type={task.type} />
        <TaskStatusLabel status={task.status} />
        <span className="ml-auto text-muted tabular-nums">
          {formatHours(task.doneHours)} of {formatHours(task.estHours)}
        </span>
      </div>
      <h4 className="text-lg font-bold">
        <Link
          to={`/plan/${encodeURIComponent(task.id)}`}
          className={`${linkClass} inline-block min-h-11 py-2`}
        >
          {task.title}
        </Link>
      </h4>
      {anchor ? <p className="font-bold">{anchor}</p> : null}
      {deps ? <p className="text-muted">{deps}</p> : null}
      <DeleteTask planId={planId} task={task} onDeleted={onDeleted} />
    </li>
  );
}

function certificateText(count: number): string {
  return `${count} ${count === 1 ? 'certificate' : 'certificates'}`;
}

function GroupSection({
  planId,
  group,
  titleOf,
  onTaskDeleted,
}: {
  planId: string;
  group: CurriculumGroup;
  titleOf: (id: string) => string;
  onTaskDeleted: () => void;
}) {
  const headingId = `group-${group.type}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId}>{group.title}</h3>
      <div className="space-y-1">
        <div
          role="progressbar"
          aria-label={`${group.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={group.percent}
          aria-valuetext={`${group.percent} percent, ${formatHours(group.doneHours)} of ${formatHours(group.plannedHours)} done`}
          className="h-3 overflow-hidden rounded-full bg-surface-2"
        >
          <div className="h-full bg-accent" style={{ width: `${group.percent}%` }} />
        </div>
        <p className="flex flex-wrap gap-x-4 text-sm text-muted tabular-nums">
          <span>
            {formatHours(group.doneHours)} of {formatHours(group.plannedHours)} done (
            {group.percent}%)
          </span>
          <span>{certificateText(group.certificates)}</span>
        </p>
      </div>
      <ul className="space-y-3">
        {group.tasks.map((task) => (
          <TaskRow
            key={task.id}
            planId={planId}
            task={task}
            titleOf={titleOf}
            onDeleted={onTaskDeleted}
          />
        ))}
      </ul>
    </section>
  );
}

/** Every task of the plan, grouped by type. */
export function Curriculum({
  planId,
  onTaskDeleted,
}: {
  planId: string;
  onTaskDeleted: () => void;
}) {
  const tasks = useTasks(planId);
  return (
    <QueryView query={tasks} label="Loading your tasks…">
      {({ tasks: list }) => {
        const titleOf = (id: string) => list.find((t) => t.id === id)?.title ?? id;
        return (
          <section aria-label="Curriculum" className="space-y-4">
            <p className="text-muted">{list.length} tasks</p>
            {buildCurriculum(list).map((group) => (
              <GroupSection
                key={group.type}
                planId={planId}
                group={group}
                titleOf={titleOf}
                onTaskDeleted={onTaskDeleted}
              />
            ))}
          </section>
        );
      }}
    </QueryView>
  );
}
