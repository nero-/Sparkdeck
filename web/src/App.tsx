/* ============================================================================
   App shell — rail + top bar + routed content (see src/router.tsx for routes).
   ========================================================================= */

import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Toaster } from './ds/Toast';
import { Rail } from './shell/Rail';
import { TopBar } from './shell/TopBar';
import { useNavHotkeys } from './shell/hotkeys';
import { useUi } from './stores/ui';
import { useLive } from './stores/live';

export default function App() {
  const theme = useUi((s) => s.theme);
  const density = useUi((s) => s.density);

  // open the live socket for the app lifetime
  useEffect(() => {
    useLive.getState().connect();
    return () => useLive.getState().disconnect();
  }, []);

  // theme + density ride document attributes (token swap, no re-render needed
  // beyond this state change driving the attr)
  useEffect(() => {
    const root = document.documentElement;
    const resolvedTheme =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    root.dataset.theme = resolvedTheme;
    root.dataset.density = density;
  }, [theme, density]);

  useNavHotkeys();

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg0 text-hi">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main
          id="main-scroll"
          className="sd-page-pad min-h-0 w-full flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex min-h-full w-full max-w-[1700px] flex-col">
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
