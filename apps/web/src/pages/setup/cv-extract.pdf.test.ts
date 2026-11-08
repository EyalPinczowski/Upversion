// @vitest-environment node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CvReadError, extractPdfText, type PdfjsLike } from './cv-extract';
import { buildPdf } from '../../test/pdf-fixture';

/** The real pdf.js (the same legacy build the app loads), run in Node on generated PDFs. */
async function realPdfjs(): Promise<PdfjsLike> {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
  return lib as unknown as PdfjsLike;
}

const LONG = 'Coordinated shipment schedules and reported weekly results to the regional team.';

describe('PDF text extraction with the real pdf.js', () => {
  it('keeps one line break per text line and joins pages', async () => {
    const pdf = buildPdf([
      ['Dana Example', 'Experience', 'Operations Coordinator 2019 - 2023', LONG],
      ['Skills', 'Excel, SQL, project management', LONG],
    ]);
    const text = await extractPdfText(pdf.buffer as ArrayBuffer, await realPdfjs());
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toContain('Experience');
    expect(lines).toContain('Operations Coordinator 2019 - 2023');
    expect(lines).toContain('Excel, SQL, project management');
    expect(lines.length).toBe(7);
  });

  it('says "scanned" for a PDF without a text layer', async () => {
    const pdf = buildPdf([['x']]);
    await expect(
      extractPdfText(pdf.buffer as ArrayBuffer, await realPdfjs()),
    ).rejects.toMatchObject(new CvReadError('scanned'));
  });

  it('refuses a PDF with more than 10 pages', async () => {
    const pdf = buildPdf(Array.from({ length: 11 }, () => [LONG, LONG]));
    await expect(
      extractPdfText(pdf.buffer as ArrayBuffer, await realPdfjs()),
    ).rejects.toMatchObject({
      code: 'too_many_pages',
    });
  });

  it('says "unreadable" for a file that is not a PDF', async () => {
    const junk = new TextEncoder().encode('this is not a pdf at all');
    await expect(
      extractPdfText(junk.buffer as ArrayBuffer, await realPdfjs()),
    ).rejects.toMatchObject({
      code: 'unreadable',
    });
  });
});
