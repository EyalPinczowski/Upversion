import { useAiUsage } from '../../api/ai-hooks';
import { meterModel } from './meter-model';

function resetTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Today's AI use, shown in Settings only from 80% of the daily allowance. It lets a person see why
 * the chat stopped and when it comes back; practice itself never depends on it.
 */
export function AiUsageMeter() {
  const usage = useAiUsage();
  const model = usage.data ? meterModel(usage.data) : null;
  if (!usage.data || !model) return null;
  const reset = resetTime(usage.data.resetsAt);
  return (
    <section
      aria-labelledby="ai-usage-heading"
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id="ai-usage-heading">AI use today</h3>
      <p className="font-bold tabular-nums">
        {model.used} of {model.cap} AI calls today
      </p>
      <progress
        max={model.cap}
        value={Math.min(model.used, model.cap)}
        aria-label="AI calls used today"
        className="block h-3 w-full"
      />
      <ul className="space-y-1 text-muted">
        {model.rows.map((row) => (
          <li key={row.label} className="tabular-nums">
            {row.label}: {row.used} of {row.cap}
          </li>
        ))}
      </ul>
      {model.providers.length > 0 ? (
        <ul aria-label="Provider requests today" className="space-y-1 text-muted">
          {model.providers.map((p) => (
            <li key={p.label} className="tabular-nums">
              {p.label}: {p.used} of {p.cap} requests
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        {model.provider
          ? `Active provider: ${model.provider}.`
          : 'No AI provider can answer right now.'}
      </p>
      {reset ? <p className="text-muted">The count resets at {reset}.</p> : null}
      <p className="text-muted">
        When the allowance is used up, practice still works with the copy-prompt flow and the
        self-check.
      </p>
    </section>
  );
}
