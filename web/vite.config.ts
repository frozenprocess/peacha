import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Build output goes into ../server/dist so the Go binary's //go:embed picks
// it up without any copy step. The dev server runs on :5173 and proxies API
// calls to the Go server on :8080 - that mirrors what a production reverse
// proxy would do, so paths in the SPA are environment-independent.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../server/dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1':      'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
});
