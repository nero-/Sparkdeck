import { MessagesSquare } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function InferencePage() {
  return (
    <PagePlaceholder
      title="Inference"
      context="service health, KV usage, chat console with TTFT/TPS stats"
      icon={<MessagesSquare />}
    />
  );
}
