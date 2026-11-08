import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes everything outside `host` unreachable while it is mounted: the siblings of the host and of
 * each of its ancestors get `inert` (supported since Chrome 102, Safari 15.5, Firefox 112; older
 * browsers still get the document-level focus trap below). Tab can never leave the dialog, even
 * after a click on the backdrop moved focus to the page, and Escape works wherever focus is.
 *
 * Only elements that exist when the dialog opens are made inert; the page is not expected to
 * render new regions behind a welcome dialog.
 */
export function useModalIsolation(host: RefObject<HTMLElement | null>, onEscape: () => void) {
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const marked: Element[] = [];
    for (
      let node: Element | null = root;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') continue;
        sibling.setAttribute('inert', '');
        marked.push(sibling);
      }
    }
    return () => {
      for (const el of marked) el.removeAttribute('inert');
    };
  }, [host]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = host.current;
      if (!root) return;
      if (event.key === 'Escape') {
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (!active || !root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [host, onEscape]);
}
