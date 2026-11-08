import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './ui';

/**
 * A modal question with two answers. Focus starts on the safe answer (cancel), Tab stays inside
 * the dialog, Escape cancels and focus returns to where it was. It is a plain element rather than
 * <dialog> so it behaves the same in every browser and in tests.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  busy = false,
  role = 'alertdialog',
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** True while the confirmed action runs: both answers are disabled. */
  busy?: boolean;
  /** "dialog" for information with a choice; "alertdialog" (default) for a question that needs an answer. */
  role?: 'dialog' | 'alertdialog';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      // Back to the button that opened the dialog, unless the page replaced it meanwhile.
      if (before?.isConnected) before.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center p-4 sm:items-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.55)' }}
      onKeyDown={onKeyDown}
    >
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-md space-y-4 rounded-md border border-border bg-surface p-5"
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="space-y-2">
          {children}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant="primary" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
