import type { Page } from '@playwright/test';
import { API_FIRST_RUN_URL, API_URL } from './env';

/**
 * Sends every API call of the page to the API process that has FEATURE_PROFILE_SETUP and
 * FEATURE_PLAN_BUILDER on, from now on. The database is shared, so the plans it creates show on
 * the main API too.
 */
export async function switchToFirstRunApi(page: Page): Promise<void> {
  await page.route(`${API_URL}/**`, (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `${API_FIRST_RUN_URL}${url.pathname}${url.search}` });
  });
}
