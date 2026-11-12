import { useLocation } from 'react-router';
import { useCalendarStatus } from '../api/calendar-hooks';
import { useAuth } from '../auth/AuthProvider';
import { useAutoCalendarSync } from '../calendar/useAutoCalendarSync';
import { ConnectButton } from '../pages/settings/CalendarSettings';
import { AlertIcon } from './icons';

/**
 * Two small jobs for the optional calendar link, both silent when the feature is off (the status
 * answers 404) or when nothing is connected:
 * - keep the calendar up to date while the app is open (`useAutoCalendarSync`; a failure changes
 *   nothing and shows nothing, the schedule never depends on the calendar);
 * - show the "Reconnect calendar" banner when Google no longer accepts the connection. The app
 *   keeps working on its own data meanwhile.
 */
export function CalendarWatcher() {
  const { state: auth } = useAuth();
  const status = useCalendarStatus();
  const state = status.data?.status;
  const { pathname } = useLocation();
  useAutoCalendarSync(auth.status === 'signedIn' ? auth.session.userId : '');

  // Those two pages carry the same controls themselves.
  if (
    state !== 'needs_reconnect' ||
    pathname === '/calendar/callback' ||
    pathname === '/settings'
  ) {
    return null;
  }
  return (
    <div
      role="region"
      aria-label="Calendar connection"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warn bg-warn-soft p-3"
    >
      <AlertIcon />
      <p className="grow font-bold">
        Google Calendar needs to be reconnected. Everything else keeps working.
      </p>
      <ConnectButton label="Reconnect calendar" primary />
    </div>
  );
}
