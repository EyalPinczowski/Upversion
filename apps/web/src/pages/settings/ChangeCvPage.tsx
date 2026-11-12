import { extractProfileFromText, type CvExtraction, type ProfileImport } from '@upversion/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import type { ProfileView } from '../../api/client';
import { useCvTailorEnabled } from '../../api/ai-hooks';
import { useImportProfile, useProfile } from '../../api/profile-hooks';
import { cvTextSession } from '../../cv/cv-text-session';
import { Loading, ServerProblem } from '../../components/status';
import { Button, linkClass } from '../../components/ui';
import { CvReviewStep, type ReplaceInfo } from '../setup/CvReviewStep';
import { CvStep } from '../setup/CvStep';

type Step = 'pick' | 'review' | 'saved';

const SAVE_ERROR =
  'We couldn’t save that. Nothing was changed. Check your connection and try again.';

function replaceInfo(profile: ProfileView): ReplaceInfo {
  return {
    cvSkillIds: profile.skills.filter((s) => s.source === 'cv').map((s) => s.skillId),
    ownSkillIds: profile.skills.filter((s) => s.source !== 'cv').map((s) => s.skillId),
    roleCount: profile.rolesHeld.length,
    yearsExperience: profile.yearsExperience,
  };
}

function Changer({ profile }: { profile: ProfileView }) {
  const navigate = useNavigate();
  const importProfile = useImportProfile();
  const tailorOn = useCvTailorEnabled();
  const [step, setStep] = useState<Step>('pick');
  const [extraction, setExtraction] = useState<CvExtraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Default off. It starts ticked only when this tab already holds text the person chose to keep.
  const [keep, setKeep] = useState(() => cvTextSession.has());
  const keepRef = useRef(keep);
  useEffect(() => {
    keepRef.current = keep;
  }, [keep]);
  const [kept, setKept] = useState(false);
  const [removed, setRemoved] = useState(false);
  const keepId = useId();
  // The "before" picture is taken once: after saving, the profile query holds the new data.
  const [replace] = useState(() => replaceInfo(profile));

  // Leaving the page with the box unticked leaves nothing behind.
  useEffect(
    () => () => {
      if (!keepRef.current) cvTextSession.clear();
    },
    [],
  );

  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  function readText(text: string) {
    // The matcher runs on this device. The text is kept only if the box is ticked, and then only
    // in the in-memory holder; this component never holds it.
    const result = extractProfileFromText(text);
    if (keep) {
      cvTextSession.set(text);
    } else cvTextSession.clear();
    setKept(cvTextSession.has());
    setExtraction(result);
    setError(null);
    setStep('review');
  }

  async function save(payload: ProfileImport) {
    setError(null);
    try {
      await importProfile.mutateAsync(payload);
    } catch {
      setError(SAVE_ERROR);
      return;
    }
    setExtraction(null);
    setStep('saved');
  }

  function forget() {
    cvTextSession.clear();
    setKept(false);
    setKeep(false);
    setRemoved(true);
    // The button that was pressed is gone; the heading is the next sensible place.
    headingRef.current?.focus();
  }

  const keptNotice = (
    <div className="space-y-2">
      {kept ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted">Your CV text is still kept in this tab’s memory.</p>
          <Button onClick={forget}>Forget it now</Button>
        </div>
      ) : null}
      {removed ? <p role="status">CV text removed from this tab</p> : null}
    </div>
  );

  const cancel = () => void navigate('/settings');
  const heading =
    step === 'pick'
      ? 'Choose your new CV'
      : step === 'review'
        ? 'Review what we found'
        : 'CV saved';

  const tailorLink = tailorOn ? (
    <section
      aria-labelledby="change-cv-tailor-heading"
      className="space-y-2 border-t border-border pt-5"
    >
      <h3 id="change-cv-tailor-heading">Applying for a job?</h3>
      <p>See which keywords of a job post your CV shows, then get a prompt to tailor it.</p>
      <p>
        <Link to="/settings/tailor-cv" className={linkClass}>
          Tailor my CV to a job
        </Link>
      </p>
    </section>
  ) : null;

  return (
    <div className="space-y-6">
      <h1>Change my CV</h1>
      <section aria-labelledby="change-cv-heading" className="space-y-5">
        <h2 id="change-cv-heading" ref={headingRef} tabIndex={-1}>
          {heading}
        </h2>

        {step === 'pick' ? (
          <>
            <p>
              This replaces the skills, roles and years of experience that came from your earlier
              CV. Skills you added yourself or chose in setup stay. Only the items you confirm on
              the next screen are saved.
            </p>
            <div className="space-y-1">
              <label htmlFor={keepId} className="flex min-h-11 items-center gap-3 font-bold">
                <input
                  id={keepId}
                  type="checkbox"
                  className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                  checked={keep}
                  aria-describedby={`${keepId}-hint`}
                  onChange={(e) => {
                    setKeep(e.target.checked);
                    if (!e.target.checked) {
                      cvTextSession.clear();
                      setKept(false);
                    }
                  }}
                />
                Keep my CV text in this tab so I can tailor it to a job
              </label>
              <p id={`${keepId}-hint`} className="pl-8 text-muted">
                Off by default. If you tick it, the text stays only in this tab’s memory so you can
                tailor it to a job later. It is never written to this device’s storage or sent to
                our server. Unticking the box, signing out, reloading or closing the tab removes it.
              </p>
            </div>
            <CvStep
              onText={readText}
              onSkip={cancel}
              skipLabel="Cancel"
              intro="The file is read on this device only and is never uploaded. Its text is not saved anywhere, unless you tick the box above, and then only in this tab’s memory until you close the tab or sign out. You confirm every item before anything is saved. Your name and contact details are never used."
            />
            {tailorLink}
          </>
        ) : null}

        {step === 'review' && extraction ? (
          <>
            {keptNotice}
            <CvReviewStep
              extraction={extraction}
              busy={importProfile.isPending}
              error={error}
              replace={replace}
              onSave={(payload) => void save(payload)}
              onDiscard={cancel}
            />
            <Button
              disabled={importProfile.isPending}
              onClick={() => {
                setExtraction(null);
                setError(null);
                setStep('pick');
              }}
            >
              Back
            </Button>
          </>
        ) : null}

        {step === 'saved' ? (
          <div className="space-y-4">
            <p role="status">
              Your profile now matches your new CV. Skills you added yourself were not changed.
            </p>
            {keptNotice}
            {tailorLink}
            <Link to="/settings" className={linkClass}>
              Back to Settings
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Settings > Change my CV (ADR 016 WP-G1): the CV step and review of the setup, reused, with a
 * "This will be replaced" list. When the profile API is off (404) the page does not exist.
 */
export function ChangeCvPage() {
  const profile = useProfile();
  if (profile.data === null) return <Navigate to="/settings" replace />;
  if (profile.data) return <Changer profile={profile.data} />;
  if (profile.isError)
    return <ServerProblem error={profile.error} onRetry={() => void profile.refetch()} />;
  return <Loading label="Loading your profile…" />;
}
