import type { Task, TaskType } from '../api/client';
import { percent } from '../lib/format';

/** Curriculum order: courses first, then exams, practice, admin and CV work. */
export const GROUP_ORDER: TaskType[] = ['course', 'cert_exam', 'practice', 'admin', 'cv_update'];

export const GROUP_TITLE: Record<TaskType, string> = {
  course: 'Courses',
  cert_exam: 'Exams',
  practice: 'Practice',
  admin: 'Admin',
  cv_update: 'CV',
};

export interface CurriculumGroup {
  type: TaskType;
  title: string;
  tasks: Task[];
  doneHours: number;
  plannedHours: number;
  percent: number;
  certificates: number;
}

/**
 * Tasks grouped by type in a fixed order. Inside a group tasks keep plan order, except that tasks
 * sharing an `externalRef` are pulled next to the first of them. Empty groups are left out.
 */
export function buildCurriculum(tasks: Task[]): CurriculumGroup[] {
  return GROUP_ORDER.flatMap((type) => {
    const ofType = tasks.filter((t) => t.type === type);
    if (ofType.length === 0) return [];
    const ordered: Task[] = [];
    const placed = new Set<string>();
    for (const task of ofType) {
      if (placed.has(task.id)) continue;
      ordered.push(task);
      placed.add(task.id);
      if (task.externalRef) {
        for (const other of ofType) {
          if (!placed.has(other.id) && other.externalRef === task.externalRef) {
            ordered.push(other);
            placed.add(other.id);
          }
        }
      }
    }
    const doneHours = ordered.reduce((sum, t) => sum + t.doneHours, 0);
    const plannedHours = ordered.reduce((sum, t) => sum + t.estHours, 0);
    return [
      {
        type,
        title: GROUP_TITLE[type],
        tasks: ordered,
        doneHours,
        plannedHours,
        percent: percent(doneHours, plannedHours),
        certificates: ordered.filter((t) => t.isCertificate).length,
      },
    ];
  });
}
