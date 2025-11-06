// packages/frontend/vite.config.ts
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 15173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});