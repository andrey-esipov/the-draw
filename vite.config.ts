import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Bind to every interface and accept the proxy hostname so the app is reachable
// when it runs on a hosted dev box (Replit, Codespaces) rather than localhost.
// The app is served from the root of its own origin (there is no other site
// mounted alongside it), so base is always '/', for both dev and build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: '/',
    plugins: [
      react(),
      {
        name: 'draw-build-meta',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-meta.json',
            source: JSON.stringify({
              contractVersion: 1,
              leagueCreationEnabled: env.VITE_DRAW_LEAGUES_ENABLED === 'true',
            }),
          });
        },
      },
    ],
    resolve: { dedupe: ['react', 'react-dom'] },
    // Express embeds Vite in middleware mode (server/index.ts), so these
    // never bind their own listener — kept in sync with PORT (server/env.ts)
    // purely so a stray direct `vite`/`vite preview` invocation doesn't
    // collide with the app's real port.
    server: { port: 3000, host: true, allowedHosts: true },
    preview: { port: 3000, host: true, allowedHosts: true },
    build: {
      chunkSizeWarningLimit: 550,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/[\\/]node_modules[\\/]three[\\/]examples[\\/]/.test(id)) {
              return 'vendor-three-extras';
            }
            if (/[\\/]node_modules[\\/]three[\\/]/.test(id)) return 'vendor-three';
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return 'vendor-react';
            }
          },
        },
      },
    },
  };
});
