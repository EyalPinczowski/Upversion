/**
 * The CV text a person chose to keep in this tab (ADR 016 section 2.1, owner decision 2).
 *
 * It lives in one module-level variable and nowhere else: never in web storage, IndexedDB, the
 * Cache API, the query cache, a URL or a React context. A reload or closing the tab drops it by
 * nature; sign-out and account switch clear it (`AuthProvider`); leaving the "Change my CV" page
 * with the box unticked clears it. Nothing is kept unless `set` is called, and the only caller is
 * the page that shows the unticked-by-default box.
 */
let text: string | null = null;

export const cvTextSession = {
  /** Keeps `value` for this tab. A blank text clears instead. */
  set(value: string): void {
    text = value.trim() === '' ? null : value;
  },
  get(): string | null {
    return text;
  },
  has(): boolean {
    return text !== null;
  },
  clear(): void {
    text = null;
  },
};
