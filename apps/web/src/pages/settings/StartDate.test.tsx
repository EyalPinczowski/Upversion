import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import { PLAN_ID, planDetail, planRoutes } from '../../test/plan-fixtures';

// Noon in Jerusalem (UTC+2) on 2026-11-05: that is "today" for the plan's time zone.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BASE = `/api/v1/plans/${PLAN_ID}`;

function open(extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(planRoutes(extra));
  renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
  return api;
}

async function startDateForm() {
  const region = await screen.findByRole('region', { name: 'Study time' });
  const form = await within(region).findByRole('form', { name: 'Start date' });
  return within(form);
}

describe('plan start date', () => {
  it('shows the current date, the earliest allowed day and what it does', async () => {
    open();
    const form = await startDateForm();
    const field = form.getByLabelText('Plan start date');
    expect(field).toHaveValue('2026-11-03');
    expect(field).toHaveAttribute('min', '2026-11-05');
    expect(field).toHaveAttribute('max', '2026-11-26');
    expect(form.getByText(/Moves the whole schedule/)).toBeInTheDocument();
    expect(form.getByText(/Earliest allowed: .*Nov 5/)).toBeInTheDocument();
  });

  it('explains that the start date is fixed once a study day has begun', async () => {
    open();
    const form = await startDateForm();
    expect(
      form.getByText(
        'The start date can only be moved while the plan has not started; once a study day has begun it is fixed.',
      ),
    ).toBeInTheDocument();
  });

  it('saves the new date with PUT and confirms', async () => {
    let body: unknown;
    const api = open({
      [`PUT ${BASE}/start-date`]: async (request) => {
        body = await request.json();
        return json({ startDate: '2026-11-10', endDate: '2026-11-26' });
      },
    });
    const form = await startDateForm();
    const field = form.getByLabelText('Plan start date');
    fireDate(field, '2026-11-10');
    await userEvent.setup().click(form.getByRole('button', { name: 'Save start date' }));
    expect(await screen.findByText(/Your schedule now starts on .*Nov 10/)).toBeInTheDocument();
    expect(body).toEqual({ startDate: '2026-11-10' });
    expect(api.count(`PUT ${BASE}/start-date`)).toBe(1);
  });

  it('refuses a day before the earliest and a day after the end date without calling the API', async () => {
    const api = open();
    const form = await startDateForm();
    const user = userEvent.setup();
    const field = form.getByLabelText('Plan start date');
    fireDate(field, '2026-11-04');
    await user.click(form.getByRole('button', { name: 'Save start date' }));
    expect(form.getByText(/Choose .*Nov 5.* or a later day/)).toBeInTheDocument();
    fireDate(field, '2026-11-27');
    await user.click(form.getByRole('button', { name: 'Save start date' }));
    expect(form.getByText(/can’t be after the end date/)).toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/start-date`)).toBe(0);
  });

  it('sends nothing when the date has not changed', async () => {
    const api = open();
    const form = await startDateForm();
    await userEvent.setup().click(form.getByRole('button', { name: 'Save start date' }));
    expect(form.getByText('That is already the start date.')).toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/start-date`)).toBe(0);
  });

  it('shows the API’s message when it refuses', async () => {
    open({
      [`PUT ${BASE}/start-date`]: () =>
        apiError(422, 'unprocessable', 'The start date cannot be before today (2026-11-05).'),
    });
    const form = await startDateForm();
    fireDate(form.getByLabelText('Plan start date'), '2026-11-10');
    await userEvent.setup().click(form.getByRole('button', { name: 'Save start date' }));
    expect(await form.findByRole('alert')).toHaveTextContent('cannot be before today');
  });

  it('shows the API’s explanation when a day has already started', async () => {
    open({
      [`PUT ${BASE}/start-date`]: () =>
        apiError(
          409,
          'day_started',
          'The plan already has a day on 2026-11-03, so it can’t start later than that.',
        ),
    });
    const form = await startDateForm();
    fireDate(form.getByLabelText('Plan start date'), '2026-11-10');
    await userEvent.setup().click(form.getByRole('button', { name: 'Save start date' }));
    expect(await form.findByRole('alert')).toHaveTextContent('already has a day on 2026-11-03');
  });

  it('has no accessibility violations', async () => {
    open({ [`GET ${BASE}`]: () => json(planDetail()) });
    await startDateForm();
    await expectNoAxeViolations();
  });
});

/** Sets a date input the way a browser does (user-event cannot type into date fields reliably). */
function fireDate(field: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
