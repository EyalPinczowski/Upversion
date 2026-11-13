import type { PlanSummary } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorText } from '../../components/ui';

/**
 * Shown before "Start this plan" when other plans are active: names every plan that will be
 * archived. The ids sent as `replacesPlanIds` are exactly these plans'.
 */
export function ArchiveDialog({
  plans,
  notice,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The active plans, from the latest plan list. */
  plans: PlanSummary[];
  /** Why the dialog is open again (the list changed under it), or an error of the last try. */
  notice: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const many = plans.length > 1;
  return (
    <ConfirmDialog
      title={many ? 'Archive your current plans?' : 'Archive your current plan?'}
      confirmLabel={busy ? 'Starting…' : 'Archive and start'}
      cancelLabel="Cancel"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {notice ? <ErrorText>{notice}</ErrorText> : null}
      <p>
        Your current {many ? 'plans' : 'plan'}{' '}
        {plans.map((p, i) => (
          <span key={p.id}>
            {i > 0 ? (i === plans.length - 1 ? ' and ' : ', ') : ''}
            <strong>{p.name}</strong>
          </span>
        ))}{' '}
        will be archived. You can still open {many ? 'them' : 'it'} read-only, and restore{' '}
        {many ? 'one' : 'it'} later from the plan list.
      </p>
    </ConfirmDialog>
  );
}
