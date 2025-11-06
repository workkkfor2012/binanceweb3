// packages/frontend/vite.config.js
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 15173, // Vite 默认端口
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});