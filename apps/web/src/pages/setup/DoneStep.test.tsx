import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { profileView } from '../../test/setup-fixtures';
import { DoneStep } from './DoneStep';

function show(skills: number, roles: number) {
  const profile = profileView({
    skills: Array.from({ length: skills }, (_, i) => ({
      skillId: `skill-${i}`,
      level: 1 as const,
      source: 'cv' as const,
    })),
    rolesHeld: Array.from({ length: roles }, (_, i) => ({
      roleId: null,
      title: `Role ${i}`,
      years: 1,
    })),
  });
  render(
    <MemoryRouter>
      <DoneStep questions={[]} answers={{}} profile={profile} onEdit={() => undefined} />
    </MemoryRouter>,
  );
}

describe('DoneStep summary grammar', () => {
  it('uses the singular for one skill or one role', () => {
    show(1, 1);
    expect(screen.getByText('From your CV: 1 skill and 1 role saved.')).toBeVisible();
  });

  it('uses the plural otherwise', () => {
    show(4, 2);
    expect(screen.getByText('From your CV: 4 skills and 2 roles saved.')).toBeVisible();
  });

  it('mixes them', () => {
    show(4, 1);
    expect(screen.getByText('From your CV: 4 skills and 1 role saved.')).toBeVisible();
  });
});
