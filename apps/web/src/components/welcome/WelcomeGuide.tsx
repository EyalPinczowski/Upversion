import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import {
  hasSeenWelcome,
  markWelcomeSeen,
  resolveTourSteps,
  WELCOME_EXCLUDED_PATHS,
  WELCOME_REOPEN_EVENT,
  type TourStep,
} from '../../lib/welcome';
import { ConfirmDialog } from '../ConfirmDialog';
import { GuideTour } from './GuideTour';

/**
 * The first-visit welcome dialog and the guided tour it can start. Mounted once in the signed-in
 * shell, so it never appears on the sign-in or legal pages; it also stays away from the calendar
 * callback. Dismissing it in any way (either button or Escape) counts as seen.
 */
function Welcome({ userId }: { userId: string }) {
  const { pathname } = useLocation();
  const [seen, setSeen] = useState(() => hasSeenWelcome(userId));
  const [reopened, setReopened] = useState(false);
  const [tour, setTour] = useState<TourStep[] | null>(null);

  useEffect(() => {
    const open = () => setReopened(true);
    window.addEventListener(WELCOME_REOPEN_EVENT, open);
    return () => window.removeEventListener(WELCOME_REOPEN_EVENT, open);
  }, []);

  const excluded = WELCOME_EXCLUDED_PATHS.includes(pathname);
  const showDialog = tour === null && (reopened || (!seen && !excluded));

  function dismiss() {
    markWelcomeSeen(userId);
    setSeen(true);
    setReopened(false);
  }

  function startTour() {
    const steps = resolveTourSteps();
    dismiss();
    if (steps.length > 0) setTour(steps);
  }

  if (tour) return <GuideTour steps={tour} onClose={() => setTour(null)} />;
  if (!showDialog) return null;
  return (
    <ConfirmDialog
      role="dialog"
      title="Welcome to Upversion"
      confirmLabel="Take the guide"
      cancelLabel="Skip for now"
      onConfirm={startTour}
      onCancel={dismiss}
    >
      <p>Here is how it works.</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <strong>Today</strong> and <strong>Week</strong> show what to study now and what is
          coming.
        </li>
        <li>
          <strong>Plan</strong> is your whole study plan. <strong>Settings</strong> holds your time,
          appearance and data.
        </li>
        <li>Plans are suggestions until you approve them.</li>
        <li>The app never marks a task done for you. You do.</li>
        <li>AI is optional. Upversion works with it off.</li>
      </ol>
    </ConfirmDialog>
  );
}

export function WelcomeGuide() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  return <Welcome key={state.session.userId} userId={state.session.userId} />;
}
