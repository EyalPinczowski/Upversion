import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { buildDocx } from '../../test/docx-fixture';
import {
  CvReadError,
  extractCvText,
  extractPdfText,
  itemsToText,
  MAX_FILE_BYTES,
  type PdfjsLike,
} from './cv-extract';

const file = (name: string, content = 'x') => new File([content], name);

describe('DOCX text extraction', () => {
  it('keeps one line per paragraph, with tabs and breaks', async () => {
    const text = await extractCvText(
      buildDocx(['Experience', 'Operations Coordinator\t2019 - 2023', 'Excel, SQL']),
    );
    expect(text.split('\n')).toEqual([
      'Experience',
      'Operations Coordinator\t2019 - 2023',
      'Excel, SQL',
    ]);
  });

  it('reads a paragraph inside a text box once, with its parent', async () => {
    const nested =
      '<w:p><w:r><w:t>Outer</w:t></w:r><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>';
    const text = await extractCvText(buildDocx(['Top'], nested));
    expect(text.split('\n')).toEqual(['Top', 'OuterInner']);
  });

  it('refuses a document.xml that unpacks to more than 20 MB', async () => {
    const big = new File(
      [zipSync({ 'word/document.xml': strToU8('<w:document>' + ' '.repeat(21 * 1024 * 1024)) })],
      'big.docx',
    );
    await expect(extractCvText(big)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('says unreadable for a zip without document.xml and for non-zip data', async () => {
    const empty = new File([zipSync({ 'other.txt': strToU8('x') })], 'a.docx');
    await expect(extractCvText(empty)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(extractCvText(file('b.docx', 'not a zip'))).rejects.toMatchObject({
      code: 'unreadable',
    });
  });
});

describe('file checks', () => {
  it('names a legacy .doc, an unsupported type and an oversize file', async () => {
    await expect(extractCvText(file('cv.doc'))).rejects.toMatchObject({ code: 'legacy_doc' });
    await expect(extractCvText(file('cv.odt'))).rejects.toMatchObject({ code: 'unsupported' });
    const huge = file('cv.pdf');
    Object.defineProperty(huge, 'size', { value: MAX_FILE_BYTES + 1 });
    await expect(extractCvText(huge)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('falls back to "unreadable" (paste text) when pdf.js cannot load', async () => {
    const error = await extractCvText(file('cv.pdf', '%PDF'), {
      loadPdfjs: () => Promise.reject(new Error('no worker')),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CvReadError);
    expect((error as CvReadError).code).toBe('unreadable');
  });
});

describe('PDF text from pdf.js items', () => {
  it('breaks lines on hasEOL and on a moved baseline', () => {
    expect(
      itemsToText([
        { str: 'Experience', hasEOL: true },
        { str: 'Operations', transform: [1, 0, 0, 1, 0, 700] },
        { str: ' Coordinator', transform: [1, 0, 0, 1, 60, 700] },
        { str: 'Excel', transform: [1, 0, 0, 1, 0, 680] },
      ]),
    ).toBe('Experience\nOperations Coordinator\nExcel');
  });

  const fake = (opts: { numPages?: number; text?: string; error?: Error }): PdfjsLike => ({
    getDocument: () => ({
      promise: opts.error
        ? Promise.reject(opts.error)
        : Promise.resolve({
            numPages: opts.numPages ?? 1,
            getPage: async () => ({
              getTextContent: async () => ({ items: [{ str: opts.text ?? '', hasEOL: true }] }),
            }),
          }),
      destroy: vi.fn(async () => {}),
    }),
  });

  it('maps a password error, a short text layer and too many pages to their messages', async () => {
    const data = new ArrayBuffer(8);
    const password = Object.assign(new Error('locked'), { name: 'PasswordException' });
    await expect(extractPdfText(data, fake({ error: password }))).rejects.toMatchObject({
      code: 'encrypted',
    });
    await expect(extractPdfText(data, fake({ text: 'only a few words' }))).rejects.toMatchObject({
      code: 'scanned',
    });
    await expect(extractPdfText(data, fake({ numPages: 11 }))).rejects.toMatchObject({
      code: 'too_many_pages',
    });
  });

  it('passes the safe pdf.js options', async () => {
    const getDocument = vi.fn(fake({ text: 'word '.repeat(40) }).getDocument);
    await extractPdfText(new ArrayBuffer(8), { getDocument });
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ isEvalSupported: false, disableFontFace: true }),
    );
  });
});
