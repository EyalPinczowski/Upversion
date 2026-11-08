import { describe, expect, it } from 'vitest';
import {
  ProfileImportSchema,
  RoleHeldSchema,
  SetupStatusSchema,
  UserProfileSchema,
} from './schemas';

const profile = {
  answers: { current_status: 'employed' },
  skills: [{ skillId: 'excel', level: 2, source: 'cv' }],
  rolesHeld: [{ roleId: null, title: 'Analyst', years: 2 }],
  yearsExperience: 5,
  cvImportedAt: null,
  setupStatus: 'in_progress',
  setupStep: 'q3',
  setupCompletedAt: null,
};

describe('profile schemas', () => {
  it('accepts a valid profile and every setup status incl. dismissed', () => {
    expect(UserProfileSchema.safeParse(profile).success).toBe(true);
    for (const s of ['not_started', 'in_progress', 'completed', 'dismissed']) {
      expect(SetupStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(SetupStatusSchema.safeParse('skipped').success).toBe(false);
  });

  it('rejects unknown keys and any userId', () => {
    expect(UserProfileSchema.safeParse({ ...profile, userId: 'u1' }).success).toBe(false);
    expect(UserProfileSchema.safeParse({ ...profile, user_id: 'u1' }).success).toBe(false);
    const withExtraSkillKey = { ...profile, skills: [{ ...profile.skills[0], evidence: 'x' }] };
    expect(UserProfileSchema.safeParse(withExtraSkillKey).success).toBe(false);
    const role = { roleId: null, title: 'A', years: 1, userId: 'u' };
    expect(RoleHeldSchema.safeParse(role).success).toBe(false);
    const imp = {
      skills: [],
      rolesHeld: [],
      yearsExperience: null,
      education: null,
      tools: [],
      userId: 'u1',
    };
    expect(ProfileImportSchema.safeParse(imp).success).toBe(false);
  });

  it('enforces the ADR bounds', () => {
    const ok = (patch: object) => UserProfileSchema.safeParse({ ...profile, ...patch }).success;
    const skill = { skillId: 'x', level: 1, source: 'cv' };
    const role = { roleId: null, title: 'A', years: null };
    expect(ok({ skills: [{ ...skill, level: 4 }] })).toBe(false);
    expect(ok({ skills: [{ ...skill, source: 'import' }] })).toBe(false);
    expect(ok({ skills: Array(61).fill(skill) })).toBe(false);
    expect(ok({ skills: Array(60).fill(skill) })).toBe(true);
    expect(ok({ rolesHeld: Array(16).fill(role) })).toBe(false);
    expect(ok({ rolesHeld: [{ ...role, title: 'A'.repeat(81) }] })).toBe(false);
    expect(ok({ rolesHeld: [{ ...role, years: 51 }] })).toBe(false);
    expect(ok({ yearsExperience: -1 })).toBe(false);
    expect(ok({ setupStep: 'x'.repeat(41) })).toBe(false);
  });
});
