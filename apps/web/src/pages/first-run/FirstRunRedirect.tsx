import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { isWelcomeExcluded } from '../../lib/welcome';
import type { FirstRunState } from './use-first-run-state';

/** Sends an eligible person to `/start`, at most once per page load. Renders nothing. */
export function FirstRunRedirect({ state }: { state: FirstRunState }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const done = useRef(false);
  const eligible = state === 'first-run' && !isWelcomeExcluded(pathname);
  useEffect(() => {
    if (!eligible || done.current) return;
    done.current = true;
    void navigate('/start', { replace: true });
  }, [eligible, navigate]);
  return null;
}
