import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface PlanTab {
  id: string;
  label: string;
  /** `data-tour` hook for the welcome guide. */
  tour?: string;
}

const tabId = (id: string) => `plan-tab-${id}`;
const panelId = (id: string) => `plan-panel-${id}`;

/**
 * An accessible tab list (WAI-ARIA tabs, automatic activation): one tab stop, arrow keys, Home and
 * End. Both panels stay mounted (the inactive one is `hidden`), so `aria-controls` always
 * resolves and unsaved edits survive a tab switch.
 */
export function PlanTabs({
  tabs,
  active,
  onChange,
  children,
}: {
  tabs: PlanTab[];
  active: string;
  onChange: (id: string) => void;
  children: (id: string) => ReactNode;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    let target: number | null = null;
    if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target]!;
    onChange(next.id);
    refs.current[next.id]?.focus();
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Plan sections" className="flex gap-1 border-b border-border">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              data-tour={tab.tour}
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`-mb-px min-h-11 border-b-4 px-4 font-bold ${
                selected ? 'border-accent text-text' : 'border-transparent text-muted'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={panelId(tab.id)}
          aria-labelledby={tabId(tab.id)}
          hidden={tab.id !== active}
          className="space-y-6"
        >
          {children(tab.id)}
        </div>
      ))}
    </div>
  );
}
