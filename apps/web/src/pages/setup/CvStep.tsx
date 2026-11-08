import { useId, useState, type DragEvent } from 'react';
import { Button, ErrorText, TextAreaField } from '../../components/ui';
import { CvReadError, extractCvText } from './cv-extract';

/**
 * The optional CV step. The file is read on this device and never sent anywhere; only its text
 * (kept in memory, handed to `onText`) is used, and nothing is written to web storage. A
 * picked file's name is not shown or kept.
 */
export function CvStep({
  onText,
  onSkip,
}: {
  /** Receives the extracted or pasted text. The caller matches it and lets go of it. */
  onText: (text: string) => void;
  onSkip: () => void;
}) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);

  async function read(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onText(await extractCvText(file));
    } catch (e) {
      setError(
        e instanceof CvReadError
          ? e.message
          : 'We couldn’t read this file. Paste the text instead.',
      );
      setPasting(true);
    } finally {
      setBusy(false);
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
    onText(pasted);
    setPasted('');
  }

  return (
    <div className="space-y-4">
      <p>
        Add your CV and we suggest skills, roles and tools to save to your profile. The file is read
        on this device only. It is never uploaded or stored, and you confirm every item before
        anything is saved. Your name and contact details are never used.
      </p>

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
        <p role="status" className="text-muted">
          Reading your CV on this device…
        </p>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}

      {pasting ? (
        <div className="space-y-3">
          <TextAreaField
            label="Paste the text of your CV"
            hint="Keep the line breaks. Nothing you paste is saved or sent."
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
          Skip this step
        </Button>
      </div>
    </div>
  );
}
