import { FlaskConical } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function BenchPage() {
  return (
    <PagePlaceholder
      title="Bench"
      context="jobs, concurrency × context sweep, reports, history"
      icon={<FlaskConical />}
    />
  );
}
