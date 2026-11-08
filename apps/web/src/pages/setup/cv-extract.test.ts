import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { buildDocx } from '../../test/docx-fixture';
import {
  CvCancelled,
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

/** Sets the "uncompressed size" in the local and central headers of a one-file zip. */
function lieAboutSize(zip: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(zip.length);
  out.set(zip);
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 < out.length; i++) {
    if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, size, true);
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}

describe('a DOCX whose zip header lies about its size', () => {
  const real = strToU8(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Excel</w:t></w:r></w:p></w:body></w:document>',
  );
  const zip = () => zipSync({ 'word/document.xml': real });

  it('is refused when the header claims more than 20 MB', async () => {
    const f = new File([lieAboutSize(zip(), 30 * 1024 * 1024)], 'a.docx');
    await expect(extractCvText(f)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('never throws anything but a CvReadError when the header claims less than the real size', async () => {
    const f = new File([lieAboutSize(zip(), 10)], 'a.docx');
    const result = await extractCvText(f).catch((e: unknown) => e);
    // Either the text is read in full or it is refused; no crash, no oversized output.
    if (typeof result === 'string') expect(result.length).toBeLessThan(1000);
    else expect(result).toBeInstanceOf(CvReadError);
  });

  it('refuses output that is really larger than 20 MB even if the header claims little', async () => {
    const big = zipSync({
      'word/document.xml': strToU8('<w:document>' + ' '.repeat(21 * 1024 * 1024)),
    });
    const f = new File([lieAboutSize(big, 100)], 'a.docx');
    const result = await extractCvText(f).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(CvReadError);
  });
});

describe('PDF reading: timeout, cancel and cleanup', () => {
  const never = (
    destroy = vi.fn(async () => {}),
  ): { pdfjs: PdfjsLike; destroy: typeof destroy } => ({
    destroy,
    pdfjs: { getDocument: () => ({ promise: new Promise(() => {}), destroy }) },
  });

  it('gives up after the timeout with the "unreadable" message and frees the worker', async () => {
    const { pdfjs, destroy } = never();
    await expect(
      extractPdfText(new ArrayBuffer(8), pdfjs, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('stops on abort with CvCancelled and frees the worker', async () => {
    const { pdfjs, destroy } = never();
    const controller = new AbortController();
    const pending = extractPdfText(new ArrayBuffer(8), pdfjs, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CvCancelled);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('frees the worker also when the PDF is refused (password), so retries do not leak', async () => {
    const destroy = vi.fn(async () => {});
    const locked = Object.assign(new Error('locked'), { name: 'PasswordException' });
    const pdfjs: PdfjsLike = {
      getDocument: () => ({ promise: Promise.reject(locked), destroy }),
    };
    await expect(extractPdfText(new ArrayBuffer(8), pdfjs)).rejects.toMatchObject({
      code: 'encrypted',
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('DOCX reading honours the abort signal', () => {
  it('throws CvCancelled when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractCvText(buildDocx(['Excel and SQL for weekly reports']), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CvCancelled);
  });

  it('drops the text when cancelled while the file is being read', async () => {
    const controller = new AbortController();
    const file = buildDocx(['Excel and SQL for weekly reports']);
    const real = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      const data = await real();
      controller.abort();
      return data;
    };
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      await expect(extractCvText(file, { signal: controller.signal })).rejects.toBeInstanceOf(
        CvCancelled,
      );
      // Stopped before any unpacking work.
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('drops the text when cancelled while it is being unpacked', async () => {
    const controller = new AbortController();
    const parse = DOMParser.prototype.parseFromString;
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (
      this: DOMParser,
      ...args: Parameters<typeof parse>
    ) {
      controller.abort();
      return parse.apply(this, args);
    });
    try {
      await expect(
        extractCvText(buildDocx(['Excel and SQL for weekly reports']), {
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(CvCancelled);
    } finally {
      spy.mockRestore();
    }
  });
});
