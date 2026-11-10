import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Button, ErrorText, TextAreaField } from '../../components/ui';
import { CV_ERROR_TEXT, CvCancelled, CvReadError, extractCvText } from './cv-extract';

/**
 * The optional CV step. The file is read on this device and never sent anywhere; only its text
 * (kept in memory, handed to `onText`) is used, and nothing is written to web storage. A
 * picked file's name is not shown or kept.
 */
export function CvStep({
  onText,
  onSkip,
  skipLabel = 'Skip this step',
  intro,
  pasteHint = 'Keep the line breaks. Nothing you paste is saved or sent.',
}: {
  /** Receives the extracted or pasted text. The caller matches it and lets go of it. */
  onText: (text: string) => void;
  onSkip: () => void;
  /** The wizard skips the step; "Change my CV" calls the same button Cancel. */
  skipLabel?: string;
  /** Replaces the privacy paragraph (the wizard keeps its own text). */
  intro?: string;
  /** Replaces the hint under the paste field (tailoring sends text later, after a preview). */
  pasteHint?: string;
}) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Leaving the step (Back, Skip, skip setup) stops a read still in flight, so it cannot finish
  // later and pull the person to the review screen.
  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
    },
    [],
  );

  async function read(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      onText(await extractCvText(file, { signal: controller.signal }));
    } catch (e) {
      if (e instanceof CvCancelled) return;
      setError(e instanceof CvReadError ? e.message : CV_ERROR_TEXT.unreadable);
      setPasting(true);
    } finally {
      // Only the newest read may touch the busy flag (Cancel, then pick another file).
      if (abort.current === controller) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void read(event.dataTransfer.files[0]);
  }

  function usePasted() {
    if (pasted.trim().length < 20) {
      setError('Paste some of your CV text first.');
      return;
    }
    setError(null);
    try {
      onText(pasted);
    } catch {
      setError(CV_ERROR_TEXT.unreadable);
      return;
    }
    setPasted('');
  }

  return (
    <div className="space-y-4">
      {intro ? (
        <p>{intro}</p>
      ) : (
        <p>
          Add your CV and we suggest skills, roles and tools to save to your profile. The file is
          read on this device only. It is never uploaded or stored, and you confirm every item
          before anything is saved. Your name and contact details are never used.
        </p>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-md border-2 border-dashed p-4 ${dragging ? 'border-accent bg-accent-soft' : 'border-border'}`}
      >
        <label htmlFor={`${ids}-file`} className="block font-bold">
          Choose a PDF or DOCX file, or drop it here
        </label>
        <p id={`${ids}-file-hint`} className="mb-2 text-muted">
          Up to 5 MB. PDFs up to 10 pages.
        </p>
        <input
          id={`${ids}-file`}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          aria-describedby={`${ids}-file-hint`}
          disabled={busy}
          onChange={(e) => {
            void read(e.target.files?.[0]);
            // Forget the pick so the same file can be chosen again after an error.
            e.target.value = '';
          }}
          className="block min-h-11 w-full text-text"
        />
      </div>

      {busy ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-muted">
            Reading your CV on this device…
          </p>
          <Button
            onClick={() => {
              abort.current?.abort();
              abort.current = null;
              setBusy(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {pasting ? (
        <div className="space-y-3">
          <TextAreaField
            label="Paste the text of your CV"
            hint={pasteHint}
            rows={8}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button onClick={usePasted} disabled={busy}>
            Read this text
          </Button>
        </div>
      ) : (
        <Button onClick={() => setPasting(true)}>Paste text instead</Button>
      )}

      <div>
        <Button variant="secondary" onClick={onSkip}>
          {skipLabel}
        </Button>
      </div>
    </div>
  );
}
