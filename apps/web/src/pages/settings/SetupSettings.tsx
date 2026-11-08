import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useClearProfile, useProfile, useSetSetup } from '../../api/profile-hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, ErrorText } from '../../components/ui';

const TITLE_ID = 'profile-setup-heading';

/**
 * Settings > App: the entry point to the first-time setup (ADR 015). Renders nothing unless the
 * profile API answered (404 means the feature is off), so it never shows up half-working.
 */
export function SetupSettings() {
  const profile = useProfile();
  const navigate = useNavigate();
  const setSetup = useSetSetup();
  const clear = useClearProfile();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!profile.data) return null;
  const status = profile.data.setupStatus;
  const started = status === 'not_started' || status === 'in_progress';

  async function runAgain() {
    setFailed(false);
    try {
      await setSetup.mutateAsync({ status: 'in_progress', step: 'welcome' });
      void navigate('/setup');
    } catch {
      setFailed(true);
    }
  }

  return (
    <section
      aria-labelledby={TITLE_ID}
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id={TITLE_ID}>Profile setup</h3>
      <p>
        {status === 'not_started'
          ? 'A few questions about your study time and background, so your plans fit you. Optional, about 3 minutes.'
          : status === 'in_progress'
            ? 'You started setting up your profile. Pick up where you left off.'
            : status === 'completed'
              ? 'Your profile is set up. You can go through the questions again.'
              : 'You skipped the setup. You can do it now or later.'}
      </p>
      <div className="flex flex-wrap gap-3">
        {started ? (
          <Button variant="primary" onClick={() => void navigate('/setup')}>
            {status === 'not_started' ? 'Set up your profile' : 'Finish setup'}
          </Button>
        ) : (
          <Button onClick={() => void runAgain()} disabled={setSetup.isPending}>
            {status === 'completed' ? 'Run setup again' : 'Set up your profile'}
          </Button>
        )}
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Clear my profile
        </Button>
      </div>
      {failed ? <ErrorText>We couldn’t start the setup. Try again in a moment.</ErrorText> : null}
      {clear.isError ? (
        <ErrorText>We couldn’t clear your profile. Nothing was changed. Try again.</ErrorText>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title="Clear your profile?"
          confirmLabel="Clear my profile"
          cancelLabel="Keep it"
          busy={clear.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => clear.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          <p>
            Your setup answers, skills, roles and years of experience are deleted. Your plans are
            not touched, and you won’t be sent back to the setup.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
