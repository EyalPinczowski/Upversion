import { useEffect, useReducer, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePlans } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useProfile } from '../../api/profile-hooks';
import { isWelcomeExcluded, isWelcomeSettled, WELCOME_CHANGE_EVENT } from '../../lib/welcome';

/**
 * First-run redirect to /setup. It happens at most once per page load, and only when all of
 * these hold (ADR 015, narrowed to the first visit):
 *  - the profile API is available (GET /me/profile answered 200; a 404 means the flag is off);
 *  - the person has no plan (the plan list loaded and is empty);
 *  - setup is `not_started` (anyone who began, finished or dismissed it is never sent back;
 *    people who stopped midway find "Finish setup" in Settings);
 *  - the welcome dialog and tour have been seen and are closed;
 *  - the current page is not /setup or the calendar callback.
 * Renders nothing.
 */
export function SetupRedirect() {
  const { state } = useAuth();
  const profile = useProfile();
  const plans = usePlans();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const done = useRef(false);
  // Re-render when the welcome dialog opens or closes.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(WELCOME_CHANGE_EVENT, bump);
    return () => window.removeEventListener(WELCOME_CHANGE_EVENT, bump);
  }, []);

  const userId = state.status === 'signedIn' ? state.session.userId : undefined;
  const eligible =
    userId !== undefined &&
    profile.data?.setupStatus === 'not_started' &&
    plans.isSuccess &&
    plans.data.plans.length === 0 &&
    isWelcomeSettled(userId) &&
    !isWelcomeExcluded(pathname);

  useEffect(() => {
    if (!eligible || done.current) return;
    done.current = true;
    void navigate('/setup', { replace: true });
  }, [eligible, navigate]);

  return null;
}
