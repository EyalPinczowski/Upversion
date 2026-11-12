import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertIcon } from './icons';

const base =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-sm px-4 py-2 font-bold disabled:cursor-not-allowed disabled:opacity-60';

const variants = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  secondary: 'border border-border bg-surface-2 text-text hover:border-accent',
  // The warn colour plus the words say "careful"; colour is never the only signal.
  danger: 'border-2 border-warn bg-surface text-warn hover:bg-warn-soft',
} as const;

export type ButtonVariant = keyof typeof variants;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(function Button({ variant = 'secondary', className = '', type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    />
  );
});

/** Class string for a link that looks like a button, for places where navigation is the action. */
export const linkClass = 'font-bold text-accent underline underline-offset-2';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  /** Shown under the field and announced to screen readers. */
  error?: string | null;
}

/** A labelled input. The error is text with an icon, linked to the input, and announced. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className = '', ...props },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-bold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-muted">
          {hint}
        </p>
      ) : null}
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text placeholder:text-muted ${className}`}
        {...props}
      />
      {error ? <ErrorText id={errorId}>{error}</ErrorText> : null}
    </div>
  );
});

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
}

/** A labelled multi-line field, wired the same way as TextField. */
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, hint, error, className = '', ...props }, ref) {
    const id = useId();
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="block font-bold">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-muted">
            {hint}
          </p>
        ) : null}
        <textarea
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`min-h-11 w-full rounded-sm border border-border bg-surface px-3 py-2 text-text placeholder:text-muted ${className}`}
          {...props}
        />
        {error ? <ErrorText id={errorId}>{error}</ErrorText> : null}
      </div>
    );
  },
);

/** An error in words with an icon, announced when it appears. Never colour alone. */
export function ErrorText({ children, id }: { children: string; id?: string }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-2 font-bold text-warn">
      <AlertIcon />
      <span>{children}</span>
    </p>
  );
}

interface ProgressBarProps {
  value: number;
  max: number;
  /** Accessible name, or the id of the element that names the bar. */
  label?: string;
  labelledBy?: string;
  className?: string;
}

/** A Blocks progress bar: accent fill on a surface track. Text beside it carries the numbers. */
export function ProgressBar({ value, max, label, labelledBy, className = '' }: ProgressBarProps) {
  const top = Math.max(1, max);
  const now = max > 0 ? Math.max(0, Math.min(value, max)) : 0;
  const pct = Math.round((now / top) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={top}
      aria-valuenow={now}
      className={`h-3 w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
    >
      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

type FilePickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  /** Text on the visible button. */
  buttonLabel: string;
};

/**
 * A file input styled as a Blocks button. The real input stays in the page, transparent and laid
 * over the button, so clicks, the keyboard, screen readers and `label htmlFor` keep working. The
 * button shows the focus ring when the input has focus.
 */
export const FilePicker = forwardRef<HTMLInputElement, FilePickerProps>(function FilePicker(
  { buttonLabel, disabled, ...props },
  ref,
) {
  return (
    <span className="relative inline-flex">
      <input
        ref={ref}
        type="file"
        disabled={disabled}
        className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className={`${base} ${variants.secondary} pointer-events-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-hover:border-accent peer-focus-visible:outline-accent ${disabled ? 'opacity-60' : ''}`}
      >
        {buttonLabel}
      </span>
    </span>
  );
});
