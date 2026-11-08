/** On phones the card floats above the tab bar (4rem) with a little air. */
const PHONE_CARD_BOTTOM = 'calc(5rem + env(safe-area-inset-bottom))';

/** Bottom padding for the page while the phone card is open: the bar, the card and some air. */
export function tourBottomPadding(cardHeight: number): string {
  return `calc(${PHONE_CARD_BOTTOM} + ${Math.ceil(cardHeight)}px + 1rem)`;
}

/** How far to scroll (down, in px) so a target is not covered by the card; never pushes it off the top. */
export function scrollToClearCard(
  target: { top: number; bottom: number },
  cardTop: number,
  gap = 16,
): number {
  const overlap = target.bottom - (cardTop - gap);
  return Math.max(0, Math.min(overlap, target.top));
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const POPUP =
  '[role="menu"], [role="listbox"], [role="combobox"], [role="tooltip"], [aria-modal="true"], dialog[open], [aria-expanded="true"]';

/** Escape ends the tour unless something else is using it (a handled key, a text field, an open popup). */
export function shouldCloseOnEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  const target = event.target;
  if (target instanceof Element && (target.closest(EDITABLE) || target.closest(POPUP)))
    return false;
  return true;
}
