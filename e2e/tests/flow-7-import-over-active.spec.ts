import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import { loadDemoPlan } from '../support/ui';

const DEMO = 'Junior Data Analyst (fictional demo plan)';
const SECOND_PLAN = JSON.stringify({
  formatVersion: 1,
  name: 'Second plan from a file',
  startDate: '2026-11-02',
  weekPattern: {
    studyWeekdays: [0, 1, 2, 3, 4],
    defaultHours: 7,
    windowStart: '09:00',
    windowEnd: '17:30',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    timezone: 'Asia/Jerusalem',
  },
  overrides: [],
  tasks: [
    {
      id: 'setup',
      title: 'Set up the study workspace',
      type: 'admin',
      estHours: 0.5,
      order: 1,
      dependsOn: [],
      source: 'import',
    },
  ],
});

/**
 * Importing a plan while another is active archives the active one (ADR 017, ADR 018 B2) and asks
 * first, with the same dialog as the plan builder.
 */
test('import over an active plan: confirm, the old plan is archived and stays readable', async ({
  page,
  user,
  api,
}) => {
  await signIn(page, user);
  await loadDemoPlan(page);

  const listPlans = async () =>
    (
      (await (await api.get('/api/v1/plans')).json()) as {
        plans: { name: string; status: string }[];
      }
    ).plans;

  await test.step('open the import form on the plan page', async () => {
    await page.getByRole('link', { name: 'Plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Plan settings' }).click();
    await page.getByText('Import another plan').click();
    await page.getByRole('textbox', { name: /paste the plan json/i }).fill(SECOND_PLAN);
  });

  await test.step('the confirm names the active plan; cancel changes nothing', async () => {
    await page.getByRole('button', { name: 'Import plan' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(DEMO);
    await expect(dialog).toContainText('will be archived');
    await expectNoA11yViolations(page, 'the archive confirm on import');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await listPlans()).map((p) => p.status)).toEqual(['active']);
  });

  await test.step('confirming imports the new plan and archives the old one', async () => {
    await page.getByRole('button', { name: 'Import plan' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive and import' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Second plan from a file' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('combobox', { name: 'Plan' })
        .getByRole('option', { name: `${DEMO} (Archived)` }),
    ).toHaveCount(1);
    expect((await listPlans()).map((p) => [p.name, p.status]).sort()).toEqual([
      [DEMO, 'archived'],
      ['Second plan from a file', 'active'],
    ]);
  });

  await test.step('the archived plan opens read-only', async () => {
    await page
      .getByRole('combobox', { name: 'Plan' })
      .selectOption({ label: `${DEMO} (Archived)` });
    await expect(page.getByLabel('Archived plan')).toContainText('archived (read-only)');
    // The server enforces it: a write to the archived plan is refused with 409 plan_archived.
    const oldId = (await (await api.get('/api/v1/plans')).json()).plans.find(
      (p: { name: string }) => p.name === DEMO,
    ).id as string;
    const detail = await (await api.get(`/api/v1/plans/${oldId}`)).json();
    const write = await api.put(`/api/v1/plans/${oldId}/week-pattern`, {
      data: detail.weekPattern,
    });
    expect(write.status()).toBe(409);
    expect((await write.json()).error.code).toBe('plan_archived');
  });
});
