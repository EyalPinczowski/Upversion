import { describe, expect, it } from 'vitest';
import { taskView } from '../test/plan-fixtures';
import { buildCurriculum } from './curriculum';

describe('buildCurriculum', () => {
  it('orders groups course, exam, practice, admin, CV and leaves empty ones out', () => {
    const groups = buildCurriculum([
      taskView({ id: 'cv', type: 'cv_update' }),
      taskView({ id: 'ad', type: 'admin' }),
      taskView({ id: 'pr', type: 'practice' }),
      taskView({ id: 'ex', type: 'cert_exam' }),
      taskView({ id: 'co', type: 'course' }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Courses', 'Exams', 'Practice', 'Admin', 'CV']);
    expect(buildCurriculum([taskView({ type: 'admin' })]).map((g) => g.type)).toEqual(['admin']);
  });

  it('sums hours, rounds the percentage and counts certificates', () => {
    const [group] = buildCurriculum([
      taskView({ id: 'a', estHours: 4, doneHours: 1, isCertificate: true }),
      taskView({ id: 'b', estHours: 2, doneHours: 2, isCertificate: true }),
      taskView({ id: 'c', estHours: 0, doneHours: 0 }),
    ]);
    expect(group).toMatchObject({
      doneHours: 3,
      plannedHours: 6,
      percent: 50,
      certificatesEarned: 0,
      certificatesTotal: 2,
    });
  });

  it('leaves skipped tasks out of planned hours and certificate totals', () => {
    const [group] = buildCurriculum([
      taskView({ id: 'a', estHours: 4, doneHours: 4, status: 'done', isCertificate: true }),
      taskView({ id: 'b', estHours: 6, doneHours: 0, status: 'skipped', isCertificate: true }),
      taskView({ id: 'c', estHours: 2, doneHours: 0, status: 'pending' }),
    ]);
    expect(group).toMatchObject({
      doneHours: 4,
      plannedHours: 6,
      percent: 67,
      certificatesEarned: 1,
      certificatesTotal: 1,
    });
  });

  it('reaches 100% when everything that is not skipped is done', () => {
    const [group] = buildCurriculum([
      taskView({ id: 'a', estHours: 3, doneHours: 3, status: 'done', isCertificate: true }),
      taskView({ id: 'b', estHours: 5, doneHours: 0, status: 'skipped' }),
    ]);
    expect(group).toMatchObject({ plannedHours: 3, percent: 100, certificatesEarned: 1 });
  });

  it('keeps tasks that share an externalRef next to each other, otherwise plan order', () => {
    const [group] = buildCurriculum([
      taskView({ id: 'a1', externalRef: 'A' }),
      taskView({ id: 'b1', externalRef: 'B' }),
      taskView({ id: 'a2', externalRef: 'A' }),
      taskView({ id: 'x' }),
      taskView({ id: 'b2', externalRef: 'B' }),
    ]);
    expect(group!.tasks.map((t) => t.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'x']);
  });
});
