/* ============================================================================
   smoke entry (dev-only) — mounts ONLY the charts/monitoring wave pages with
   a minimal chrome stand-in, so they can be browser-verified headlessly while
   sibling agents' in-flight waves (settings/ control) are still being written
   elsewhere in the repo. Not part of the production bundle: the built app
   uses index.html → main.tsx → router.tsx. Run:
     node_modules/.bin/vite --config vite.config.smoke.ts   (then /smoke.html)
   ========================================================================= */

import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import '../index.css';
import { Toaster } from '../ds/Toast';
import { useLive } from '../stores/live';
import OverviewPage from '../pages/overview/OverviewPage';
import NodesPage from '../pages/nodes/NodesPage';
import NodeDetailPage from '../pages/nodes/NodeDetailPage';
import InferencePage from '../pages/inference/InferencePage';

function SmokeRoot(): ReactNode {
  /* open the live socket + set the theme attrs the ds tokens expect */
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.density = 'comfortable';
    useLive.getState().connect();
    return () => useLive.getState().disconnect();
  }, []);

  return (
    <div className="flex min-h-dvh w-full flex-col bg-bg0 text-hi">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1700px] flex-col gap-4 p-6">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/nodes/:nodeId" element={<NodeDetailPage />} />
          <Route path="/inference" element={<InferencePage />} />
        </Routes>
      </div>
      <Toaster />
    </div>
  );
}

const el = document.getElementById('root');
if (el === null) throw new Error('#root missing');

createRoot(el).render(
  <StrictMode>
    <HashRouter>
      <SmokeRoot />
    </HashRouter>
  </StrictMode>,
);
