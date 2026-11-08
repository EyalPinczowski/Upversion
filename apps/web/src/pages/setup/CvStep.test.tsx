import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as CvExtract from './cv-extract';
import { describe, expect, it, vi } from 'vitest';
import { extractCvText } from './cv-extract';
import { CvStep } from './CvStep';

vi.mock('./cv-extract', async (importOriginal) => {
  const original = await importOriginal<typeof CvExtract>();
  return {
    ...original,
    // A read that never ends until the signal aborts it.
    extractCvText: vi.fn(
      (_file: File, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new original.CvCancelled()));
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
});
