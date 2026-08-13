import { afterEach, describe, expect, it, vi } from 'vitest';

// server/env.ts computes every export once at module-evaluation time from process.env, so each
// case here stubs env vars, resets the module cache, and re-imports fresh to observe the effect —
// mutating process.env alone after the first import would not change already-computed exports.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const validProdEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  PUBLIC_URL: 'https://the-draw.replit.app',
  SESSION_SECRET: 'a-real-production-secret',
  DRAW_SOURCE_WORKER_ENABLED: 'true',
  DRAW_SOURCE_USER_AGENT: 'TheDraw/1.0 (ops@example.com)',
  DRAW_RETENTION_WORKER_ENABLED: 'true',
} as const;

function stubEnv(overrides: Partial<Record<keyof typeof validProdEnv, string | undefined>>) {
  for (const [key, value] of Object.entries({ ...validProdEnv, ...overrides })) {
    if (value === undefined) vi.stubEnv(key, '');
    else vi.stubEnv(key, value);
  }
}

describe('requiredEnvErrors', () => {
  it('reports nothing outside production regardless of missing config', async () => {
    stubEnv({ NODE_ENV: 'development', DATABASE_URL: undefined, PUBLIC_URL: undefined, DRAW_SOURCE_WORKER_ENABLED: undefined, DRAW_RETENTION_WORKER_ENABLED: undefined });
    const { requiredEnvErrors } = await import('./env.js');
    expect(requiredEnvErrors()).toEqual([]);
  });

  it('reports nothing in production when every required var, including the two worker flags, is set', async () => {
    stubEnv({});
    const { requiredEnvErrors } = await import('./env.js');
    expect(requiredEnvErrors()).toEqual([]);
  });

  it('fails fast in production when DRAW_SOURCE_WORKER_ENABLED is left unset (polling silently disabled)', async () => {
    stubEnv({ DRAW_SOURCE_WORKER_ENABLED: undefined, DRAW_SOURCE_USER_AGENT: undefined });
    const { requiredEnvErrors } = await import('./env.js');
    const errors = requiredEnvErrors();
    expect(errors.some((message) => message.startsWith('DRAW_SOURCE_WORKER_ENABLED=true'))).toBe(true);
  });

  it('fails fast in production when DRAW_RETENTION_WORKER_ENABLED is left unset (retention silently disabled)', async () => {
    stubEnv({ DRAW_RETENTION_WORKER_ENABLED: undefined });
    const { requiredEnvErrors } = await import('./env.js');
    const errors = requiredEnvErrors();
    expect(errors.some((message) => message.startsWith('DRAW_RETENTION_WORKER_ENABLED=true'))).toBe(true);
  });

  it('requires a real DRAW_SOURCE_USER_AGENT when polling is enabled, even in production', async () => {
    stubEnv({ DRAW_SOURCE_USER_AGENT: undefined });
    const { requiredEnvErrors } = await import('./env.js');
    const errors = requiredEnvErrors();
    expect(errors.some((message) => message.startsWith('DRAW_SOURCE_USER_AGENT'))).toBe(true);
  });

  it('still requires DATABASE_URL, a canonical PUBLIC_URL, and a real SESSION_SECRET in production', async () => {
    stubEnv({ DATABASE_URL: undefined, PUBLIC_URL: undefined, SESSION_SECRET: undefined });
    const { requiredEnvErrors } = await import('./env.js');
    const errors = requiredEnvErrors();
    expect(errors.some((message) => message.startsWith('DATABASE_URL'))).toBe(true);
    expect(errors.some((message) => message.startsWith('PUBLIC_URL'))).toBe(true);
    expect(errors.some((message) => message.startsWith('SESSION_SECRET'))).toBe(true);
  });
});
