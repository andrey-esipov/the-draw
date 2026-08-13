import { afterEach, describe, expect, it, vi } from 'vitest';

// draw-acceptance.ts computes drawAcceptanceModeEnabled/DATABASE_URL/PUBLIC_URL once at
// module-evaluation time (via server/env.ts), so — same pattern as server/env.test.ts —
// each case stubs env vars, resets the module cache, and re-imports fresh.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('production build availability contract (draw-acceptance)', () => {
  it('is a no-op outside acceptance mode, regardless of how broken the rest of the config is', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DRAW_ACCEPTANCE_MODE', '');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('PUBLIC_URL', '');
    const { acceptanceModeConfigErrors, drawAcceptanceModeEnabled, shouldServeBuiltSpa } = await import('./draw-acceptance.js');
    expect(drawAcceptanceModeEnabled).toBe(false);
    expect(shouldServeBuiltSpa).toBe(false);
    expect(acceptanceModeConfigErrors({ distIndexExists: false })).toEqual([]);
  });

  it('is a no-op in real production (isProd already forces shouldServeBuiltSpa true on its own)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DRAW_ACCEPTANCE_MODE', 'true');
    const { acceptanceModeConfigErrors, drawAcceptanceModeEnabled, shouldServeBuiltSpa } = await import('./draw-acceptance.js');
    expect(drawAcceptanceModeEnabled).toBe(false);
    expect(shouldServeBuiltSpa).toBe(true);
    expect(acceptanceModeConfigErrors({ distIndexExists: false })).toEqual([]);
  });

  it('requires a real, loopback Postgres URL, a loopback PUBLIC_URL, and a real dist/index.html when acceptance mode is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DRAW_ACCEPTANCE_MODE', 'true');
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@remote-host:5432/db');
    vi.stubEnv('PUBLIC_URL', 'https://the-draw.replit.app');
    const { acceptanceModeConfigErrors, drawAcceptanceModeEnabled, shouldServeBuiltSpa } = await import('./draw-acceptance.js');
    expect(drawAcceptanceModeEnabled).toBe(true);
    expect(shouldServeBuiltSpa).toBe(true);
    const errors = acceptanceModeConfigErrors({ distIndexExists: false });
    expect(errors.some((message) => message.startsWith('DATABASE_URL'))).toBe(true);
    expect(errors.some((message) => message.startsWith('PUBLIC_URL'))).toBe(true);
    expect(errors.some((message) => message.startsWith('dist/index.html'))).toBe(true);
  });

  it('passes with a loopback Postgres URL, a loopback PUBLIC_URL, and an existing dist build', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DRAW_ACCEPTANCE_MODE', 'true');
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:5432/db');
    vi.stubEnv('PUBLIC_URL', 'http://localhost:3000');
    const { acceptanceModeConfigErrors } = await import('./draw-acceptance.js');
    expect(acceptanceModeConfigErrors({ distIndexExists: true })).toEqual([]);
  });
});
