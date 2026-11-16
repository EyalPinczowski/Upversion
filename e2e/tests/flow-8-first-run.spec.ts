import type { Page } from '@playwright/test';
import { expect, expectNoA11yViolations, signIn, test } from '../fixtures';
import { switchToFirstRunApi } from '../support/first-run';

/** Optional: E2E_SCREENSHOT_DIR=/some/folder saves one picture per screen (for the pull request). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/first-run-${name}.png`, fullPage: true });
}

async function expectNoSidewaysScroll(page: Page, screen: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `no sideways scroll on ${screen}`).toBeLessThanOrEqual(0);
}

/**
 * ADR 018, first run: a person with no plan is taken through four screens (goal, where you are
 * now, time and money, the draft) and ends on Today with a built plan.
 */
test('first run: four screens from sign-in to a built plan on Today', async ({
  page,
  user,
  api,
}) => {
  await signIn(page, user);
  await switchToFirstRunApi(page);
  // The first run is checked at a phone width (360 px).
  await page.setViewportSize({ width: 360, height: 800 });

  await test.step('after the Terms a new person lands on screen 1', async () => {
    await page.goto('/');
    await page
      .getByLabel('I have read and accept the Terms of Use and the Privacy Policy.')
      .check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(
      page.getByRole('heading', { level: 2, name: 'What are you aiming for?' }),
    ).toBeVisible();
    await expect(page.getByText('Step 1 of 4: What are you aiming for?')).toBeVisible();
    // The welcome tour is replaced: no dialog.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoA11yViolations(page, 'first run, screen 1');
    await expectNoSidewaysScroll(page, 'first run, screen 1');
    await shot(page, '1');
  });

  await test.step('screen 1 needs a role, then screen 2 shows the levels', async () => {
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose at least one role.')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Operations Associate / Analyst' }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Where are you now?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pre-fill from my CV' })).toBeVisible();
    await page.getByLabel('Excel & spreadsheets').selectOption('2');
    await expectNoA11yViolations(page, 'first run, screen 2');
    await expectNoSidewaysScroll(page, 'first run, screen 2');
    await shot(page, '2');
  });

  await test.step('Back keeps the choices, and the step is in the address', async () => {
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/step=1/);
    await expect(
      page.getByRole('checkbox', { name: 'Operations Associate / Analyst' }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByLabel('Excel & spreadsheets')).toHaveValue('2');
  });

  await test.step('screen 3 asks for time and money', async () => {
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'How much time and money?' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '12 weeks' }).click();
    await expectNoA11yViolations(page, 'first run, screen 3');
    await expectNoSidewaysScroll(page, 'first run, screen 3');
    await shot(page, '3');
    await page.getByRole('button', { name: 'Next' }).click();
  });

  await test.step('screen 4 shows the draft and starts the plan', async () => {
    await expect(page.getByRole('heading', { level: 2, name: 'Your draft plan' })).toBeVisible();
    const start = page.getByRole('button', { name: 'Start this plan' });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await expectNoA11yViolations(page, 'first run, screen 4');
    await expectNoSidewaysScroll(page, 'first run, screen 4');
    await shot(page, '4');
    await start.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Step \d of 4/)).toHaveCount(0);
  });

  await test.step('the plan is stored, and a reload stays on Today', async () => {
    const response = await api.get('/api/v1/plans');
    expect(response.ok()).toBe(true);
    const { plans } = (await response.json()) as { plans: { status: string }[] };
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe('active');
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByText(/Step \d of 4/)).toHaveCount(0);
  });
});
