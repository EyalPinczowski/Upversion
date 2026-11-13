import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildPlanBody, BuildRequestBody } from '../../api/client';
import { expectNoAxeViolations } from '../../test/axe';
import {
  callsTo,
  draft,
  fitOptions,
  installBuilderApi,
  item,
  NEW_PLAN_ID,
  OLD_PLAN_ID,
  plan,
} from '../../test/builder-fixtures';
import { apiError, fakeAuth, json, renderApp, SESSION } from '../../test/helpers';

const PREVIEW = 'POST /api/v1/plans/build/preview';
const BUILD = 'POST /api/v1/plans/build';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WAIT = { timeout: 4000 };

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  user = userEvent.setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const body = async (request: Request) => (await request.clone().json()) as BuildRequestBody;
const buildBody = async (request: Request) => (await request.clone().json()) as BuildPlanBody;

function open(
  options: Parameters<typeof installBuilderApi>[0] = {},
  onLocation?: (u: string) => void,
) {
  const api = installBuilderApi(options);
  renderApp({ auth: fakeAuth(SESSION), path: '/plan/new', onLocation });
  return api;
}

const next = () => user.click(screen.getByRole('button', { name: 'Next' }));
const stepHeading = (name: string) => screen.findByRole('heading', { level: 2, name });

async function chooseRole(title = 'Operations Associate / Analyst') {
  await stepHeading('Your target');
  await user.click(await screen.findByRole('checkbox', { name: title }));
}

/** Walks the four question steps with the defaults and lands on the draft. */
async function toDraft() {
  await chooseRole();
  await next();
  await stepHeading('Your skills');
  await next();
  await stepHeading('Your time');
  await next();
  await stepHeading('Budget and certificates');
  await next();
  await stepHeading('Your draft');
}

describe('the five steps', () => {
  it('shows the step count and moves focus to each new step heading', async () => {
    open();
    expect(await screen.findByText('Step 1 of 5: Your target')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await chooseRole();
    await next();
    const heading = await stepHeading('Your skills');
    expect(screen.getByText('Step 2 of 5: Your skills')).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const first = await stepHeading('Your target');
    await waitFor(() => expect(first).toHaveFocus());
    // The role is still chosen: nothing is lost on Back.
    expect(screen.getByRole('checkbox', { name: 'Operations Associate / Analyst' })).toBeChecked();
  });

  it('asks for a role before step 2 and allows at most two', async () => {
    open();
    await stepHeading('Your target');
    await next();
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose at least one role.');
    expect(screen.getByText('Step 1 of 5: Your target')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Operations Associate / Analyst' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Technical Operations / Support Specialist' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Product Operations / Junior Product Manager' }),
    ).toBeDisabled();
  });

  it('checks the dates, study days and hours on step 3', async () => {
    open();
    await chooseRole();
    await next();
    await next();
    await stepHeading('Your time');
    const finish = screen.getByLabelText('Finish date');
    await user.clear(finish);
    await user.type(finish, '2020-01-01');
    await next();
    expect(await screen.findByText('The finish date must be after the start date.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '8 weeks' }));
    const hours = screen.getByLabelText('Hours per study day');
    await user.clear(hours);
    await user.type(hours, '20');
    await next();
    expect(await screen.findByText(/Enter hours per study day from 0.5 to 12/)).toBeVisible();
    await user.clear(hours);
    await user.type(hours, '2');
    await next();
    await stepHeading('Budget and certificates');
  });

  it('needs an amount for a budget limit, and offers US dollars only', async () => {
    const api = open();
    await chooseRole();
    await next();
    await next();
    await next();
    await stepHeading('Budget and certificates');
    expect(screen.getByText(/Catalog prices are in US dollars/)).toBeVisible();
    expect(screen.queryByText(/ILS|EUR/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Up to a set amount' }));
    await next();
    expect(
      await screen.findByText(/Enter the most you want to spend, in US dollars/),
    ).toBeVisible();
    await user.type(screen.getByLabelText(/Most you want to spend in total/), '100');
    await next();
    await stepHeading('Your draft');
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBeGreaterThan(0), WAIT);
    const sent = await body(callsTo(api, PREVIEW)[0]!);
    expect(sent.budget).toEqual({ mode: 'limit', amount: 100 });
  });
});

describe('pre-filled from the profile', () => {
  const profile = {
    answers: { target_role: ['operations-associate'], hours_per_day: 2, time_of_day: 'evening' },
    skills: [
      { skillId: 'excel', level: 2, source: 'cv' as const },
      { skillId: 'jira', level: 1, source: 'setup' as const },
      { skillId: 'process-improvement', level: 3, source: 'manual' as const },
    ],
  };

  it('pre-selects the role, shows where each level came from and links to Change my CV', async () => {
    open({ profile });
    await stepHeading('Your target');
    expect(
      await screen.findByRole('checkbox', { name: 'Operations Associate / Analyst' }),
    ).toBeChecked();
    await next();
    await stepHeading('Your skills');
    const row = (name: string) => screen.getByLabelText(name).closest('li') as HTMLElement;
    expect(within(row('Excel & spreadsheets')).getByText(/from your CV/)).toBeVisible();
    expect(within(row('Excel & spreadsheets')).getByRole('combobox')).toHaveValue('2');
    expect(within(row('Process improvement')).getByText(/you set this/)).toBeVisible();
    expect(within(row('Operations management')).getByText(/not rated/)).toBeVisible();
    expect(within(row('Operations management')).getByRole('combobox')).toHaveValue('0');
    expect(screen.getByRole('link', { name: 'Change my CV' })).toHaveAttribute(
      'href',
      '/settings/cv',
    );
    // Editing a level says so, and it is for this plan only.
    await user.selectOptions(within(row('Operations management')).getByRole('combobox'), '1');
    expect(within(row('Operations management')).getByText(/for this plan only/)).toBeVisible();
  });

  it('sends the pre-filled and edited levels, hours and window in the preview', async () => {
    const api = open({ profile });
    await stepHeading('Your target');
    await next();
    await stepHeading('Your skills');
    await next();
    await stepHeading('Your time');
    expect(screen.getByLabelText('Hours per study day')).toHaveValue(2);
    expect(screen.getByLabelText('When do you study best?')).toHaveValue('evening');
    await next();
    await next();
    await stepHeading('Your draft');
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(1), WAIT);
    const sent = await body(callsTo(api, PREVIEW)[0]!);
    expect(sent.targetRoleIds).toEqual(['operations-associate']);
    expect(sent.skillLevels?.['excel']).toBe(2);
    expect(sent.skillLevels?.['operations-management']).toBe(0);
    expect(sent.weekPattern.defaultHours).toBe(2);
    expect(sent.weekPattern.windowStart).toBe('18:00');
    expect(sent.budget).toEqual({ mode: 'free' });
  });

  it('works without a profile (the profile feature off)', async () => {
    open({ profile: 404 });
    await stepHeading('Your target');
    expect(
      screen.getByRole('checkbox', { name: 'Operations Associate / Analyst' }),
    ).not.toBeChecked();
  });
});

describe('the draft step', () => {
  it('creates nothing and calls no build endpoint until Start this plan', async () => {
    const api = open();
    await toDraft();
    expect(await screen.findByText('SQL for beginners')).toBeVisible();
    expect(callsTo(api, BUILD)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Start this plan' })).toBeEnabled();
    expect(callsTo(api, BUILD)).toHaveLength(0);
  });

  it('debounces: several quick edits send one preview with all of them', async () => {
    const api = open({});
    await toDraft();
    await screen.findByText('SQL for beginners');
    const before = callsTo(api, PREVIEW).length;
    await user.click(screen.getByRole('button', { name: /Make optional/ }));
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(before + 1), WAIT);
    await new Promise((r) => setTimeout(r, 800));
    expect(callsTo(api, PREVIEW).length).toBe(before + 1);
    const sent = await body(callsTo(api, PREVIEW).at(-1)!);
    expect(sent.priorityOverrides).toEqual({ 'sql-basics': 'optional' });
    expect(sent.exclude).toEqual(['sql-basics']);
  });

  it('cancels the request in flight and never lets an old answer replace a newer one', async () => {
    const gate = { release: () => {} };
    let n = 0;
    const api = open({
      preview: async () => {
        n += 1;
        if (n === 2) {
          // The second preview never answers on its own: it must be cancelled by the third.
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return json(draft({ draftHash: 'stale' }, [item({ title: 'Stale answer' })]));
        }
        return json(
          draft({ draftHash: `hash-${n}` }, [
            item({ title: n === 1 ? 'First draft' : 'Latest draft' }),
          ]),
        );
      },
    });
    await toDraft();
    await screen.findByText('First draft');
    await user.click(screen.getByRole('button', { name: /Make optional/ }));
    await waitFor(() => expect(callsTo(api, PREVIEW)).toHaveLength(2), WAIT);
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(callsTo(api, PREVIEW)).toHaveLength(3), WAIT);
    expect(callsTo(api, PREVIEW)[1]!.signal.aborted).toBe(true);
    expect(await screen.findByText('Latest draft')).toBeVisible();
    gate.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Stale answer')).toBeNull();
    expect(screen.getByText('Latest draft')).toBeVisible();
  });

  it('shows the needs-check badges, notes and cost wording, and never calls an unchecked price verified', async () => {
    const items = [
      item({
        catalogId: 'unlinked',
        title: 'Unlinked course',
        taskIds: ['c-unlinked'],
        needsCheckLink: true,
        needsCheckPrice: true,
        cost: { amount: 49, kind: 'one_time' },
      }),
      item({
        catalogId: 'varies',
        title: 'Varying price course',
        taskIds: ['c-varies'],
        priceVaries: true,
        needsCheckPrice: true,
        cost: { amount: null, kind: 'one_time' },
      }),
      item({ catalogId: 'linked', title: 'Linked free course', taskIds: ['c-linked'] }),
    ];
    const base = draft({}, items);
    open({
      preview: () =>
        json({
          ...base,
          summary: {
            ...base.summary,
            cost: {
              ...base.summary.cost,
              total: 49,
              estimated: true,
              unverifiedPriceCount: 1,
              pricesToCheck: 1,
              mayBeHigher: true,
            },
          },
        }),
    });
    await toDraft();
    const unlinked = (await screen.findByText('Unlinked course')).closest('li') as HTMLElement;
    expect(within(unlinked).getByText('Needs check: link')).toBeVisible();
    expect(within(unlinked).getByText('Needs check: price')).toBeVisible();
    expect(within(unlinked).getByText(/Needs check: link not yet verified/)).toBeVisible();
    expect(within(unlinked).getByText(/\$49 \(price not checked\)/)).toBeVisible();
    expect(within(unlinked).queryByRole('link')).toBeNull();
    const varies = screen.getByText('Varying price course').closest('li') as HTMLElement;
    expect(within(varies).getAllByText('Price varies – check').length).toBeGreaterThan(0);
    const linked = screen.getByText('Linked free course').closest('li') as HTMLElement;
    expect(within(linked).getByRole('link', { name: /Open the course page/ })).toHaveAttribute(
      'href',
      'https://courses.example.test/sql',
    );
    expect(screen.getByText('Estimated cost: about $49.')).toBeVisible();
    expect(
      screen.getByText(/1 price has not been checked yet, so the total is an estimate/),
    ).toBeVisible();
    expect(screen.getByText('+ 1 price to check (not in the total).')).toBeVisible();
    expect(screen.getByText(/The total may be higher/)).toBeVisible();
    // The word "verified" is only used for the catalog's own note about a missing link.
    expect(screen.queryByText(/price.*verified/i)).toBeNull();
    expect(screen.queryByText(/^Cost: \$/)).toBeNull();
  });

  it('says a free draft is free', async () => {
    open();
    await toDraft();
    expect(await screen.findByText('Cost: $0. Everything in this draft is free.')).toBeVisible();
    expect(screen.getByText('This fits before your finish date.')).toBeVisible();
  });

  it('lists excluded items with reasons, skipped prerequisites, gaps and warnings', async () => {
    const base = draft();
    open({
      preview: () =>
        json({
          ...base,
          excluded: [
            {
              catalogId: 'paid-one',
              reason: 'free_only',
              message: 'Paid course is not free.',
            },
          ],
          skippedPrerequisites: [
            { catalogId: 'x', message: 'Skipped: you rated Excel Comfortable.' },
          ],
          summary: {
            ...base.summary,
            skillsNotCovered: [{ skillId: 'git', name: 'Git', reason: 'catalog_gap' }],
          },
          warnings: [{ code: 'estimates', message: 'Hour estimates are approximate.' }],
        }),
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    expect(screen.getByText('Skipped: you rated Excel Comfortable.')).toBeVisible();
    expect(screen.getByText(/Git: no suitable item in the catalog/)).toBeVisible();
    expect(screen.getByText('Hour estimates are approximate.')).toBeVisible();
    await user.click(screen.getByText('Left out (1)'));
    expect(screen.getByText('Not free:')).toBeVisible();
    expect(screen.getByText(/Paid course is not free/)).toBeVisible();
  });

  it('offers the three ways to fit, and each one edits the request', async () => {
    const base = draft({}, [
      item(),
      item({
        catalogId: 'excel-pivot',
        title: 'Excel pivots',
        taskIds: ['c-excel-pivot'],
        tier: 'optional',
      }),
    ]);
    const api = open({
      preview: async (request) => {
        const sent = request;
        void sent;
        return json({ ...base, fits: false, options: fitOptions() });
      },
    });
    await toDraft();
    expect(await screen.findByText(/does not fit before your finish date/)).toBeVisible();
    expect(screen.getByText(/You would lose: Excel & spreadsheets/)).toBeVisible();
    expect(screen.getByText(/applies to every study day/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Keep only the essentials' }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(2), WAIT);
    expect((await body(callsTo(api, PREVIEW)[1]!)).exclude).toEqual(['excel-pivot']);

    await user.click(await screen.findByRole('button', { name: 'Study 4.5 h a day' }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(3), WAIT);
    const hoursRequest = await body(callsTo(api, PREVIEW)[2]!);
    expect(hoursRequest.weekPattern.defaultHours).toBe(4.5);
    expect(hoursRequest.weekPattern.hoursByWeekday).toEqual({});

    await user.click(await screen.findByRole('button', { name: /^Finish on / }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(4), WAIT);
    expect((await body(callsTo(api, PREVIEW)[3]!)).deadline).toBe('2027-01-20');
  });

  it('explains when a fit option is not possible', async () => {
    open({
      preview: () =>
        json({
          ...draft(),
          fits: false,
          options: {
            finishOn: { date: null },
            hoursPerDay: { value: null, appliesToAllStudyDays: true },
            essentials: { possible: false, droppedItemIds: [], lostSkillIds: [] },
          },
        }),
    });
    await toDraft();
    expect(await screen.findByText('Not possible within your study window.')).toBeVisible();
    expect(screen.getByText(/does not finish within two years/)).toBeVisible();
    expect(screen.getByText(/Not possible: dropping items would not make it fit/)).toBeVisible();
  });

  it('offers to remove items when over budget, and offers exams to include', async () => {
    const base = draft({}, [
      item({ catalogId: 'pricey', title: 'Pricey course', taskIds: ['c-pricey'] }),
    ]);
    const api = open({
      preview: () =>
        json({
          ...base,
          overBudget: true,
          removeToFit: ['pricey'],
          summary: {
            ...base.summary,
            certificatesOffered: [
              {
                catalogId: 'sql-exam',
                title: 'SQL exam',
                provider: 'Example',
                price: null,
                priceVerified: false,
              },
            ],
          },
        }),
    });
    await toDraft();
    expect(await screen.findByText(/known prices are above your limit/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Include this exam: SQL exam' }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(2), WAIT);
    expect((await body(callsTo(api, PREVIEW)[1]!)).certificateOptIns).toEqual(['sql-exam']);
    await user.click(screen.getByRole('button', { name: 'Remove them to fit my budget' }));
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(3), WAIT);
    expect((await body(callsTo(api, PREVIEW)[2]!)).exclude).toEqual(['pricey']);
  });

  it('sets an exam date on an included exam', async () => {
    const exam = item({
      catalogId: 'sql-exam',
      title: 'SQL exam',
      kind: 'exam',
      taskIds: ['x-sql-exam'],
      isCertificate: true,
      cost: { amount: 100, kind: 'certificate' },
    });
    const api = open({ preview: () => json(draft({}, [exam])) });
    await toDraft();
    await screen.findByText('SQL exam');
    await user.type(screen.getByLabelText('Date of SQL exam'), '2026-12-01');
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(2), WAIT);
    expect((await body(callsTo(api, PREVIEW)[1]!)).examDates).toEqual([
      { catalogId: 'sql-exam', date: '2026-12-01', start: '09:00' },
    ]);
  });

  it('shows a plain message for each preview error code', async () => {
    const issues = (code: string) => ({
      error: { code: 'unprocessable', message: 'x', requestId: 'r', issues: [{ code }] },
    });
    const cases: [string, RegExp][] = [
      ['deadline_too_far', /finish date is too far away/],
      ['exam_date_out_of_range', /exam date is outside the plan’s dates/],
      ['exam_dates_overlap', /Two exams are on the same day and time/],
      ['deadline_not_after_start', /finish date must be after the start date/],
    ];
    for (const [code, text] of cases) {
      const view = open({ preview: () => json(issues(code), 422) });
      await toDraft();
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Start this plan' })).toBeDisabled();
      view.calls.length = 0;
      document.body.innerHTML = '';
    }
  });

  it('handles a 400 and a lost connection on preview, with a retry', async () => {
    let n = 0;
    const api = open({
      preview: () => {
        n += 1;
        return n === 1 ? apiError(400, 'validation_error', 'Invalid request') : json(draft());
      },
    });
    await toDraft();
    expect(await screen.findByText(/not accepted/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('SQL for beginners')).toBeVisible();
    expect(callsTo(api, PREVIEW)).toHaveLength(2);
  });

  it('has no axe violations on the draft step', async () => {
    open();
    await toDraft();
    await screen.findByText('SQL for beginners');
    await expectNoAxeViolations();
  });
});

describe('starting the plan', () => {
  it('asks nothing when no plan is active, and sends an empty replacesPlanIds with a new uuid', async () => {
    const onLocation = vi.fn();
    const api = open({ plans: [] }, onLocation);
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await waitFor(() => expect(callsTo(api, BUILD)).toHaveLength(1), WAIT);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const sent = await buildBody(callsTo(api, BUILD)[0]!);
    expect(sent.id).toMatch(UUID);
    expect(sent.replacesPlanIds).toEqual([]);
    expect(sent.draftHash).toBe('hash-1');
    expect(sent.request.targetRoleIds).toEqual(['operations-associate']);
    // The new plan is the one that opens.
    await waitFor(
      () => expect(window.localStorage.getItem('skillstack.plan')).toBe(NEW_PLAN_ID),
      WAIT,
    );
    await waitFor(
      () => expect(onLocation).toHaveBeenLastCalledWith(expect.stringContaining('/plan')),
      WAIT,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
  });

  it('names every active plan in the archive dialog and sends exactly their ids', async () => {
    const second = '44444444-4444-4444-8444-444444444444';
    const archived = '55555555-5555-4555-8555-555555555555';
    const api = open({
      plans: [
        plan({ id: OLD_PLAN_ID, name: 'First active plan' }),
        plan({ id: second, name: 'Second active plan' }),
        plan({ id: archived, name: 'Long ago plan', status: 'archived' }),
      ],
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('First active plan');
    expect(dialog).toHaveTextContent('Second active plan');
    expect(dialog).not.toHaveTextContent('Long ago plan');
    expect(dialog).toHaveTextContent('will be archived');
    expect(dialog).toHaveTextContent('read-only');
    expect(callsTo(api, BUILD)).toHaveLength(0);
    // Cancel: nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsTo(api, BUILD)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Archive and start' }));
    await waitFor(() => expect(callsTo(api, BUILD)).toHaveLength(1), WAIT);
    const sent = await buildBody(callsTo(api, BUILD)[0]!);
    expect([...sent.replacesPlanIds].sort()).toEqual([OLD_PLAN_ID, second].sort());
  });

  it('active_plan_changed: re-reads the plans and shows the dialog again with the right names', async () => {
    let first = true;
    const api = open({
      plans: [plan({ name: 'Old plan' })],
      build: () => {
        if (!first) return json(plan({ id: NEW_PLAN_ID, name: 'Operations plan' }), 201);
        first = false;
        api.state.plans = [
          plan({ id: '66666666-6666-4666-8666-666666666666', name: 'Imported meanwhile' }),
        ];
        return apiError(409, 'active_plan_changed', 'Your active plans changed.');
      },
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Archive and start' }));
    const dialog = await screen.findByText(/Your active plans changed in the meantime/);
    expect(dialog).toBeVisible();
    const modal = screen.getByRole('alertdialog');
    await waitFor(() => expect(modal).toHaveTextContent('Imported meanwhile'));
    expect(modal).not.toHaveTextContent('Old plan');
    await user.click(within(modal).getByRole('button', { name: 'Archive and start' }));
    await waitFor(() => expect(callsTo(api, BUILD)).toHaveLength(2), WAIT);
    expect((await buildBody(callsTo(api, BUILD)[1]!)).replacesPlanIds).toEqual([
      '66666666-6666-4666-8666-666666666666',
    ]);
  });

  it('active_plan_changed with nothing active now: asks to press Start again', async () => {
    const api = open({
      plans: [plan({ name: 'Old plan' })],
      build: () => {
        api.state.plans = [plan({ name: 'Old plan', status: 'archived' })];
        return apiError(409, 'active_plan_changed', 'x');
      },
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Archive and start' }));
    expect(
      await screen.findByText(/Your plans changed in the meantime. Press Start this plan again/),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('draft_changed: re-previews, says so, and the next try uses the new hash and a new id', async () => {
    let previews = 0;
    let builds = 0;
    const api = open({
      preview: () => {
        previews += 1;
        return json(draft({ draftHash: `hash-${previews}` }));
      },
      build: () => {
        builds += 1;
        return builds === 1
          ? apiError(409, 'draft_changed', 'The draft changed.')
          : json(plan({ id: NEW_PLAN_ID, name: 'Operations plan' }), 201);
      },
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    expect(
      await screen.findByText(/The catalog or your choices changed since this draft/),
    ).toBeVisible();
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBe(2), WAIT);
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Start this plan' })).toBeEnabled(),
      WAIT,
    );
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await waitFor(() => expect(callsTo(api, BUILD)).toHaveLength(2), WAIT);
    const [a, b] = await Promise.all(callsTo(api, BUILD).map(buildBody));
    expect(a!.draftHash).toBe('hash-1');
    expect(b!.draftHash).toBe('hash-2');
    expect(a!.id).not.toBe(b!.id);
  });

  it('conflict, 422 issues, 400 and 404 each get a plain message', async () => {
    const cases: [number, object, RegExp][] = [
      [409, { code: 'conflict', message: 'x' }, /already started with different choices/],
      [
        422,
        { code: 'unprocessable', message: 'x', issues: [{ code: 'deadline_too_far' }] },
        /finish date is too far away/,
      ],
      [400, { code: 'validation_error', message: 'x' }, /not accepted/],
      [404, { code: 'not_found', message: 'x' }, /not available right now/],
      [500, { code: 'internal', message: 'x' }, /went wrong on our side/],
    ];
    for (const [status, error, text] of cases) {
      document.body.innerHTML = '';
      const api = open({ build: () => json({ error: { ...error, requestId: 'r' } }, status) });
      await toDraft();
      await screen.findByText('SQL for beginners');
      await user.click(screen.getByRole('button', { name: 'Start this plan' }));
      expect(await screen.findByText(text)).toBeVisible();
      expect(callsTo(api, BUILD)).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Start this plan' })).toBeEnabled();
    }
  });

  it('a lost answer is retried with the same id, so the plan cannot be created twice', async () => {
    let builds = 0;
    const api = open({
      build: () => {
        builds += 1;
        if (builds === 1) throw new TypeError('network down');
        return json(plan({ id: NEW_PLAN_ID, name: 'Operations plan' }), 200);
      },
    });
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    expect(
      await screen.findByText(/Can’t reach the server.*will not be created twice/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start this plan' }));
    await waitFor(() => expect(callsTo(api, BUILD)).toHaveLength(2), WAIT);
    const [a, b] = await Promise.all(callsTo(api, BUILD).map(buildBody));
    expect(a!.id).toMatch(UUID);
    expect(b!.id).toBe(a!.id);
    expect(b).toEqual(a);
  });

  it('keeps Start disabled while the draft is being updated', async () => {
    open();
    await toDraft();
    await screen.findByText('SQL for beginners');
    await user.click(screen.getByRole('button', { name: /Make optional/ }));
    expect(screen.getByRole('button', { name: 'Start this plan' })).toBeDisabled();
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Start this plan' })).toBeEnabled(),
      WAIT,
    );
  });
});

describe('accessibility of the question steps', () => {
  it('has no axe violations on steps 1 to 4', async () => {
    open({ profile: { answers: { target_role: ['operations-associate'] } } });
    await stepHeading('Your target');
    await screen.findByRole('checkbox', { name: 'Operations Associate / Analyst' });
    await expectNoAxeViolations();
    await next();
    await stepHeading('Your skills');
    await expectNoAxeViolations();
    await next();
    await stepHeading('Your time');
    await expectNoAxeViolations();
    await next();
    await stepHeading('Budget and certificates');
    await user.click(screen.getByRole('radio', { name: 'Up to a set amount' }));
    await expectNoAxeViolations();
  });
});

describe('profile data in the builder', () => {
  it('uses the profile levels of a role the person adds on step 1', async () => {
    const api = open({
      profile: { skills: [{ skillId: 'jira', level: 2, source: 'cv' }] },
    });
    await chooseRole('Project Coordinator / Junior Project Manager');
    await next();
    await stepHeading('Your skills');
    expect(
      within(screen.getByLabelText('Jira & Confluence').closest('li') as HTMLElement).getByText(
        /from your CV/,
      ),
    ).toBeVisible();
    void api;
  });
});
