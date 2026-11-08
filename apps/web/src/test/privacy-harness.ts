import { vi } from 'vitest';
import { CV_TEXT, FORBIDDEN } from './cv-fixture';
import type { installSetupApi } from './setup-fixtures';

/** Shared by the CV privacy tests (setup wizard and Change my CV): every channel a leak could use. */

/** Everything the app sent: URL, method, header names and values, and body, of every request. */
export async function everythingSent(api: ReturnType<typeof installSetupApi>) {
  const parts: string[] = [];
  for (const call of api.calls) {
    parts.push(call.method, call.url);
    call.headers.forEach((value, name) => parts.push(`${name}: ${value}`));
    parts.push(await call.clone().text());
  }
  return parts.join('\n');
}

/** The first secret, or 30-character stretch of the CV text, found in `haystack`; else null. */
export function findLeak(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  for (const secret of FORBIDDEN) if (lower.includes(secret.toLowerCase())) return secret;
  for (let i = 0; i + 30 <= CV_TEXT.length; i++) {
    const piece = CV_TEXT.slice(i, i + 30);
    if (lower.includes(piece.toLowerCase())) return piece;
  }
  return null;
}

let restoreImageSrc: () => void = () => {};
let removeErrorListener: () => void = () => {};

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Records everything that leaves through console, sendBeacon and XMLHttpRequest. */
export function spyOnSideChannels() {
  const logged: string[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  const xhr: string[] = [];
  class FakeXhr {
    open(...args: unknown[]) {
      xhr.push(args.join(' '));
    }
    setRequestHeader(...args: unknown[]) {
      xhr.push(args.join(': '));
    }
    send(body?: unknown) {
      xhr.push(String(body));
    }
    addEventListener() {}
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  // Image requests (a tracking pixel), WebSockets and uncaught errors are channels too.
  const images: string[] = [];
  const originalSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: () => '',
    set(value: string) {
      images.push(String(value));
    },
  });
  restoreImageSrc = () => {
    if (originalSrc) Object.defineProperty(HTMLImageElement.prototype, 'src', originalSrc);
  };
  const sockets: string[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        sockets.push(String(url));
      }
    },
  );
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => {
    errors.push(`${event.message} ${event.error instanceof Error ? event.error.stack : ''}`);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  removeErrorListener = () => window.removeEventListener('error', onError);
  return { logged, beacon, xhr, images, sockets, errors };
}

export function webStorageDump() {
  const out: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      out.push(key, store.getItem(key) ?? '');
    }
  }
  return out.join('\n');
}

/** Puts back what `spyOnSideChannels` replaced. */
export function restoreSideChannels() {
  restoreImageSrc();
  removeErrorListener();
}
