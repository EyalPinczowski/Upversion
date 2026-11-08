import { unzipSync } from 'fflate';

/**
 * Reads a CV file into plain text, in the browser only (ADR 015 section 3). Nothing here uploads,
 * stores or caches the file or its text: the result is returned to the caller's memory and that is
 * all. Line breaks are kept (one "\n" per text line or paragraph) because the matcher reads the
 * text line by line.
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
/** Zip-bomb guard: the unpacked document.xml of a DOCX may not be larger than this. */
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;
/** Fewer characters per page than this means a scanned PDF (no text layer). */
export const MIN_CHARS_PER_PAGE = 100;

export type CvErrorCode =
  | 'too_large'
  | 'unsupported'
  | 'legacy_doc'
  | 'encrypted'
  | 'too_many_pages'
  | 'scanned'
  | 'unreadable';

export const CV_ERROR_TEXT: Record<CvErrorCode, string> = {
  too_large: 'This file is larger than 5 MB. Paste the text instead.',
  unsupported:
    'Only PDF and DOCX files can be read. Choose one of those, or paste the text instead.',
  legacy_doc:
    'Old .doc files can’t be read. Save the file as PDF or DOCX, or paste the text instead.',
  encrypted: 'This PDF is password protected. Paste the text instead.',
  too_many_pages: 'This PDF has more than 10 pages. Paste the text instead.',
  scanned: 'This looks like a scanned PDF, so there is no text to read. Paste the text instead.',
  unreadable: 'We couldn’t read this file. Paste the text instead.',
};

export class CvReadError extends Error {
  constructor(public readonly code: CvErrorCode) {
    super(CV_ERROR_TEXT[code]);
    this.name = 'CvReadError';
  }
}

/** The small part of pdf.js this file uses, so a test can pass a stand-in. */
export interface PdfjsLike {
  getDocument(source: {
    data: Uint8Array;
    isEvalSupported: false;
    disableFontFace: true;
    verbosity?: number;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{
          items: ReadonlyArray<{ str?: string; hasEOL?: boolean; transform?: number[] }>;
        }>;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}

/** Text items to lines: an item ends a line when pdf.js says so or when the baseline moves. */
export function itemsToText(
  items: ReadonlyArray<{ str?: string; hasEOL?: boolean; transform?: number[] }>,
): string {
  let out = '';
  let lastY: number | null = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform?.[5] ?? null;
    if (
      lastY !== null &&
      y !== null &&
      Math.abs(y - lastY) > 2 &&
      out !== '' &&
      !out.endsWith('\n')
    ) {
      out += '\n';
    }
    out += item.str;
    if (y !== null) lastY = y;
    if (item.hasEOL) {
      out += '\n';
    }
  }
  return out;
}

const nonSpace = (text: string) => text.replace(/\s/g, '').length;

/** The person pressed Cancel while a file was being read. Not an error to show. */
export class CvCancelled extends Error {
  constructor() {
    super('Reading was cancelled.');
    this.name = 'CvCancelled';
  }
}

export const PDF_TIMEOUT_MS = 20_000;

export interface PdfOptions {
  /** Gives up (as "unreadable") after this long. Default 20 seconds. */
  timeoutMs?: number;
  /** Aborting stops reading and throws `CvCancelled`. */
  signal?: AbortSignal;
}

export async function extractPdfText(
  data: ArrayBuffer,
  pdfjs: PdfjsLike,
  { timeoutMs = PDF_TIMEOUT_MS, signal }: PdfOptions = {},
): Promise<string> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    // CVE-2024-4367: never let a font run code. Nothing is rendered, only text is read.
    isEvalSupported: false,
    disableFontFace: true,
    // Only errors: a missing standard-font file is irrelevant when nothing is rendered.
    verbosity: 0,
  });

  async function read(): Promise<string> {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await task.promise;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new CvReadError(name === 'PasswordException' ? 'encrypted' : 'unreadable');
    }
    try {
      if (doc.numPages > MAX_PDF_PAGES) throw new CvReadError('too_many_pages');
      const pages: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
      }
      const text = pages.join('\n');
      if (nonSpace(text) < MIN_CHARS_PER_PAGE * Math.max(1, doc.numPages)) {
        throw new CvReadError('scanned');
      }
      return text;
    } catch (error) {
      if (error instanceof CvReadError) throw error;
      throw new CvReadError('unreadable');
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CvReadError('unreadable')), timeoutMs);
    if (signal?.aborted) reject(new CvCancelled());
    onAbort = () => reject(new CvCancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    // Always, also when the file was refused (password): frees the pdf.js worker for a retry.
    void task.destroy().catch(() => undefined);
    // The losing branch must not become an unhandled rejection.
    stopped.catch(() => undefined);
  }
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Paragraph by paragraph: `w:t` text, `w:tab` as a tab, `w:br` as a line break. */
function paragraphText(node: Node): string {
  let out = '';
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.namespaceURI === W_NS && el.localName === 't') out += el.textContent ?? '';
    else if (el.namespaceURI === W_NS && el.localName === 'tab') out += '\t';
    else if (el.namespaceURI === W_NS && (el.localName === 'br' || el.localName === 'cr')) {
      out += '\n';
    } else out += paragraphText(el);
  }
  return out;
}

export function extractDocxText(data: ArrayBuffer): string {
  let oversize = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), {
      filter: (file) => {
        if (file.name !== 'word/document.xml') return false;
        if (file.originalSize > MAX_DOCX_XML_BYTES) {
          oversize = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new CvReadError('unreadable');
  }
  if (oversize) throw new CvReadError('too_large');
  const xml = files['word/document.xml'];
  if (!xml) throw new CvReadError('unreadable');
  // The header size can lie: check what really came out too.
  if (xml.length > MAX_DOCX_XML_BYTES) throw new CvReadError('too_large');
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new CvReadError('unreadable');
  const lines: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W_NS, 'p'))) {
    // A paragraph inside another one (text box) is read with its parent, not twice.
    let nested = false;
    for (let a = p.parentNode; a; a = a.parentNode) {
      if ((a as Element).localName === 'p' && (a as Element).namespaceURI === W_NS) nested = true;
    }
    if (!nested) lines.push(paragraphText(p));
  }
  return lines.join('\n');
}

/** Loads pdf.js and its worker on first use only: this is the one place the heavy chunk is requested. */
async function loadPdfjs(): Promise<PdfjsLike> {
  const [lib, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib as unknown as PdfjsLike;
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

export interface ExtractOptions extends PdfOptions {
  /** Replaceable for tests. */
  loadPdfjs?: () => Promise<PdfjsLike>;
}

/** Reads a picked or dropped file. Throws `CvReadError` with a message safe to show. */
export async function extractCvText(file: File, options: ExtractOptions = {}): Promise<string> {
  const ext = extensionOf(file.name);
  if (ext === 'doc') throw new CvReadError('legacy_doc');
  if (ext !== 'pdf' && ext !== 'docx') throw new CvReadError('unsupported');
  if (file.size > MAX_FILE_BYTES) throw new CvReadError('too_large');
  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch {
    throw new CvReadError('unreadable');
  }
  if (ext === 'docx') {
    const text = extractDocxText(data);
    if (nonSpace(text) === 0) throw new CvReadError('unreadable');
    return text;
  }
  let pdfjs: PdfjsLike;
  try {
    pdfjs = await (options.loadPdfjs ?? loadPdfjs)();
  } catch {
    // The library could not load (very old browser): the paste-text path still works.
    throw new CvReadError('unreadable');
  }
  if (options.signal?.aborted) throw new CvCancelled();
  return extractPdfText(data, pdfjs, options);
}
