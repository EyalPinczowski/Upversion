import { PlanGate } from '../../plan/PlanGate';
import { JobDescriptionField } from '../practice/JobDescriptionField';

/** Practice: the job description every practice prompt of the active plan can use. */
export function PracticeSettings() {
  return (
    <section
      aria-labelledby="practice-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id="practice-heading">Practice</h3>
      <PlanGate
        empty={<p className="text-muted">Import a plan from Today to add a job description.</p>}
      >
        {(plan) => <JobDescriptionField key={plan.id} planId={plan.id} />}
      </PlanGate>
    </section>
  );
}
