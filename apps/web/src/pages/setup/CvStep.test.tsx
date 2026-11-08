import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as CvExtract from './cv-extract';
import { describe, expect, it, vi } from 'vitest';
import { extractCvText } from './cv-extract';
import { CvStep } from './CvStep';

/** Settles each pending read as cancelled, on demand (a real read can finish late). */
const settleReads: (() => void)[] = [];

vi.mock('./cv-extract', async (importOriginal) => {
  const original = await importOriginal<typeof CvExtract>();
  return {
    ...original,
    // A read that ends only when the test says so, as cancelled.
    extractCvText: vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          settleReads.push(() => reject(new original.CvCancelled()));
        }),
    ),
  };
});

const PASTE = 'Operations Coordinator 2019 - 2023\nExcel and SQL for weekly reports.';

describe('the CV step', () => {
  it('shows the "unreadable" message instead of crashing when reading pasted text fails', async () => {
    const onText = vi.fn(() => {
      throw new Error('matcher blew up');
    });
    render(<CvStep onText={onText} onSkip={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Paste text instead' }));
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.paste(PASTE);
    await userEvent.click(screen.getByRole('button', { name: 'Read this text' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t read this file');
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it('offers Cancel while a file is being read, and cancelling shows no error and sends no text', async () => {
    const onText = vi.fn();
    render(<CvStep onText={onText} onSkip={() => {}} />);
    await userEvent.upload(
      screen.getByLabelText(/Choose a PDF or DOCX file/),
      new File(['x'], 'cv.pdf'),
    );
    expect(await screen.findByText('Reading your CV on this device…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Reading your CV on this device…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onText).not.toHaveBeenCalled();
    // The read itself was told to stop (this is what frees the pdf.js worker).
    const options = vi.mocked(extractCvText).mock.calls.at(-1)?.[1];
    expect(options?.signal?.aborted).toBe(true);
  });

  it('stops a read still running when the step is left, so it cannot report text later', async () => {
    const onText = vi.fn();
    const view = render(<CvStep onText={onText} onSkip={() => {}} />);
    await userEvent.upload(
      screen.getByLabelText(/Choose a PDF or DOCX file/),
      new File(['x'], 'cv.pdf'),
    );
    await screen.findByText('Reading your CV on this device…');
    const options = vi.mocked(extractCvText).mock.calls.at(-1)?.[1];
    view.unmount();
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => {});
    expect(onText).not.toHaveBeenCalled();
  });

  it('keeps showing "Reading" for the second file after Cancel and a new pick', async () => {
    render(<CvStep onText={() => {}} onSkip={() => {}} />);
    const input = screen.getByLabelText(/Choose a PDF or DOCX file/);
    const first = settleReads.length;
    await userEvent.upload(input, new File(['x'], 'one.pdf'));
    await screen.findByText('Reading your CV on this device…');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.upload(input, new File(['x'], 'two.pdf'));
    await screen.findByText('Reading your CV on this device…');
    // The first read settles now, late; it must not switch the second one's busy state off.
    await act(async () => settleReads[first]!());
    expect(screen.getByText('Reading your CV on this device…')).toBeInTheDocument();
  });
});
