import { useNavigate } from 'react-router';
import { useCvTailorEnabled } from '../../api/ai-hooks';
import { Button } from '../../components/ui';

const TITLE_ID = 'tailor-cv-entry-heading';

/** Settings entry to "Tailor my CV to a job". Hidden unless the server flag is on. */
export function TailorCvSettings() {
  const enabled = useCvTailorEnabled();
  const navigate = useNavigate();
  if (!enabled) return null;
  return (
    <section
      aria-labelledby={TITLE_ID}
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id={TITLE_ID}>Tailor my CV to a job</h3>
      <p>
        Paste a job post and see which of its keywords your CV shows. You can then copy a prompt for
        your own assistant, or, after a preview of the exact text, send it to a free AI model.
      </p>
      <Button onClick={() => void navigate('/settings/tailor-cv')}>Tailor my CV</Button>
    </section>
  );
}
