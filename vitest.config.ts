import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The two Postgres-backed suites below spin up a real ephemeral Postgres
// cluster (scripts/lib/local-postgres.ts: initdb/pg_ctl/createdb) to prove
// real multi-connection contention, not just PGlite. Everything else in
// server/**/*.test.ts already runs fine embedded (server/test-pglite.ts) or
// against mocked/pglite state, so it lives in the default `unit` project.
// When adding a new server test, default to `unit`; only add it here if it
// actually needs a real standalone Postgres process.
const integrationTests = [
  'server/draw-ingestion-postgres.integration.test.ts',
  'server/draw-league-postgres.integration.test.ts',
];

export default defineConfig({
  plugins: [react()],
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}'],
          exclude: [...integrationTests, '**/node_modules/**'],
          // Frontend component/hook tests need a DOM (window/document/Storage);
          // server/scripts tests run in plain Node. Most frontend test files
          // already carry a per-file `// @vitest-environment jsdom` docblock,
          // but this glob-based default covers the rest without forcing
          // jsdom onto the backend suite.
          environmentMatchGlobs: [['src/**', 'jsdom']],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationTests,
        },
      },
    ],
  },
});
