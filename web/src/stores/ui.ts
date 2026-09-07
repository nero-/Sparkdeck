/* ============================================================================
   stores/ui — UI state: active cluster (persisted), theme, density, rail.
   ========================================================================= */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';

export interface UiState {
  theme: ThemeChoice;
  density: Density;
  /** last cluster the user interacted with — persisted */
  activeClusterId: string | null;
  /** icon rail expanded (default collapsed per DESIGN) */
  railExpanded: boolean;
  /** remember a chosen rail width across reloads */
  setTheme: (theme: ThemeChoice) => void;
  setDensity: (density: Density) => void;
  setActiveClusterId: (id: string | null) => void;
  setRailExpanded: (expanded: boolean) => void;
  toggleRail: () => void;
}

const RAIL_COLLAPSED_W = 72;
const RAIL_EXPANDED_W = 200;

export const RAIL_WIDTH = {
  collapsed: RAIL_COLLAPSED_W,
  expanded: RAIL_EXPANDED_W,
} as const;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      density: 'comfortable',
      activeClusterId: null,
      railExpanded: false,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setActiveClusterId: (activeClusterId) => set({ activeClusterId }),
      setRailExpanded: (railExpanded) => set({ railExpanded }),
      toggleRail: () => set((s) => ({ railExpanded: !s.railExpanded })),
    }),
    {
      name: 'sparkdeck.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        theme: s.theme,
        density: s.density,
        activeClusterId: s.activeClusterId,
        railExpanded: s.railExpanded,
      }),
    },
  ),
);
