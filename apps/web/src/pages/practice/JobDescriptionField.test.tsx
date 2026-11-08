import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf } from '../../test/day-fixtures';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import { BASE, practiceRoutes } from '../../test/practice-fixtures';

const CONTEXT = `${BASE}/practice/context`;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function openSettings(extra: Parameters<typeof practiceRoutes>[0] = {}) {
  const api = installApi(practiceRoutes(extra));
  renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
  return api;
}

describe('Job description in plan settings', () => {
  it('shows the saved text and saves a change through the API only', async () => {
    const user = userEvent.setup();
    const api = openSettings({
      [`GET ${CONTEXT}`]: () =>
        json({ jobDescription: 'Data analyst', updatedAt: '2026-11-01T08:00:00.000Z' }),
      [`PUT ${CONTEXT}`]: () =>
        json({
          jobDescription: 'Data analyst, SQL',
          updatedAt: '2026-11-02T08:00:00.000Z',
          redactionsPreview: 0,
        }),
    });
    const field = await screen.findByLabelText('Job description');
    expect(field).toHaveValue('Data analyst');
    const save = screen.getByRole('button', { name: 'Save job description' });
    expect(save).toBeDisabled();

    await user.type(field, ', SQL');
    await user.click(save);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const put = api.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/practice/context'))!;
    expect(await bodyOf(put)).toEqual({ jobDescription: 'Data analyst, SQL' });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('tells how many personal details will be removed', async () => {
    const user = userEvent.setup();
    openSettings({
      [`PUT ${CONTEXT}`]: () =>
        json({
          jobDescription: 'Mail jobs@example.com',
          updatedAt: '2026-11-02T08:00:00.000Z',
          redactionsPreview: 2,
        }),
    });
    await user.type(await screen.findByLabelText('Job description'), 'Mail jobs@example.com');
    await user.click(screen.getByRole('button', { name: 'Save job description' }));
    expect(await screen.findByText(/2 personal details will be removed/)).toBeInTheDocument();
  });

  it('removes the job description by saving an empty one', async () => {
    const user = userEvent.setup();
    const api = openSettings({
      [`GET ${CONTEXT}`]: () =>
        json({ jobDescription: 'Data analyst', updatedAt: '2026-11-01T08:00:00.000Z' }),
      [`PUT ${CONTEXT}`]: () =>
        json({ jobDescription: '', updatedAt: '2026-11-02T08:00:00.000Z', redactionsPreview: 0 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Remove job description' }));
    expect(await screen.findByText('Job description removed.')).toBeInTheDocument();
    const put = api.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/practice/context'))!;
    expect(await bodyOf(put)).toEqual({ jobDescription: '' });
    expect(screen.getByLabelText('Job description')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove job description' })).toBeNull();
  });

  it('says why a save failed, in words', async () => {
    const user = userEvent.setup();
    openSettings({
      [`PUT ${CONTEXT}`]: () =>
        apiError(422, 'invalid_text', 'The text contains characters that can’t be saved.'),
    });
    await user.type(await screen.findByLabelText('Job description'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save job description' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('characters that can’t be saved');
  });

  it('has no accessibility violations', async () => {
    openSettings();
    await screen.findByLabelText('Job description');
    await expectNoAxeViolations();
  });
});
