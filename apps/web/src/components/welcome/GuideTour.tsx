import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { scrollToClearCard, tourBottomPadding, shouldCloseOnEscape } from '../../lib/tour-layout';
import { findTourTarget, normalizePath, type TourStep } from '../../lib/welcome';
import { Button } from '../ui';

const PHONE_MAX = 640;
const CARD_WIDTH = 320;
const GAP = 12;
/** How long a step waits for its target (after going to its page) before it is skipped. */
const TARGET_WAIT_MS = 3000;

interface Place {
  top: number;
  left: number;
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

/** Calls done with the step's target as soon as it exists, or with null after the wait. Returns a cancel. */
function waitForTarget(
  step: TourStep,
  waitMs: number,
  done: (target: Element | null) => void,
): () => void {
  const now = findTourTarget(step);
  if (now) {
    done(now);
    return () => {};
  }
  let finished = false;
  const stop = () => {
    finished = true;
    observer.disconnect();
    clearTimeout(timer);
  };
  const finish = (target: Element | null) => {
    if (finished) return;
    stop();
    done(target);
  };
  const observer = new MutationObserver(() => {
    const found = findTourTarget(step);
    if (found) finish(found);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setTimeout(() => finish(findTourTarget(step)), waitMs);
  return stop;
}

/**
 * A small guided tour: one card, not a modal (the page stays usable), pointing at the element of
 * the current step. Back / Next / Close are real buttons; Escape closes; step changes are announced
 * politely. Each step is resolved when it is reached: the tour goes to the step's page, waits for
 * the target, and skips the step if it never shows up.
 */
export function GuideTour({
  steps,
  onClose,
  targetWaitMs = TARGET_WAIT_MS,
}: {
  steps: TourStep[];
  onClose: () => void;
  targetWaitMs?: number;
}) {
  const titleId = useId();
  const countId = useId();
  const bodyId = useId();
  // useNavigate changes identity on every location change: read it through a ref so a manual
  // navigation does not restart the step (and pull the person back to its page).
  const navigate = useNavigate();
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  }, [navigate]);
  const { pathname } = useLocation();
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);
  const [index, setIndex] = useState(0);
  const direction = useRef(1);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(() => new Set());
  const [resolved, setResolved] = useState<{ index: number; target: Element } | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const live = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  // The step on show is the last one that was resolved, so the card never flashes a step that is skipped.
  const shown = resolved?.index ?? index;
  const step = steps[shown]!;
  const last = shown === steps.length - 1;
  const atStart = steps.slice(0, shown).every((_, i) => skipped.has(i));
  const total = steps.length - skipped.size;
  const position = steps.slice(0, shown + 1).filter((_, i) => !skipped.has(i)).length;
  const label = `Step ${position} of ${total}`;

  // Reach a step: go to its page, wait for the target, skip the step if there is none.
  useEffect(() => {
    const wanted = steps[index]!;
    if (normalizePath(path.current) !== wanted.route) void go.current(wanted.route);
    return waitForTarget(wanted, targetWaitMs, (target) => {
      if (target) {
        setResolved({ index, target });
        return;
      }
      setSkipped((prev) => new Set(prev).add(index));
      const after = index + direction.current;
      if (after >= 0 && after < steps.length) setIndex(after);
      else if (direction.current > 0) onClose();
      else {
        direction.current = 1;
        setIndex(index + 1);
      }
    });
    // onClose is read when the wait ends; a new identity must not restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, steps, targetWaitMs]);

  // Mark the target, place the card, keep it clear of the target on phones, and follow resize and scroll.
  useLayoutEffect(() => {
    if (!resolved) return;
    const { target } = resolved;
    target.setAttribute('data-tour-active', '');
    const main = document.getElementById('main');
    const update = () => {
      const height = card.current?.offsetHeight ?? 200;
      const phone = window.innerWidth < PHONE_MAX;
      if (main) main.style.paddingBottom = phone ? tourBottomPadding(height) : '';
      setPlace(placeNear(target, height));
    };
    update();
    if (
      window.innerWidth < PHONE_MAX &&
      card.current &&
      !target.closest('nav[aria-label="Main"]')
    ) {
      const delta = scrollToClearCard(
        target.getBoundingClientRect(),
        card.current.getBoundingClientRect().top,
      );
      if (delta > 0) window.scrollBy(0, delta);
    }
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      target.removeAttribute('data-tour-active');
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [resolved]);

  // Focus moves to the card when the tour starts and goes back where it was when it ends.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    const main = document.getElementById('main');
    return () => {
      if (main) main.style.paddingBottom = '';
      const back =
        before && before !== document.body && before.isConnected
          ? before
          : document.getElementById('main');
      back?.focus();
    };
  }, []);

  // A step change can drop focus (a disabled Back, or the page taking focus after a route change): keep it on Next.
  useEffect(() => {
    if (!resolved) return;
    const keep = () => {
      const active = document.activeElement;
      const lost =
        !active ||
        active === document.body ||
        active.id === 'main' ||
        (active instanceof HTMLButtonElement && active.disabled);
      if (lost) next.current?.focus();
    };
    keep();
    const timer = setTimeout(keep, 0);
    return () => clearTimeout(timer);
  }, [resolved]);

  // The live region starts empty and is filled after it is mounted, so the first message is announced too.
  useEffect(() => {
    if (live.current) live.current.textContent = `${label}: ${step.title}`;
  }, [label, step.title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldCloseOnEscape(event)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const move = (delta: number) => {
    direction.current = delta;
    setIndex((i) => Math.min(Math.max(i + delta, 0), steps.length - 1));
  };

  return (
    <>
      <div ref={live} role="status" aria-live="polite" className="sr-only" />
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={`${countId} ${bodyId}`}
        tabIndex={-1}
        style={place ? { top: place.top, left: place.left, width: CARD_WIDTH } : undefined}
        className={`fixed z-20 space-y-3 rounded-md border border-border bg-surface p-4 ${
          place
            ? 'max-w-[calc(100vw-1rem)]'
            : 'inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))]'
        }`}
      >
        <p id={countId} className="text-sm text-muted">
          {label}
        </p>
        <h2 id={titleId}>{step.title}</h2>
        <p id={bodyId}>{step.body}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => move(-1)} disabled={atStart}>
            Back
          </Button>
          <Button ref={next} variant="primary" onClick={() => (last ? onClose() : move(1))}>
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
