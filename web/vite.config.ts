import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app is served by the API server in production (web/dist).
// In development, Vite serves it and forwards API calls to the API server.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // three.js (the sign-in background) is one ~130 KB gzipped chunk, loaded after the form.
  // Three pages: the web app, the till (iOS, Android, desktop and /pos), and the till's customer display.
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        pos: fileURLToPath(new URL('pos.html', import.meta.url)),
        display: fileURLToPath(new URL('display.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
      '/health': { target: process.env.API_URL ?? 'http://localhost:3000' },
    },
  },
});
