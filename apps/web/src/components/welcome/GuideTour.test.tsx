import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TourStep } from '../../lib/welcome';
import { scrollToClearCard, shouldCloseOnEscape, tourBottomPadding } from '../../lib/tour-layout';
import { GuideTour } from './GuideTour';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const step = (id: string, route: string, target: string): TourStep => ({
  id,
  title: id.toUpperCase(),
  body: `About ${id}`,
  route,
  targets: [target],
});

/** Two pages: /a has #a, /b has #b (shown after `delay` ms, like a page that loads its data). */
function Late({ delay }: { delay: number }) {
  const [ready, setReady] = useState(delay === 0);
  useEffect(() => {
    if (delay === 0) return;
    const timer = setTimeout(() => setReady(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return ready ? <button id="b">B</button> : null;
}

function Pages({ delay = 0 }: { delay?: number }) {
  return (
    <Routes>
      <Route path="/a" element={<button id="a">A</button>} />
      <Route path="/b" element={<Late delay={delay} />} />
    </Routes>
  );
}

function LocationText() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function mount(steps: TourStep[], { path = '/a', delay = 0, wait = 80, onClose = vi.fn() } = {}) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Pages delay={delay} />
      <LocationText />
      <GuideTour steps={steps} onClose={onClose} targetWaitMs={wait} />
    </MemoryRouter>,
  );
  return { onClose };
}

const A = step('a', '/a', '#a');
const B = step('b', '/b', '#b');
const MISSING = step('gone', '/a', '#nope');

describe('lazy steps', () => {
  it('goes to the step page when it is reached, then finds the target there', async () => {
    mount([A, B]);
    await screen.findByRole('dialog', { name: 'A' });
    expect(screen.getByTestId('where')).toHaveTextContent('/a');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/b');
    expect(document.getElementById('b')).toHaveAttribute('data-tour-active');
  });

  it('waits for a target that appears after the page change', async () => {
    mount([A, B], { delay: 30, wait: 1000 });
    await screen.findByRole('dialog', { name: 'A' });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(document.getElementById('b')).toHaveAttribute('data-tour-active'));
    expect(screen.getByRole('dialog', { name: 'B' })).toBeInTheDocument();
  });

  it('skips a step whose target is still missing after the route change, in both directions', async () => {
    mount([A, MISSING, B]);
    await screen.findByRole('dialog', { name: 'A' });
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('ends the tour when the remaining steps are all missing', async () => {
    const { onClose } = mount([A, MISSING]);
    await screen.findByRole('dialog', { name: 'A' });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('focus', () => {
  it('moves focus to Next when Back becomes disabled at step 1', async () => {
    mount([A, B]);
    await screen.findByRole('dialog', { name: 'A' });
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: 'B' });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('dialog', { name: 'A' });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus());
  });
});

describe('announcement and description', () => {
  it('renders the live region empty and fills it after mount', async () => {
    const html = renderToString(
      <MemoryRouter>
        <GuideTour steps={[A]} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toMatch(/role="status"[^>]*><\/div>/);
    mount([A]);
    expect(await screen.findByText('Step 1 of 1: A')).toHaveAttribute('aria-live', 'polite');
  });

  it('describes the card by its step count and its body', async () => {
    mount([A, B]);
    const card = await screen.findByRole('dialog', { name: 'A' });
    const ids = card.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Step 1 of 2',
      'About a',
    ]);
    expect(card).toHaveAccessibleDescription('Step 1 of 2 About a');
  });
});

describe('Escape', () => {
  const key = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init });
    Object.defineProperty(event, 'target', { value: target });
    return event;
  };

  it('ends the tour from the page', async () => {
    const { onClose } = mount([A]);
    await screen.findByRole('dialog', { name: 'A' });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores handled events, editable fields and popups', async () => {
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-expanded', 'true');
    const plain = document.createElement('button');
    expect(shouldCloseOnEscape(key(plain))).toBe(true);
    expect(shouldCloseOnEscape(key(plain, { cancelable: true }))).toBe(true);
    expect(shouldCloseOnEscape(key(input))).toBe(false);
    expect(shouldCloseOnEscape(key(editable))).toBe(false);
    expect(shouldCloseOnEscape(key(item))).toBe(false);
    expect(shouldCloseOnEscape(key(trigger))).toBe(false);
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    expect(shouldCloseOnEscape(handled)).toBe(false);
  });

  it('leaves the tour open when a text field uses Escape', async () => {
    const { onClose } = mount([A]);
    await screen.findByRole('dialog', { name: 'A' });
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('phone layout', () => {
  it('pads the page under the card while the tour is open and clears it after', async () => {
    vi.stubGlobal('innerWidth', 400);
    const main = document.createElement('main');
    main.id = 'main';
    document.body.append(main);
    const view = render(
      <MemoryRouter initialEntries={['/a']}>
        <Pages />
        <GuideTour steps={[A]} onClose={() => {}} targetWaitMs={50} />
      </MemoryRouter>,
      { container: main },
    );
    await screen.findByRole('dialog', { name: 'A' });
    await waitFor(() => expect(main.style.paddingBottom).toContain('calc('));
    view.unmount();
    expect(main.style.paddingBottom).toBe('');
  });

  it('does not pad the page on wider screens', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    document.body.append(main);
    render(
      <MemoryRouter initialEntries={['/a']}>
        <Pages />
        <GuideTour steps={[A]} onClose={() => {}} targetWaitMs={50} />
      </MemoryRouter>,
      { container: main },
    );
    await screen.findByRole('dialog', { name: 'A' });
    expect(main.style.paddingBottom).toBe('');
  });

  it('computes the padding and the scroll that keep a target clear of the card', () => {
    expect(tourBottomPadding(180.4)).toBe(
      'calc(calc(5rem + env(safe-area-inset-bottom)) + 181px + 1rem)',
    );
    // Target hidden behind the card: scroll by the overlap plus the gap.
    expect(scrollToClearCard({ top: 500, bottom: 540 }, 520)).toBe(36);
    // Already clear.
    expect(scrollToClearCard({ top: 100, bottom: 140 }, 520)).toBe(0);
    // Never scroll the target off the top.
    expect(scrollToClearCard({ top: 20, bottom: 600 }, 300)).toBe(20);
  });
});
