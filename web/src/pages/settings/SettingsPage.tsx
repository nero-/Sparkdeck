import { Settings as SettingsIcon } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      context="clusters & nodes, profiles, alerts, appearance, security, bench defaults"
      icon={<SettingsIcon />}
    />
  );
}
