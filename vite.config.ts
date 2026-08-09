import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bind to every interface and accept the proxy hostname so the app is reachable
// when it runs on a hosted dev box (Replit, Codespaces) rather than localhost.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5210, host: true, allowedHosts: true },
  preview: { port: 5210, host: true, allowedHosts: true },
});
