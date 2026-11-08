import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { fakeAuth, installApi, json, renderApp, SESSION } from '../test/helpers';
import { PLAN_ID, planRoutes, taskView } from '../test/plan-fixtures';

afterEach(() => vi.unstubAllGlobals());

function open(path: string, extra: Parameters<typeof planRoutes>[0] = {}) {
  installApi(planRoutes(extra));
  const urls: string[] = [];
  renderApp({ auth: fakeAuth(SESSION), path, onLocation: (url) => urls.push(url) });
  return { url: () => urls[urls.length - 1] };
}

const tab = (name: string) => screen.findByRole('tab', { name });

describe('plan tabs', () => {
  it('opens on Curriculum by default and names the panel after its tab', async () => {
    const { url } = open('/plan');
    const curriculum = await tab('Curriculum');
    expect(curriculum).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Plan settings' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    const panel = screen.getByRole('tabpanel', { name: 'Curriculum' });
    expect(curriculum).toHaveAttribute('aria-controls', panel.id);
    expect(url()).toBe('/plan');
    expect(await screen.findByRole('heading', { name: 'Courses' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Study time' })).not.toBeInTheDocument();
  });

  it('opens Plan settings from ?tab=settings and puts the tab in the URL on click', async () => {
    const { url } = open('/plan?tab=settings');
    expect(await tab('Plan settings')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Study time' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Courses' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Curriculum' }));
    expect(url()).toBe('/plan');
    await user.click(screen.getByRole('tab', { name: 'Plan settings' }));
    expect(url()).toBe('/plan?tab=settings');
  });

  it('has one tab stop and moves with the arrow keys, Home and End', async () => {
    const { url } = open('/plan');
    const curriculum = await tab('Curriculum');
    const settings = screen.getByRole('tab', { name: 'Plan settings' });
    expect(curriculum).toHaveAttribute('tabindex', '0');
    expect(settings).toHaveAttribute('tabindex', '-1');

    const user = userEvent.setup();
    curriculum.focus();
    await user.keyboard('{ArrowRight}');
    expect(settings).toHaveFocus();
    expect(settings).toHaveAttribute('aria-selected', 'true');
    expect(settings).toHaveAttribute('tabindex', '0');
    expect(url()).toBe('/plan?tab=settings');
    await user.keyboard('{ArrowRight}');
    expect(curriculum).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(settings).toHaveFocus();
    await user.keyboard('{Home}');
    expect(curriculum).toHaveFocus();
    expect(curriculum).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(settings).toHaveFocus();
  });

  it('has no accessibility violations on either tab', async () => {
    open('/plan');
    await screen.findByRole('heading', { name: 'Courses' });
    await expectNoAxeViolations();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Plan settings' }));
    await screen.findByRole('heading', { name: 'Study time' });
    await expectNoAxeViolations();
  });
});

describe('curriculum tab', () => {
  it('groups tasks by type with hours, a progress bar with text, and certificates', async () => {
    open('/plan');
    const courses = within(
      (await screen.findByRole('heading', { name: 'Courses' })).closest('section')!,
    );
    expect(courses.getByText('1 h of 3 h done (33%)')).toBeInTheDocument();
    expect(courses.getByText('1 certificate')).toBeInTheDocument();
    expect(courses.getByRole('progressbar', { name: 'Courses progress' })).toHaveAttribute(
      'aria-valuenow',
      '33',
    );
    expect(courses.getByRole('link', { name: 'Intro to SQL' })).toBeInTheDocument();
    expect(courses.getByRole('button', { name: 'Delete task: Intro to SQL' })).toBeInTheDocument();

    const admin = within(screen.getByRole('heading', { name: 'Admin' }).closest('section')!);
    expect(admin.getByText('0.5 h of 0.5 h done (100%)')).toBeInTheDocument();
    expect(admin.getByText('0 certificates')).toBeInTheDocument();

    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Courses',
      'Exams',
      'Admin',
    ]);
  });

  it('keeps tasks that share an externalRef adjacent inside a group', async () => {
    open('/plan', {
      [`GET /api/v1/plans/${PLAN_ID}/tasks`]: () =>
        json({
          tasks: [
            taskView({ id: 'a1', title: 'First A', externalRef: 'A', order: 0 }),
            taskView({ id: 'b1', title: 'First B', externalRef: 'B', order: 1 }),
            taskView({ id: 'a2', title: 'Second A', externalRef: 'A', order: 2 }),
          ],
        }),
    });
    const group = within(
      (await screen.findByRole('heading', { name: 'Courses' })).closest('section')!,
    );
    const titles = group.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(titles).toEqual(['First A', 'Second A', 'First B']);
  });
});

describe('plan settings tab', () => {
  it('holds study time, start date, practice, subjects and manage plans', async () => {
    open('/plan?tab=settings');
    for (const name of ['Study time', 'Practice', 'Subjects', 'Manage plans']) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(await screen.findByRole('heading', { name: 'Start date' })).toBeInTheDocument();
    const subjects = within(screen.getByRole('heading', { name: 'Subjects' }).closest('section')!);
    expect(subjects.getByText('Courses')).toBeInTheDocument();
    expect(subjects.getByText('3 h planned')).toBeInTheDocument();
    expect(subjects.getByText('Editing subjects is not available yet.')).toBeInTheDocument();
    expect(subjects.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete this plan' })).toBeInTheDocument();
  });
});
