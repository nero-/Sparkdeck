import { Bell } from 'lucide-react';
import { PagePlaceholder } from '../../shell/PageShell';

export default function EventsPage() {
  return (
    <PagePlaceholder
      title="Events"
      context="level/kind filters, ack, ringed feed (max 500) from the live socket"
      icon={<Bell />}
    />
  );
}
