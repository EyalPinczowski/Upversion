import type { SetupQuestion } from '@upversion/shared';
import { Link } from 'react-router';
import type { ProfileView } from '../../api/client';
import { Button, linkClass } from '../../components/ui';
import { describeAnswer } from './question-model';

/** The last step: a summary of what was saved, each answer editable. */
export function DoneStep({
  questions,
  answers,
  profile,
  onEdit,
}: {
  questions: SetupQuestion[];
  answers: Record<string, unknown>;
  profile: ProfileView;
  onEdit: (questionId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <p>You are all set. Here is what is saved in your profile. You can change any answer.</p>
      <ul className="divide-y divide-border">
        {questions.map((q) => {
          const text = describeAnswer(q, answers[q.id]);
          return (
            <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <div className="min-w-0 grow basis-60">
                <p className="text-muted">{q.text}</p>
                <p className="font-bold">{text ?? 'Not answered'}</p>
              </div>
              <Button onClick={() => onEdit(q.id)} aria-label={`Change: ${q.text}`}>
                Change
              </Button>
            </li>
          );
        })}
      </ul>
      {profile.skills.length > 0 || profile.rolesHeld.length > 0 ? (
        <p>
          From your CV: {profile.skills.length} {profile.skills.length === 1 ? 'skill' : 'skills'}{' '}
          and {profile.rolesHeld.length} {profile.rolesHeld.length === 1 ? 'role' : 'roles'} saved.
        </p>
      ) : null}
      <Link className={linkClass} to="/">
        Go to Today
      </Link>
    </div>
  );
}
