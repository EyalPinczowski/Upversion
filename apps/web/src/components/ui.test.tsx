import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilePicker, ProgressBar } from './ui';

describe('ProgressBar', () => {
  it('is an accessible Blocks bar, not a native progress element', () => {
    const { container } = render(<ProgressBar value={2} max={5} label="Progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '5');
    expect(container.querySelector('progress')).toBeNull();
    expect(container.querySelector('.bg-accent')).toHaveStyle({ width: '40%' });
  });

  it('clamps the value into the range', () => {
    render(<ProgressBar value={9} max={5} label="Over" />);
    expect(screen.getByRole('progressbar', { name: 'Over' })).toHaveAttribute('aria-valuenow', '5');
  });
});

describe('FilePicker', () => {
  it('keeps the real input labelled and shows a button face', () => {
    render(
      <>
        <label htmlFor="f">Choose a thing</label>
        <FilePicker id="f" buttonLabel="Choose file" />
      </>,
    );
    const input = screen.getByLabelText('Choose a thing');
    expect(input).toHaveAttribute('type', 'file');
    expect(input.parentElement).toHaveTextContent('Choose file');
  });
});
