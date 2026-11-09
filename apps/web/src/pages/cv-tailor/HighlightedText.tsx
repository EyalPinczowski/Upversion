import { PLACEHOLDER } from './tailor-model';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countPlaceholders(text: string): number {
  return text.split(PLACEHOLDER).length - 1;
}

/**
 * The answer as plain text (never HTML). Flagged items and each `[number?]` are wrapped in
 * `<mark>`; they are also bold and underlined, so colour is not the only signal.
 */
export function HighlightedText({ text, flags }: { text: string; flags: readonly string[] }) {
  const needles = [...new Set([PLACEHOLDER, ...flags.filter((f) => f.trim() !== '')])].sort(
    (a, b) => b.length - a.length,
  );
  const re = new RegExp(`(${needles.map(escapeRe).join('|')})`, 'g');
  const parts = text.split(re);
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            data-kind={part === PLACEHOLDER ? 'placeholder' : 'flag'}
            className="bg-warn-soft px-0.5 font-bold text-text underline decoration-2 underline-offset-2"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}
