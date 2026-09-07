import { Boxes } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function ImagesPage() {
  return (
    <PagePlaceholder
      title="Images"
      context="image inventory, env-file rewrites, save|load copies, builders"
      icon={<Boxes />}
    />
  );
}
