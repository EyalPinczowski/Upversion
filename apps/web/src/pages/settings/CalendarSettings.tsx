import { useEffect, useState } from 'react';
import {
  useCalendarStatus,
  useConnectCalendar,
  useDisconnectCalendar,
  useSetCalendarSources,
  useSyncCalendar,
  type CalendarStatus,
} from '../../api/calendar-hooks';
import { isApiError } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, ErrorText } from '../../components/ui';
import { clearSetupReturn, rememberSetupReturn } from '../../lib/setup-return';
import { lastErrorText, STATUS_TEXT } from './calendar-text';

const TITLE_ID = 'calendar-heading';

const problem = (error: unknown, whenRefused: string) =>
  isApiError(error) && error.kind !== 'http'
    ? 'Can’t reach the server. Check your connection and try again.'
    : whenRefused;

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby={TITLE_ID}
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id={TITLE_ID}>Calendar</h3>
      {children}
    </section>
  );
}

/** Starts the Google consent flow. Used here and by the reconnect banner. */
export function ConnectButton({
  label,
  primary = false,
  returnToSetup = false,
}: {
  label: string;
  primary?: boolean;
  /** The connect flow started in the setup wizard: the callback page then links back to it. */
  returnToSetup?: boolean;
}) {
  const connect = useConnectCalendar();
  const { reset } = connect;
  // Coming back with the Back button restores this page from the cache with the button still
  // showing "Opening Google…": make it usable again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) reset();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [reset]);
  return (
    <>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        onClick={() => {
          if (returnToSetup) rememberSetupReturn();
          else clearSetupReturn();
          connect.mutate();
        }}
        disabled={connect.isPending || connect.isSuccess}
      >
        {connect.isPending || connect.isSuccess ? 'Opening Google…' : label}
      </Button>
      {connect.error ? (
        <ErrorText>
          {problem(connect.error, 'We couldn’t start the connection. Try again in a moment.')}
        </ErrorText>
      ) : null}
    </>
  );
}

function Sources({ status }: { status: CalendarStatus }) {
  const save = useSetCalendarSources();
  if (status.sources.length === 0) return null;

  function toggle(calendarId: string, blocksTime: boolean) {
    save.mutate(
      status.sources.map((s) => ({
        calendarId: s.calendarId,
        blocksTime: s.calendarId === calendarId ? blocksTime : s.blocksTime,
      })),
    );
  }

  return (
    <fieldset className="space-y-1" disabled={save.isPending}>
      <legend className="font-bold">Your calendars</legend>
      <p className="text-muted">
        Events in a calendar marked “Counts as busy” take time away from your study hours.
      </p>
      {status.sources.map((source) => (
        <label key={source.calendarId} className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={source.blocksTime}
            onChange={(event) => toggle(source.calendarId, event.target.checked)}
            className="size-5 accent-accent"
          />
          <span>
            {source.name} <span className="text-muted">– Counts as busy</span>
          </span>
        </label>
      ))}
      {save.error ? (
        <ErrorText>
          {problem(save.error, 'We couldn’t save that choice. Nothing was changed.')}
        </ErrorText>
      ) : null}
    </fieldset>
  );
}

function Connected({ status }: { status: CalendarStatus }) {
  const sync = useSyncCalendar();
  const disconnect = useDisconnectCalendar();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {status.status === 'connected' ? (
          <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : null}
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      </div>
      <div role="status">
        {sync.data ? (
          <p className="font-bold text-ok">
            {sync.data.text}{' '}
            {sync.data.movedTaskIds.length === 0
              ? 'No tasks moved.'
              : `${sync.data.movedTaskIds.length} ${sync.data.movedTaskIds.length === 1 ? 'task' : 'tasks'} moved.`}
          </p>
        ) : null}
      </div>
      {sync.error ? (
        <ErrorText>
          {problem(sync.error, 'The sync did not finish. Your plan was not changed.')}
        </ErrorText>
      ) : null}
      {disconnect.error ? (
        <ErrorText>
          {problem(disconnect.error, 'We couldn’t disconnect. Nothing was changed. Try again.')}
        </ErrorText>
      ) : null}
      <Sources status={status} />
      {confirming ? (
        <ConfirmDialog
          title="Disconnect Google Calendar?"
          confirmLabel="Disconnect"
          cancelLabel="Keep it connected"
          busy={disconnect.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => disconnect.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          <p>
            The study blocks Upversion added to its own calendar are removed from Google. Your other
            events are not touched. Your plan stays as it is.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/**
 * Settings > Calendar (spec 3.8). Renders nothing at all when the server has the feature off
 * (the status answers 404), so the section never shows up half-working.
 */
export function CalendarSettings() {
  const query = useCalendarStatus();

  if (query.data === null) return null;
  if (query.isError) {
    return (
      <Shell>
        <ErrorText>We couldn’t load your calendar connection.</ErrorText>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </Shell>
    );
  }
  // Nothing while the first answer is pending: with the feature off the section must never flash.
  if (query.data === undefined) return null;

  const status = query.data;
  const error = lastErrorText(status.lastErrorCode);

  return (
    <Shell>
      <p>
        Optional. Connect Google Calendar to plan around your busy times and see your study blocks
        there. Upversion only changes events it created itself, in its own “Upversion” calendar.
        Everything else in your calendars is read-only.
      </p>
      <p>
        <strong>Status:</strong> {STATUS_TEXT[status.status]}
        {status.lastSyncedAt ? ` Last synced ${formatDateTime(status.lastSyncedAt)}.` : null}
      </p>
      {error && status.status !== 'disconnected' ? <p className="text-warn">{error}</p> : null}
      {status.status === 'disconnected' ? (
        <ConnectButton label="Connect Google Calendar" primary />
      ) : null}
      {status.status === 'needs_reconnect' ? (
        <ConnectButton label="Reconnect Google Calendar" primary />
      ) : null}
      {status.status !== 'disconnected' ? <Connected status={status} /> : null}
    </Shell>
  );
}
