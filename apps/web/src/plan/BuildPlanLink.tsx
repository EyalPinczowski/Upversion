import { useNavigate } from 'react-router';
import { usePlanBuilderEnabled } from '../api/plan-builder-hooks';
import { Button, type ButtonVariant } from '../components/ui';

/** The entry to the plan builder. Not rendered at all while the server has the builder off. */
export function BuildPlanLink({
  children = 'Build a new plan',
  variant = 'secondary',
}: {
  children?: string;
  variant?: ButtonVariant;
}) {
  const enabled = usePlanBuilderEnabled();
  const navigate = useNavigate();
  if (!enabled) return null;
  return (
    <Button variant={variant} onClick={() => void navigate('/plan/new')}>
      {children}
    </Button>
  );
}
