// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';

describe('Draw bundle base', () => {
  it('uses the origin root in both development and production builds', async () => {
    const configFile = resolve(process.cwd(), 'vite.config.ts');
    const development = await resolveConfig({ configFile }, 'serve', 'development');
    const production = await resolveConfig({ configFile }, 'build', 'production');
    expect(development.base).toBe('/');
    expect(production.base).toBe('/');
  });
});
