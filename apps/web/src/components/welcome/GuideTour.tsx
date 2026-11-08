import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TourStep } from '../../lib/welcome';
import { Button } from '../ui';

const PHONE_MAX = 640;
const CARD_WIDTH = 320;
const GAP = 12;

interface Place {
  top: number;
  left: number;
}

function targetOf(step: TourStep): Element | null {
  for (const selector of step.targets) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/** Next to the target on tablets and desktops; null on phones, where the card sits at the bottom. */
function placeNear(target: Element | null, cardHeight: number): Place | null {
  if (!target || window.innerWidth < PHONE_MAX) return null;
  const rect = target.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - CARD_WIDTH - 16);
  const maxTop = Math.max(8, window.innerHeight - cardHeight - 8);
  return {
    left: Math.min(Math.max(8, rect.right + GAP), maxLeft),
    top: Math.min(Math.max(8, rect.top), maxTop),
  };
}

/**
 * A small guided tour: one card, not a modal (the page stays usable), pointing at the element of
 * the current step. Back / Next / Close are real buttons; Escape closes; step changes are announced
 * politely. Steps whose target is not on the screen are dropped by the caller.
 */
export function GuideTour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = steps[index]!;
  const last = index === steps.length - 1;

  // Mark the target, place the card, and keep it in place on resize and scroll.
  useLayoutEffect(() => {
    const target = targetOf(step);
    target?.setAttribute('data-tour-active', '');
    const update = () => setPlace(placeNear(target, card.current?.offsetHeight ?? 200));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      target?.removeAttribute('data-tour-active');
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step]);

  // Focus moves to the card when the tour starts and goes back where it was when it ends.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    return () => {
      const back =
        before && before !== document.body && before.isConnected
          ? before
          : document.getElementById('main');
      back?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const move = (delta: number) =>
    setIndex((i) => Math.min(Math.max(i + delta, 0), steps.length - 1));

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {`Step ${index + 1} of ${steps.length}: ${step.title}`}
      </div>
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={place ? { top: place.top, left: place.left, width: CARD_WIDTH } : undefined}
        className={`fixed z-20 space-y-3 rounded-md border border-border bg-surface p-4 ${
          place
            ? 'max-w-[calc(100vw-1rem)]'
            : 'inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))]'
        }`}
      >
        <p className="text-sm text-muted">
          Step {index + 1} of {steps.length}
        </p>
        <h2 id={titleId}>{step.title}</h2>
        <p>{step.body}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => move(-1)} disabled={index === 0}>
            Back
          </Button>
          <Button variant="primary" onClick={() => (last ? onClose() : move(1))}>
            {last ? 'Done' : 'Next'}
          </Button>
          <Button onClick={onClose} className="ml-auto">
            Close
          </Button>
        </div>
      </div>
    </>
  );
}
