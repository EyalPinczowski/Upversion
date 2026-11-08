import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import {
  PLAN_ID,
  planDetail,
  planRoutes,
  previewResult,
  WEEK_PATTERN,
} from '../../test/plan-fixtures';

afterEach(() => vi.unstubAllGlobals());

const BASE = `/api/v1/plans/${PLAN_ID}`;
const SUMMARY = '1 task moved, plan finish pushed back by 1 study day.';

function open(extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(
    planRoutes({ [`POST ${BASE}/schedule/preview`]: () => json(previewResult(SUMMARY)), ...extra }),
  );
  renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
  return api;
}

async function section() {
  const region = await screen.findByRole('region', { name: 'Study time' });
  await within(region).findByRole('spinbutton', { name: 'Hours per study day' });
  return within(region);
}

async function setHours(form: ReturnType<typeof within>, value: string) {
  const user = userEvent.setup();
  const field = form.getByRole('spinbutton', { name: 'Hours per study day' });
  await user.clear(field);
  await user.type(field, value);
  return user;
}

const bodyOf = async (call: Request | undefined) => (call ? await call.clone().json() : undefined);

describe('time settings', () => {
  it('shows the saved week pattern, time zone and day exceptions', async () => {
    open();
    const form = await section();
    for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      expect(form.getByRole('checkbox', { name: day })).toBeChecked();
    }
    expect(form.getByRole('checkbox', { name: 'Friday' })).not.toBeChecked();
    expect(form.getByRole('spinbutton', { name: 'Hours per study day' })).toHaveValue(7);
    expect(form.getByLabelText('Study window starts')).toHaveValue('09:00');
    expect(form.getByLabelText('Study window ends')).toHaveValue('17:30');
    expect(form.getByLabelText('Lunch starts (optional)')).toHaveValue('13:00');
    expect(form.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Asia/Jerusalem');
    expect(form.getByText('Thu, Nov 12')).toBeInTheDocument();
    expect(form.getByText(/Day off/)).toBeInTheDocument();
  });

  it('offers the platform’s time zones, including the plan’s own', async () => {
    open({
      [`GET ${BASE}`]: () =>
        json(planDetail({ weekPattern: { ...WEEK_PATTERN, timezone: 'UTC' } })),
    });
    const form = await section();
    const options = form.getByRole('combobox', { name: 'Time zone' }).querySelectorAll('option');
    const zones = Array.from(options).map((o) => o.value);
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Berlin');
  });

  it('has no accessibility violations', async () => {
    open();
    await section();
    await expectNoAxeViolations();
  });

  it('previews first, shows the summary text, and saves nothing until Approve', async () => {
    const api = open({ [`PUT ${BASE}/week-pattern`]: () => json(WEEK_PATTERN) });
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));

    expect(await form.findByText(SUMMARY)).toBeInTheDocument();
    expect(
      await bodyOf(
        api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/schedule/preview')),
      ),
    ).toEqual({
      pattern: { ...WEEK_PATTERN, defaultHours: 5 },
    });
    expect(form.getByText('Nothing is saved until you approve.')).toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(0);

    await user.click(form.getByRole('button', { name: 'Approve' }));
    expect(
      await form.findByText(/Saved\. Your schedule now uses the new settings/),
    ).toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(1);
    expect(await bodyOf(api.calls.find((c) => c.method === 'PUT'))).toEqual({
      ...WEEK_PATTERN,
      defaultHours: 5,
    });
  });

  describe('hours on specific weekdays (spec 3.7)', () => {
    const THURSDAY_5 = { ...WEEK_PATTERN, hoursByWeekday: { '4': 5 } };

    it('offers one optional field per study weekday, empty by default', async () => {
      open();
      const form = await section();
      const group = form.getByRole('group', { name: 'Hours on specific days (optional)' });
      for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
        const field = within(group).getByRole('spinbutton', { name: `${day} hours` });
        expect(field).toHaveValue(null);
        expect(field).toHaveAttribute('placeholder', '7');
      }
      expect(
        within(group).queryByRole('spinbutton', { name: 'Friday hours' }),
      ).not.toBeInTheDocument();
    });

    it('sets Thursday to 5 hours: preview first, then save the pattern on Approve', async () => {
      const api = open({ [`PUT ${BASE}/week-pattern`]: () => json(THURSDAY_5) });
      const form = await section();
      const user = userEvent.setup();
      await user.type(form.getByRole('spinbutton', { name: 'Thursday hours' }), '5');
      await user.click(form.getByRole('button', { name: 'Preview the change' }));
      await form.findByText(SUMMARY);
      expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
        pattern: THURSDAY_5,
      });
      expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(0);
      await user.click(form.getByRole('button', { name: 'Approve' }));
      await form.findByText(/Saved\./);
      expect(await bodyOf(api.calls.find((c) => c.method === 'PUT'))).toEqual(THURSDAY_5);
    });

    it('shows saved weekday hours, and clearing one removes it from the pattern', async () => {
      const api = open({
        [`GET ${BASE}`]: () => json(planDetail({ weekPattern: THURSDAY_5 })),
      });
      const form = await section();
      const field = form.getByRole('spinbutton', { name: 'Thursday hours' });
      expect(field).toHaveValue(5);
      const user = userEvent.setup();
      await user.clear(field);
      await user.click(form.getByRole('button', { name: 'Preview the change' }));
      await form.findByText(SUMMARY);
      expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
        pattern: { ...WEEK_PATTERN, hoursByWeekday: {} },
      });
    });

    it('changing only the default hours keeps the saved weekday hours', async () => {
      const api = open({
        [`GET ${BASE}`]: () => json(planDetail({ weekPattern: THURSDAY_5 })),
      });
      const form = await section();
      const user = await setHours(form, '6');
      await user.click(form.getByRole('button', { name: 'Preview the change' }));
      await form.findByText(SUMMARY);
      expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
        pattern: { ...THURSDAY_5, defaultHours: 6 },
      });
    });

    it('adds a field when a weekday becomes a study day, and keeps hours of a day switched off', async () => {
      const api = open({
        [`GET ${BASE}`]: () => json(planDetail({ weekPattern: THURSDAY_5 })),
      });
      const form = await section();
      const user = userEvent.setup();
      await user.click(form.getByRole('checkbox', { name: 'Friday' }));
      await user.type(form.getByRole('spinbutton', { name: 'Friday hours' }), '3.5');
      await user.click(form.getByRole('checkbox', { name: 'Thursday' }));
      expect(form.queryByRole('spinbutton', { name: 'Thursday hours' })).not.toBeInTheDocument();
      await user.click(form.getByRole('button', { name: 'Preview the change' }));
      await form.findByText(SUMMARY);
      // Thursday's saved hours are not silently dropped just because the day is off for now.
      expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
        pattern: {
          ...WEEK_PATTERN,
          studyWeekdays: [0, 1, 2, 3, 5],
          hoursByWeekday: { '4': 5, '5': 3.5 },
        },
      });
    });

    it('has no accessibility violations with weekday hours filled in', async () => {
      open({ [`GET ${BASE}`]: () => json(planDetail({ weekPattern: THURSDAY_5 })) });
      await section();
      await expectNoAxeViolations();
    });
  });

  it('Cancel drops the preview and saves nothing', async () => {
    const api = open();
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    await form.findByText(SUMMARY);
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(form.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(form.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE')).toHaveLength(0);
    // The edit is kept, so the person can adjust it or preview again.
    expect(form.getByRole('spinbutton', { name: 'Hours per study day' })).toHaveValue(5);
  });

  it('drops a stale preview when the form is edited again', async () => {
    open();
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    await form.findByText(SUMMARY);
    await user.click(form.getByRole('checkbox', { name: 'Friday' }));
    expect(form.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(form.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('adds a day exception: preview with the override, then PUT it on Approve', async () => {
    const api = open({
      [`PUT ${BASE}/day-overrides/2026-11-15`]: () =>
        json({ date: '2026-11-15', isStudyDay: false }),
    });
    const form = await section();
    const user = userEvent.setup();
    await user.type(form.getByLabelText('Date'), '2026-11-15');
    await user.click(form.getByRole('button', { name: 'Add exception' }));
    expect(form.getByText('Sun, Nov 15')).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    await form.findByText(SUMMARY);
    expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
      overrides: [{ date: '2026-11-15', isStudyDay: false }],
    });
    expect(api.count(`PUT ${BASE}/day-overrides/2026-11-15`)).toBe(0);
    await user.click(form.getByRole('button', { name: 'Approve' }));
    await form.findByText(/Saved\./);
    expect(api.count(`PUT ${BASE}/day-overrides/2026-11-15`)).toBe(1);
    expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(0);
  });

  it('removes a day exception: preview with removeOverrideDates, then DELETE on Approve', async () => {
    const api = open({
      [`DELETE ${BASE}/day-overrides/2026-11-12`]: () => new Response(null, { status: 204 }),
    });
    const form = await section();
    const user = userEvent.setup();
    await user.click(form.getByRole('button', { name: /Remove the exception for Thu, Nov 12/ }));
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    await form.findByText(SUMMARY);
    expect(await bodyOf(api.calls.find((c) => c.url.endsWith('/schedule/preview')))).toEqual({
      removeOverrideDates: ['2026-11-12'],
    });
    expect(api.count(`DELETE ${BASE}/day-overrides/2026-11-12`)).toBe(0);
    await user.click(form.getByRole('button', { name: 'Approve' }));
    await form.findByText(/Saved\./);
    expect(api.count(`DELETE ${BASE}/day-overrides/2026-11-12`)).toBe(1);
  });

  it('does not preview when nothing changed', async () => {
    const api = open();
    const form = await section();
    await userEvent.setup().click(form.getByRole('button', { name: 'Preview the change' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Nothing has changed yet.');
    expect(api.count(`POST ${BASE}/schedule/preview`)).toBe(0);
  });

  it('asks for a number instead of sending a broken pattern', async () => {
    const api = open();
    const form = await section();
    const user = userEvent.setup();
    await user.clear(form.getByRole('spinbutton', { name: 'Hours per study day' }));
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    expect(await form.findByRole('alert')).toHaveTextContent(
      'Enter a number for “Hours per study day”.',
    );
    expect(api.count(`POST ${BASE}/schedule/preview`)).toBe(0);
  });

  it('shows the API’s message when the preview is refused, with no save possible', async () => {
    const api = open({
      [`POST ${BASE}/schedule/preview`]: () =>
        apiError(400, 'bad_request', 'windowEnd must be after windowStart'),
    });
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    expect(await form.findByRole('alert')).toHaveTextContent('The change could not be checked.');
    expect(form.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(0);
  });

  it('shows a 422 reason from the preview', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        apiError(422, 'unprocessable', 'The plan has no week pattern yet.'),
    });
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    expect(await form.findByRole('alert')).toHaveTextContent('The plan has no week pattern yet.');
  });

  it('keeps the proposal and says so when saving fails offline', async () => {
    let calls = 0;
    const api = open({
      [`PUT ${BASE}/week-pattern`]: () => {
        calls += 1;
        if (calls === 1) throw new TypeError('offline');
        return json(WEEK_PATTERN);
      },
    });
    const form = await section();
    const user = await setHours(form, '5');
    await user.click(form.getByRole('button', { name: 'Preview the change' }));
    await form.findByText(SUMMARY);
    await user.click(form.getByRole('button', { name: 'Approve' }));
    expect(await form.findByRole('alert')).toHaveTextContent(
      /Can’t reach the server\. Nothing was saved/,
    );
    expect(form.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await user.click(form.getByRole('button', { name: 'Approve' }));
    await form.findByText(/Saved\./);
    expect(api.count(`PUT ${BASE}/week-pattern`)).toBe(2);
  });

  it('shows no study time without a plan', async () => {
    installApi(planRoutes({ 'GET /api/v1/plans': () => json({ plans: [] }) }));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    expect(await screen.findByText(/No plan yet/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Study time' })).not.toBeInTheDocument();
  });
});
