import { ToggleLeft } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function ControlPage() {
  return (
    <PagePlaceholder
      title="Control"
      context="cluster start/stop/preflight, op streaming, typed confirmations"
      icon={<ToggleLeft />}
    />
  );
}
