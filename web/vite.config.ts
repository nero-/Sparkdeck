import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiTarget = 'http://127.0.0.1:8936';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // REST + WebSocket (ws:true covers /api/ws — vite upgrades the upgrade).
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900, // echarts core chunk is legitimately large
  },
});
