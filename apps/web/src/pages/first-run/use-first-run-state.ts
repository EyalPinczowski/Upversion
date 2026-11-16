import { useAiUsage } from '../../api/ai-hooks';
import { usePlans } from '../../api/hooks';
import { useProfile } from '../../api/profile-hooks';
import { useAuth } from '../../auth/AuthProvider';
import { hasSkippedFirstRun } from '../../lib/first-run';
import { resumeStep } from './steps';

/**
 * Who gets the first run (ADR 018):
 *  - `pending`: the answers are not in yet (the welcome dialog waits);
 *  - `first-run`: the plan builder is on, the person has no plan and has not skipped or finished
 *    the first run, so they go to `/start`;
 *  - `legacy`: the plan builder is off or could not be read: the welcome dialog and the setup
 *    wizard work as before (no dead end when a flag is off);
 *  - `done`: the builder is on and this person does not need the first run (has a plan, skipped
 *    it, or finished it). The setup wizard never opens for them on its own.
 */
export type FirstRunState = 'pending' | 'first-run' | 'legacy' | 'done';

export function useFirstRunState(): FirstRunState {
  const { state } = useAuth();
  const usage = useAiUsage();
  const profile = useProfile();
  const plans = usePlans();
  const userId = state.status === 'signedIn' ? state.session.userId : undefined;

  if (usage.isPending) return 'pending';
  if (usage.isError || usage.data?.features?.planBuilder !== true) return 'legacy';
  if (profile.isPending || plans.isPending) return 'pending';
  if (profile.isError || plans.isError) return 'done';
  if (userId === undefined || plans.data.plans.length > 0) return 'done';
  if (hasSkippedFirstRun(userId)) return 'done';
  const p = profile.data;
  // No profile API (null): nothing is saved, and the local skip flag above is the only memory.
  if (p === null) return 'first-run';
  if (p.setupStatus === 'not_started') return 'first-run';
  if (p.setupStatus === 'in_progress' && resumeStep(p.setupStep) !== null) return 'first-run';
  return 'done';
}
