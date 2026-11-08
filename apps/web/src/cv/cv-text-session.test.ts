import { afterEach, describe, expect, it, vi } from 'vitest';
import { cvTextSession } from './cv-text-session';

afterEach(() => {
  cvTextSession.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the in-memory CV text holder', () => {
  it('holds nothing by default', () => {
    expect(cvTextSession.has()).toBe(false);
    expect(cvTextSession.get()).toBeNull();
  });

  it('keeps a text until cleared, and a blank text clears it', () => {
    cvTextSession.set('Excel and SQL for weekly reports.');
    expect(cvTextSession.get()).toBe('Excel and SQL for weekly reports.');
    cvTextSession.set('   ');
    expect(cvTextSession.has()).toBe(false);
    cvTextSession.set('again');
    cvTextSession.clear();
    expect(cvTextSession.get()).toBeNull();
  });

  it('never touches web storage, IndexedDB or the Cache API', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const indexedDB = { open: vi.fn() };
    const caches = { open: vi.fn() };
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('caches', caches);
    cvTextSession.set('Excel and SQL for weekly reports. CANARY-1');
    cvTextSession.get();
    cvTextSession.clear();
    expect(setItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });
});
