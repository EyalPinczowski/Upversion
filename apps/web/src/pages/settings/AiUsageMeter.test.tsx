import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { fakeAuth, installApi, json, meBody, renderApp, SESSION } from '../../test/helpers';
import type { AiUsage } from '../../api/ai-hooks';
import { meterModel } from './meter-model';

const usage = (messagesUsed: number, overrides: Partial<AiUsage> = {}): AiUsage => ({
  day: '2026-11-10',
  resetsAt: '2026-11-11T00:00:00.000Z',
  configured: true,
  user: {
    practiceMessages: { used: messagesUsed, cap: 30 },
    practiceFeedback: { used: 0, cap: 10 },
    dayOverview: { used: 0, cap: 0 },
    cvTailor: { used: 0, cap: 3 },
  },
  features: { cvTailor: false },
  avoidedToday: 3,
  providers: [
    {
      id: 'groq',
      label: 'Groq',
      configured: true,
      available: true,
      cooldownUntil: null,
      usedToday: 5,
      budget: 100,
    },
  ],
  ...overrides,
});

function openSettings(body: AiUsage) {
  installApi({ 'GET /api/v1/me': () => json(meBody()), 'GET /api/v1/ai/usage': () => json(body) });
  return renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
}

beforeEach(() => window.localStorage.clear());

describe('meterModel', () => {
  it('stays hidden below 80% and when no provider is configured', () => {
    expect(meterModel(usage(10))).toBeNull();
    expect(meterModel(usage(31, { configured: false }))).toBeNull();
  });

  it('shows from 80%, summing the allowances that exist', () => {
    // 24 of 30 messages is exactly 80% of that allowance.
    expect(meterModel(usage(24))).toMatchObject({ used: 24, cap: 40, provider: 'Groq' });
    expect(meterModel(usage(23))).toBeNull();
  });
});

const provider = (usedToday: number) => ({
  id: 'groq',
  label: 'Groq',
  configured: true,
  available: true,
  cooldownUntil: null,
  usedToday,
  budget: 100,
});

describe('meterModel and providers', () => {
  it('counts a provider budget at 80% in the show rule', () => {
    expect(meterModel(usage(1, { providers: [provider(79)] }))).toBeNull();
    expect(meterModel(usage(1, { providers: [provider(80)] }))?.providers).toEqual([
      { label: 'Groq', used: 80, cap: 100 },
    ]);
  });
});

describe('Settings: AI usage meter', () => {
  it('lists provider requests against the budget when only the provider is near its limit', async () => {
    openSettings(usage(1, { providers: [provider(85)] }));
    expect(await screen.findByText('Groq: 85 of 100 requests')).toBeInTheDocument();
  });

  it('is not on the page while usage is under 80%', async () => {
    openSettings(usage(5));
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.queryByText(/AI calls today/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI use today' })).toBeNull();
  });

  it('shows the count, the active provider and the reset time at 80% or more', async () => {
    openSettings(usage(27));
    expect(await screen.findByText('27 of 40 AI calls today')).toBeInTheDocument();
    expect(screen.getByText('Active provider: Groq.')).toBeInTheDocument();
    expect(screen.getByText(/The count resets at/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'AI calls used today' })).toHaveAttribute(
      'value',
      '27',
    );
    // Counts only: no money anywhere.
    expect(document.body.textContent).not.toMatch(/[$€£]|cost|price/i);
    await expectNoAxeViolations();
  });

  it('shows the cap state with no provider available', async () => {
    openSettings(
      usage(30, {
        providers: [
          {
            id: 'groq',
            label: 'Groq',
            configured: true,
            available: false,
            cooldownUntil: null,
            usedToday: 100,
            budget: 100,
          },
        ],
      }),
    );
    expect(await screen.findByText('30 of 40 AI calls today')).toBeInTheDocument();
    expect(screen.getByText('No AI provider can answer right now.')).toBeInTheDocument();
    expect(screen.getByText(/practice still works/)).toBeInTheDocument();
  });
});
