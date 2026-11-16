import { extractProfileFromText, type CvExtraction, type ProfileImport } from '@upversion/shared';
import { useState } from 'react';
import { useImportProfile } from '../../api/profile-hooks';
import { Button } from '../../components/ui';
import { CvReviewStep } from '../setup/CvReviewStep';
import { CvStep } from '../setup/CvStep';

type Mode = 'closed' | 'pick' | 'review' | 'saved';

/**
 * "Pre-fill from my CV" on screen 2: the setup's in-browser CV import (ADR 015), unchanged. The
 * file is read on this device, the text is matched here and dropped, and only the items the person
 * confirms are saved (an allowlist payload). Nothing of the CV is kept in storage.
 */
export function CvPrefill() {
  const [mode, setMode] = useState<Mode>('closed');
  const [extraction, setExtraction] = useState<CvExtraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importProfile = useImportProfile();

  function close(next: Mode = 'closed') {
    setExtraction(null);
    setError(null);
    setMode(next);
  }

  async function save(payload: ProfileImport) {
    setError(null);
    try {
      await importProfile.mutateAsync(payload);
    } catch {
      setError('We couldn’t save that. Check your connection and try again.');
      return;
    }
    close('saved');
  }

  if (mode === 'pick') {
    return (
      <div className="space-y-3 rounded-md border border-border p-4">
        <CvStep
          skipLabel="Cancel"
          onSkip={() => close()}
          onText={(text) => {
            // Matched here, on the device. The text itself is not kept.
            setExtraction(extractProfileFromText(text));
            setMode('review');
          }}
        />
      </div>
    );
  }
  if (mode === 'review' && extraction) {
    return (
      <div className="space-y-3 rounded-md border border-border p-4">
        <CvReviewStep
          extraction={extraction}
          busy={importProfile.isPending}
          error={error}
          onSave={(payload) => void save(payload)}
          onDiscard={() => close()}
        />
        <Button disabled={importProfile.isPending} onClick={() => close('pick')}>
          Back
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Button onClick={() => setMode('pick')}>Pre-fill from my CV</Button>
      <div role="status" aria-live="polite">
        {mode === 'saved' ? (
          <p className="font-bold text-ok">
            Your levels below now include what you confirmed from your CV. Check them and change any
            that are out of date.
          </p>
        ) : null}
      </div>
    </div>
  );
}
