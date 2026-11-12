import { useCalendarUpdatedAt } from './auto-sync-state';

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso));

/**
 * A small, non-blocking "Calendar updated 10:32" line. The live region is always in the page and
 * only its text changes, so screen readers announce each update politely.
 */
export function CalendarUpdatedStatus({ className = '' }: { className?: string }) {
  const updatedAt = useCalendarUpdatedAt();
  return (
    <p role="status" aria-live="polite" className={`text-muted ${className}`.trim()}>
      {updatedAt ? `Calendar updated ${formatTime(updatedAt)}` : null}
    </p>
  );
}
