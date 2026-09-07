import { Cpu } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function NodesPage() {
  return (
    <PagePlaceholder
      title="Nodes"
      context="SSH-reachability, env rank, addresses, collector state"
      icon={<Cpu />}
    />
  );
}
