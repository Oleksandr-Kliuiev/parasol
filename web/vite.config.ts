/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The ASP.NET Core host (crm-web) serves the API, BFF endpoints and, in production, the built SPA from wwwroot.
const backend = process.env.CRM_BACKEND_URL ?? 'http://localhost:5180';
const proxied = ['/api', '/bff', '/signin-oidc', '/signout-callback-oidc', '/openapi', '/health', '/admin/jobs'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: backend, secure: false, changeOrigin: false, xfwd: true }]),
    ),
  },
  build: {
    outDir: '../src/Hosts/Crm.Web/wwwroot',
    emptyOutDir: true,
    sourcemap: true,
    // Pages are lazy routes (src/app/router.tsx); the initial download is guarded by scripts/bundle-budget.mjs.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
