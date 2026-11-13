import { useCalendarUpdatedAt } from './auto-sync-state';

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso));

/**
 * A small "Calendar updated 10:32" line, plain text on purpose: a live region would announce every
 * automatic run, and the manual "Sync now" result already has its own status message.
 */
export function CalendarUpdatedStatus({ className = '' }: { className?: string }) {
  const updatedAt = useCalendarUpdatedAt();
  if (!updatedAt) return null;
  return (
    <p className={`text-muted ${className}`.trim()}>Calendar updated {formatTime(updatedAt)}</p>
  );
}
