import { useEffect } from 'react';
import { useCalendarStatus } from '../../api/calendar-hooks';
import { Loading } from '../../components/status';
import { Button, ErrorText } from '../../components/ui';
import { ConnectButton } from '../settings/CalendarSettings';

/**
 * The optional calendar step. It reuses the existing connect flow (the same button as Settings >
 * Connections); the callback page then links back here. When the calendar feature is off on the
 * server the step does not exist: it passes straight on.
 */
export function CalendarStep({ onNext }: { onNext: () => void }) {
  const query = useCalendarStatus();
  const off = query.data === null;
  useEffect(() => {
    if (off) onNext();
  }, [off, onNext]);

  if (query.isError) {
    return (
      <div className="space-y-4">
        <ErrorText>We couldn’t load your calendar connection.</ErrorText>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void query.refetch()}>Retry</Button>
          <Button onClick={onNext}>Skip for now</Button>
        </div>
      </div>
    );
  }
  if (off) {
    // Normally the step passes straight on; this shows if that could not be saved.
    return (
      <div className="space-y-4">
        <p>Calendar sync is not available yet.</p>
        <Button onClick={onNext}>Continue</Button>
      </div>
    );
  }
  if (!query.data) return <Loading label="Checking your calendar…" />;

  const status = query.data.status;
  return (
    <div className="space-y-4">
      <p>
        Connect Google Calendar to plan around your busy times and see your study blocks there.
        Upversion only changes events it created itself, in its own “Upversion” calendar. Everything
        else in your calendars is read-only. You can also do this later in Settings.
      </p>
      {status === 'connected' ? (
        <p role="status" className="font-bold text-ok">
          Google Calendar is connected.
        </p>
      ) : (
        <ConnectButton
          label={
            status === 'needs_reconnect' ? 'Reconnect Google Calendar' : 'Connect Google Calendar'
          }
          primary
          returnToSetup
        />
      )}
      <div>
        <Button onClick={onNext}>{status === 'connected' ? 'Continue' : 'Skip for now'}</Button>
      </div>
    </div>
  );
}
