import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import {
  hasSeenWelcome,
  isWelcomeExcluded,
  markWelcomeSeen,
  setWelcomeOpen,
  TOUR_STEPS,
  WELCOME_REOPEN_EVENT,
} from '../../lib/welcome';
import { ConfirmDialog } from '../ConfirmDialog';
import { GuideTour } from './GuideTour';
import { useModalIsolation } from './useModalIsolation';

/** The welcome dialog with the page behind it made inert, and Tab and Escape handled on the whole document. */
function WelcomeDialog({
  children,
  onConfirm,
  onCancel,
}: {
  children: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useModalIsolation(host, onCancel);
  return (
    <div ref={host}>
      <ConfirmDialog
        role="dialog"
        title="Welcome to Upversion"
        confirmLabel="Take the guide"
        cancelLabel="Skip for now"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        {children}
      </ConfirmDialog>
    </div>
  );
}

/**
 * The first-visit welcome dialog and the guided tour it can start. Mounted once in the signed-in
 * shell, so it never appears on the sign-in or legal pages; it also stays away from the calendar
 * callback. Dismissing it in any way (either button or Escape) counts as seen.
 */
function Welcome({ userId }: { userId: string }) {
  const { pathname } = useLocation();
  const [seen, setSeen] = useState(() => hasSeenWelcome(userId));
  const [reopened, setReopened] = useState(false);
  const [touring, setTouring] = useState(false);

  useEffect(() => {
    const open = () => setReopened(true);
    window.addEventListener(WELCOME_REOPEN_EVENT, open);
    return () => window.removeEventListener(WELCOME_REOPEN_EVENT, open);
  }, []);

  const excluded = isWelcomeExcluded(pathname);
  const showDialog = !touring && (reopened || (!seen && !excluded));

  function dismiss() {
    markWelcomeSeen(userId);
    setSeen(true);
    setReopened(false);
  }

  function startTour() {
    dismiss();
    setTouring(true);
  }

  const onScreen = touring || showDialog;
  useEffect(() => {
    setWelcomeOpen(onScreen);
    return () => setWelcomeOpen(false);
  }, [onScreen]);

  const closeTour = useCallback(() => setTouring(false), []);

  if (touring) return <GuideTour steps={TOUR_STEPS} onClose={closeTour} />;
  if (!showDialog) return null;
  return (
    <WelcomeDialog onConfirm={startTour} onCancel={dismiss}>
      <p>Here is how it works.</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <strong>Today</strong> and <strong>Week</strong> show what to study now and what is
          coming.
        </li>
        <li>
          <strong>Plan</strong> is your whole study plan, and <strong>Plan settings</strong> is
          where you set your study time. <strong>Settings</strong> holds appearance, AI use, privacy
          and data, your account and connections.
        </li>
        <li>Plans are suggestions until you approve them.</li>
        <li>The app never marks a task done for you. You do.</li>
        <li>AI is optional. Upversion works with it off.</li>
      </ol>
    </WelcomeDialog>
  );
}

export function WelcomeGuide() {
  const { state } = useAuth();
  if (state.status !== 'signedIn') return null;
  return <Welcome key={state.session.userId} userId={state.session.userId} />;
}
