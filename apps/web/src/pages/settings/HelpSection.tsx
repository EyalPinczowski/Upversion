import { Button } from '../../components/ui';
import { requestWelcome } from '../../lib/welcome';

export function HelpSection() {
  return (
    <section
      aria-labelledby="help-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h2 id="help-heading">Help</h2>
      <p>A short welcome to Today, Week, Plan and Settings, with a guided tour.</p>
      <Button onClick={requestWelcome}>Show the welcome guide again</Button>
    </section>
  );
}
