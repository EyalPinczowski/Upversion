import { useEffect, useRef, useState } from 'react';
import type { DayState } from '../../api/client';
import { useEndDay, useStartDay } from '../../api/hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CheckIcon, LockIcon } from '../../components/icons';
import { Button, ErrorText } from '../../components/ui';
import { describeError } from '../../lib/messages';
import { useReadOnlyPlan } from '../../plan/context';
import { BriefingLink, ReviewLink } from './day-destinations';

type Message = { tone: 'ok'; text: string } | { tone: 'error'; text: string };

/**
 * Start and end of today's study day. Both calls are idempotent on the server; the in-flight guard
 * here also stops a double click from sending two requests. Results are announced in a live region
 * and focus moves to it, because the pressed button is replaced by the next state.
 */
export function DayControls({
  planId,
  date,
  day,
}: {
  planId: string;
  date: string;
  day: DayState;
}) {
  const readOnly = useReadOnlyPlan();
  const start = useStartDay(planId);
  const end = useEndDay(planId);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message) statusRef.current?.focus();
  }, [message]);

  function run(
    mutation: typeof start | typeof end,
    success: string,
    failure: string,
    afterwards?: () => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    mutation.mutate(date, {
      onSuccess: () => setMessage({ tone: 'ok', text: success }),
      onError: (error) => setMessage({ tone: 'error', text: describeError(error, failure) }),
      onSettled: () => {
        inFlight.current = false;
        afterwards?.();
      },
    });
  }

  const status = (
    <div ref={statusRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
      {message?.tone === 'ok' ? (
        <p role="status" className="font-bold text-ok">
          {message.text}
        </p>
      ) : null}
      {message?.tone === 'error' ? <ErrorText>{message.text}</ErrorText> : null}
    </div>
  );

  // An archived plan is read-only: no start or end of the day (the banner says why).
  if (readOnly && day.status !== 'ended') {
    return (
      <section aria-label="Study day" className="space-y-3">
        <BriefingLink date={date} />
      </section>
    );
  }

  let content;
  if (day.status === 'ended') {
    content = (
      <>
        <p className="flex items-center gap-2 text-lg font-bold">
          <LockIcon />
          Day ended
        </p>
        <p className="text-muted">
          This day is frozen. Work you did not finish moved to the next study day.
        </p>
        <ReviewLink date={date} />
      </>
    );
  } else if (day.status === 'started') {
    content = (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-lg font-bold text-ok">
            <CheckIcon />
            Day started
          </p>
          <Button onClick={() => setConfirming(true)} disabled={end.isPending}>
            End day
          </Button>
        </div>
        <BriefingLink date={date} />
        {confirming ? (
          <ConfirmDialog
            title="End today?"
            confirmLabel="End day"
            cancelLabel="Keep working"
            busy={end.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() =>
              run(end, 'Day ended.', 'Could not end the day.', () => setConfirming(false))
            }
          >
            <p>Ending the day freezes it: today’s blocks stay as they are and no longer change.</p>
            <p>Work you have not finished moves to the next study day.</p>
          </ConfirmDialog>
        ) : null}
      </>
    );
  } else {
    content = (
      <>
        <Button
          variant="primary"
          className="min-h-14 w-full text-lg sm:w-auto sm:min-w-64"
          disabled={start.isPending}
          onClick={() => run(start, 'Day started.', 'Could not start the day.')}
        >
          Start study day
        </Button>
        <BriefingLink date={date} />
      </>
    );
  }

  return (
    <section aria-label="Study day" className="space-y-3">
      {content}
      {status}
    </section>
  );
}
