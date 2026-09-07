import { Terminal as TerminalIcon } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function LogsPage() {
  return (
    <PagePlaceholder
      title="Logs"
      context="docker logs -f with ANSI, filter box, download, autoscroll"
      icon={<TerminalIcon />}
    />
  );
}
