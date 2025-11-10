// packages/frontend/vite.config.js
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 15173,
    strictPort: true,
  },
  // ✨ 核心修正: 强制 Vite 预打包 lightweight-charts
  optimizeDeps: {
    include: ['lightweight-charts'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        chart: resolve(__dirname, 'chart.html'),
      },
    },
  },
});