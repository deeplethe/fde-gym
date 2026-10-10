import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  server: {
    port: 5173,
    // API_PORT: point at a second API server (e.g. a mock one next to the real dev server).
    // ws: runners connect to /api/runner/connect.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}`, ws: true } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
