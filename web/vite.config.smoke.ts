/* Vite dev config for the charts/monitoring wave smoke harness (dev-only).
   Identical settings to the shared config, but:
   - proxies /api to an ISOLATED mock backend on 127.0.0.1:8951
     (SPARKDECK_MOCK=1 SPARKDECK_DATA_DIR=/tmp/… — see task report)
   - serves /smoke.html (src/dev/smokeEntry.tsx) so the wave pages can be
     driven headlessly while sibling waves are mid-edit.
   Never used by `npm run build` / `npm run dev` (that stays vite.config.ts).
*/

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5210,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8951', changeOrigin: true, ws: true },
    },
  },
});
