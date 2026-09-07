/* ============================================================================
   App Router — NAV_ITEMS is shared by the rail, the top bar and the g-1..g-9
   chord. Routes per DESIGN.md app frame.
   ========================================================================= */

import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Boxes,
  Cpu,
  FlaskConical,
  Gauge,
  Layers,
  MessagesSquare,
  Settings,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import App from './App';
import OverviewPage from './pages/overview/OverviewPage';
import NodesPage from './pages/nodes/NodesPage';
import NodeDetailPage from './pages/nodes/NodeDetailPage';
import ControlPage from './pages/control/ControlPage';
import InferencePage from './pages/inference/InferencePage';
import LogsPage from './pages/logs/LogsPage';
import ImagesPage from './pages/images/ImagesPage';
import BenchPage from './pages/bench/BenchPage';
import EventsPage from './pages/events/EventsPage';
import SettingsPage from './pages/settings/SettingsPage';

export interface NavItem {
  /** 1–9: the g-chord hotkey digit */
  digit: number;
  path: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { digit: 1, path: '/', label: 'Overview', icon: Gauge },
  { digit: 2, path: '/nodes', label: 'Nodes', icon: Cpu },
  { digit: 3, path: '/control', label: 'Control', icon: Layers },
  { digit: 4, path: '/inference', label: 'Inference', icon: MessagesSquare },
  { digit: 5, path: '/logs', label: 'Logs', icon: TerminalIcon },
  { digit: 6, path: '/images', label: 'Images', icon: Boxes },
  { digit: 7, path: '/bench', label: 'Bench', icon: FlaskConical },
  { digit: 8, path: '/events', label: 'Events', icon: Bell },
  { digit: 9, path: '/settings', label: 'Settings', icon: Settings },
];

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'nodes', element: <NodesPage /> },
      { path: 'nodes/:nodeId', element: <NodeDetailPage /> },
      { path: 'control', element: <ControlPage /> },
      { path: 'inference', element: <InferencePage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'images', element: <ImagesPage /> },
      { path: 'bench', element: <BenchPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
