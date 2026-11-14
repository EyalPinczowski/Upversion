import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isApiError } from '../../api/errors';
import { useSendMessage, type PracticeSession, type SessionDetail } from '../../api/practice-hooks';
import { Button, ErrorText } from '../../components/ui';
import { describeError, newId } from '../../lib/messages';
import { useReadOnlyPlan } from '../../plan/context';
import { AI_CAN_BE_WRONG, aiDownReason, REDACTION_NOTICE, type AiDown } from './ai-state';

const MAX_LENGTH = 4000;

type Message = SessionDetail['messages'][number];

/**
 * The notice for a missing AI. It names the two ways to go on without it, which the practice screen
 * shows right below (the copy-prompt and paste flow, and the self-check): practice is never blocked.
 */
export function AiUnavailableNotice({
  reason,
  onRetry,
  where = 'chat',
}: {
  reason: AiDown;
  onRetry?: () => void;
  /** `start`: before a session exists, so the choice is between the other ways to start. */
  where?: 'chat' | 'start';
}) {
  return (
    <div role="alert" className="space-y-2 border-l-4 border-warn pl-3">
      <p className="font-bold">AI unavailable</p>
      <p>
        {reason === 'cap'
          ? 'Today’s AI limit is used up. It starts again tomorrow.'
          : 'The AI can’t answer right now.'}{' '}
        {where === 'start'
          ? 'Choose another way to practise: use another assistant with a copied prompt, or practise on your own and score yourself with the self-check.'
          : 'You can still practise: copy the prompt below into another assistant and paste its feedback back, or score yourself with the self-check.'}
      </p>
      {reason === 'unavailable' && onRetry ? (
        <Button onClick={onRetry}>Try the AI again</Button>
      ) : null}
    </div>
  );
}

function sendProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'http') {
    if (error.code === 'turn_in_progress') {
      return 'A reply is still being written. Wait a moment, then send again.';
    }
    if (error.code === 'turn_superseded' || error.code === 'message_superseded') {
      return 'This message was replaced by a newer one, so it was not sent again. Check the conversation above.';
    }
    if (error.code === 'rate_limited') {
      return RATE_LIMITED_TEXT;
    }
  }
  return describeError(error, 'The message could not be sent.');
}

/** One sentence for a rate-limited turn or AI finish. */
export const RATE_LIMITED_TEXT = 'Too many requests in a minute. Wait a moment, then try again.';

/**
 * Notes are keyed by their place among the notes, not by id: the note added when a reply arrives has
 * a made-up id until the stored transcript replaces it, and a new key would announce it twice.
 */
function lineKey(messages: SessionDetail['messages'], index: number): string {
  const message = messages[index]!;
  if (message.role !== 'note') return message.id;
  return `note-${messages.slice(0, index).filter((m) => m.role === 'note').length}`;
}

function Line({ message }: { message: Message }) {
  if (message.role === 'note') {
    return <p className="italic text-muted">{message.content}</p>;
  }
  const mine = message.role === 'user';
  // Plain text, like everything the model wrote: React escapes it and nothing becomes a link.
  return (
    <div className={mine ? 'space-y-1 border-l-4 border-accent pl-3' : 'space-y-1 pl-4'}>
      <p className="font-bold text-muted">{mine ? 'You' : 'Assistant'}</p>
      <p className="whitespace-pre-wrap break-words">{message.content}</p>
      {mine && message.redacted ? <p className="text-muted">{REDACTION_NOTICE}</p> : null}
    </div>
  );
}

/**
 * The in-app chat. Everything the model writes is shown as plain text. The conversation is the one
 * live region (`role="log"`), so each new line is announced once; the opener present at load is not.
 * A failed send keeps the text and the message id, so sending again is a retry, never a duplicate.
 */
export function ChatPanel({
  planId,
  session,
  messages,
  aiDown,
  onAiDown,
  onRetryAi,
  onAskFeedback,
}: {
  planId: string;
  session: PracticeSession;
  messages: SessionDetail['messages'];
  aiDown: AiDown | null;
  onAiDown: (reason: AiDown) => void;
  onRetryAi: () => void;
  onAskFeedback: () => void;
}) {
  const readOnly = useReadOnlyPlan();
  const send = useSendMessage(planId, session.id);
  const [draft, setDraft] = useState('');
  const attempt = useRef<{ id: string; content: string } | null>(null);
  const textareaId = useId();
  const hintId = useId();
  const logRef = useRef<HTMLDivElement>(null);
  const spoke = messages.some((m) => m.role === 'user');

  // Keep the newest message in view.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || send.isPending || aiDown) return;
    if (attempt.current?.content !== content) attempt.current = { id: newId(), content };
    send.mutate(attempt.current, {
      onSuccess: () => {
        attempt.current = null;
        setDraft('');
      },
      onError: (error) => {
        const reason = aiDownReason(error);
        if (reason) onAiDown(reason);
        // A replaced message must not be sent again under its old id: the next send is a new one.
        if (
          isApiError(error) &&
          (error.code === 'turn_superseded' || error.code === 'message_superseded')
        ) {
          attempt.current = null;
        }
      },
    });
  }

  const problem = send.error && !aiDownReason(send.error) ? sendProblem(send.error) : null;
  const label = send.isPending ? 'Waiting for the reply…' : send.isError ? 'Send again' : 'Send';

  return (
    <section aria-labelledby="chat-heading" className="space-y-3">
      <h2 id="chat-heading">Practice chat</h2>
      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        className="max-h-96 space-y-3 overflow-auto py-1"
        tabIndex={0}
      >
        {messages.map((message, index) => (
          <Line key={lineKey(messages, index)} message={message} />
        ))}
      </div>

      {aiDown ? <AiUnavailableNotice reason={aiDown} onRetry={onRetryAi} /> : null}

      {readOnly ? (
        <div className="space-y-2">
          <p className="font-bold">
            This plan is archived (read-only), so the chat can’t continue. You can still ask for
            feedback or end the practice.
          </p>
          <Button disabled={!spoke || !!aiDown} onClick={onAskFeedback}>
            Get AI feedback
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <label htmlFor={textareaId} className="block font-bold">
            Your answer
          </label>
          <p id={hintId} className="text-muted">
            Emails, phone numbers and links are removed before sending. Names are not always caught,
            so leave them out.
          </p>
          <textarea
            id={textareaId}
            aria-describedby={hintId}
            value={draft}
            maxLength={MAX_LENGTH}
            rows={4}
            disabled={!!aiDown}
            readOnly={send.isPending}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!!aiDown || send.isPending}>
              {label}
            </Button>
            <Button disabled={!spoke || !!aiDown || send.isPending} onClick={onAskFeedback}>
              Get AI feedback
            </Button>
          </div>
          <p role="status" className="text-muted">
            {send.isPending ? 'Reply on its way' : ''}
          </p>
          {problem ? <ErrorText>{problem}</ErrorText> : null}
        </form>
      )}
      <p className="text-muted">{AI_CAN_BE_WRONG}</p>
    </section>
  );
}
