import { useSyncExternalStore } from 'react';

/**
 * Small shared state of the automatic calendar sync: the per-device on/off setting and the time
 * of the last successful sync. Kept outside React so Settings, the week grid and the sync hook
 * read the same values without a provider.
 */

/** Mutation `meta` flag: this change moves planned blocks, so the calendar should be looked at soon. */
export const CHANGES_PLANNED_BLOCKS = { changesPlannedBlocks: true } as const;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// ---- The setting (per user, per device) ----

export const autoSyncStorageKey = (userId: string) => `upversion.calendar-auto-sync.${userId}`;

/** Used when storage is blocked, so the checkbox still works for the open tab. */
const memory = new Map<string, boolean>();

/** Default ON; only an explicit "off" turns it off. */
export function readAutoSyncEnabled(userId: string): boolean {
  try {
    const stored = window.localStorage.getItem(autoSyncStorageKey(userId));
    return stored !== 'off';
  } catch {
    // Storage blocked: the in-memory value (this tab only) or the default.
    return memory.get(userId) ?? true;
  }
}

export function writeAutoSyncEnabled(userId: string, enabled: boolean): void {
  memory.set(userId, enabled);
  try {
    window.localStorage.setItem(autoSyncStorageKey(userId), enabled ? 'on' : 'off');
  } catch {
    // Storage blocked: the in-memory value still applies to this tab.
  }
  notify();
}

export function useAutoSyncEnabled(userId: string): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, () => readAutoSyncEnabled(userId));
  return [enabled, (next) => writeAutoSyncEnabled(userId, next)];
}

// ---- The "Calendar updated <time>" line ----

let updatedAt: string | null = null;

export function recordCalendarUpdate(iso: string | null): void {
  updatedAt = iso;
  notify();
}

export function useCalendarUpdatedAt(): string | null {
  return useSyncExternalStore(subscribe, () => updatedAt);
}
