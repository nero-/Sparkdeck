import { useParams } from 'react-router-dom';
import { Cpu } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function NodeDetailPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  return (
    <PagePlaceholder
      title={`Node ${nodeId ?? '—'}`}
      context="detail: live conn state, last sample, address failover, actions"
      icon={<Cpu />}
    />
  );
}
