import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildRequestBody } from '../../api/client';
import { skillName } from './builder-model';
import { callsTo, installBuilderApi } from '../../test/builder-fixtures';
import { fakeAuth, renderApp, SESSION } from '../../test/helpers';
import {
  everythingSent,
  restoreSideChannels,
  spyOnSideChannels,
  webStorageDump,
} from '../../test/privacy-harness';

/** An invented job post. The canary and the sentence around it must never leave the browser. */
const CANARY = 'CANARY-7d2b9e41';
const POST = [
  'Operations analyst wanted at a fictional firm.',
  `Internal reference ${CANARY}: the violet heron files the amber report on Tuesdays.`,
  'You will build pivot tables in Excel and track vendor work in Jira.',
  'Strong SQL queries are a plus.',
].join('\n');
const SENTENCES = [CANARY, 'violet heron', 'amber report', 'Internal reference'];

const PREVIEW = 'POST /api/v1/plans/build/preview';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  restoreSideChannels();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a pasted job post', () => {
  it('is matched in the browser: the text and its terms are never sent, stored or logged, and only the confirmed skill ids go out', async () => {
    const side = spyOnSideChannels();
    const user = userEvent.setup();
    const api = installBuilderApi();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/new' });

    await screen.findByRole('heading', { level: 2, name: 'Your target' });
    await user.click(
      await screen.findByRole('checkbox', { name: 'Operations Associate / Analyst' }),
    );
    await user.click(screen.getByText('Paste a job post (optional)'));
    await user.click(screen.getByLabelText('Job post'));
    await user.paste(POST);
    await user.click(screen.getByRole('button', { name: 'Find skills in the post' }));

    const found = await screen.findByRole('group', { name: /Skills found/ });
    const boxes = within(found).getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    // Each skill is shown with the post's own words as a hint.
    const hinted = within(found).getAllByText(/“/);
    expect(hinted.length).toBeGreaterThan(0);
    const terms = hinted.map((n) => n.textContent ?? '');
    // Confirm only the first skill: untick the others.
    const confirmed: string[] = [];
    for (const [i, box] of boxes.entries()) {
      if (i === 0) {
        confirmed.push((box.closest('label') as HTMLElement).textContent ?? '');
      } else {
        await user.click(box);
      }
    }
    await user.click(screen.getByRole('button', { name: 'Add the ticked skills' }));
    expect(await screen.findByText(/The job post was cleared from this screen/)).toBeVisible();
    expect(screen.getByLabelText('Job post')).toHaveValue('');

    // On to the draft, so the real request goes out.
    for (const name of ['Your skills', 'Your time', 'Budget and certificates', 'Your draft']) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByRole('heading', { level: 2, name });
    }
    await waitFor(() => expect(callsTo(api, PREVIEW).length).toBeGreaterThan(0), { timeout: 4000 });

    const sent = (await callsTo(api, PREVIEW)[0]!.clone().json()) as BuildRequestBody;
    expect(sent.extraSkillIds).toHaveLength(1);
    expect(confirmed[0]).toContain(skillName(sent.extraSkillIds![0]!));

    // Nothing of the post, and none of the multi-word wordings the matcher showed, in any request.
    // (A one-word term such as "SQL" is also the catalog skill id, which is allowed to be sent.)
    const words = terms.flatMap((t) => [...t.matchAll(/“([^”]+)”/g)].map((m) => m[1]!));
    const distinctive = words.filter((w) => w.includes(' '));
    expect(distinctive.length).toBeGreaterThan(0);
    const everything = (await everythingSent(api)).toLowerCase();
    for (const secret of [...SENTENCES, ...distinctive]) {
      expect(everything).not.toContain(secret.toLowerCase());
    }
    // The request carries ids, numbers, dates and enums: no free text beyond the time zone.
    const keys = Object.keys(sent).sort();
    expect(keys).toEqual(
      [
        'budget',
        'certPreference',
        'certificateOptIns',
        'deadline',
        'examDates',
        'exclude',
        'extraSkillIds',
        'interviewPrep',
        'mustInclude',
        'priorityOverrides',
        'skillLevels',
        'startDate',
        'targetRoleIds',
        'weekPattern',
      ].sort(),
    );
    // Every other channel: web storage, console, beacons, XHR, images, sockets, errors.
    const dump = webStorageDump().toLowerCase();
    const channels = [
      dump,
      side.logged.join('\n'),
      side.xhr.join('\n'),
      side.images.join('\n'),
      side.sockets.join('\n'),
      side.errors.join('\n'),
    ]
      .join('\n')
      .toLowerCase();
    for (const secret of SENTENCES) expect(channels).not.toContain(secret.toLowerCase());
    expect(side.beacon).not.toHaveBeenCalled();
  });

  it('shows no skills and sends nothing when the post names none', async () => {
    const user = userEvent.setup();
    const api = installBuilderApi();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/new' });
    await screen.findByRole('heading', { level: 2, name: 'Your target' });
    await user.click(screen.getByText('Paste a job post (optional)'));
    await user.click(screen.getByLabelText('Job post'));
    await user.paste('We are a friendly team that likes lunch.');
    await user.click(screen.getByRole('button', { name: 'Find skills in the post' }));
    expect(await screen.findByText('No new catalog skills were found in the post.')).toBeVisible();
    expect(callsTo(api, PREVIEW)).toHaveLength(0);
    expect(await everythingSent(api)).not.toContain('friendly team');
  });
});
