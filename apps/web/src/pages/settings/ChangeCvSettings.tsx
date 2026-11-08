import { useNavigate } from 'react-router';
import { useProfile } from '../../api/profile-hooks';
import { Button } from '../../components/ui';

const TITLE_ID = 'change-cv-entry-heading';

/**
 * Settings > App, next to "Profile setup": the entry to "Change my CV". Hidden unless the profile
 * API answered (404 means the feature is off) and the person has done or dismissed the setup or
 * already has something saved on their profile.
 */
export function ChangeCvSettings() {
  const profile = useProfile();
  const navigate = useNavigate();
  const p = profile.data;
  if (!p) return null;
  const hasProfile =
    p.setupStatus === 'completed' ||
    p.setupStatus === 'dismissed' ||
    p.skills.length > 0 ||
    p.rolesHeld.length > 0 ||
    p.cvImportedAt !== null;
  if (!hasProfile) return null;
  return (
    <section
      aria-labelledby={TITLE_ID}
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id={TITLE_ID}>Your CV</h3>
      <p>
        Read a new CV on this device to replace the skills, roles and years of experience that came
        from the old one. Skills you added yourself stay.
      </p>
      <Button onClick={() => void navigate('/settings/cv')}>Change my CV</Button>
    </section>
  );
}
