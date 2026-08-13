// A production-shaped e2e path exercised under NODE_ENV=development: the acceptance
// runner needs a real Postgres and a real built dist/ (not Vite's dev middleware) to
// prove the actual production static-serving/CSP path end to end, without needing a
// full Replit deploy or hard-coding production env vars into every local test run.
// This is the single seam gating that behavior so it cannot drift from index.ts's own
// isProd branches.
import { stat } from 'node:fs/promises';
import { DATABASE_URL, isProd, PUBLIC_URL } from './env.js';

export const drawAcceptanceModeEnabled = !isProd && process.env.DRAW_ACCEPTANCE_MODE === 'true';
export const shouldServeBuiltSpa = isProd || drawAcceptanceModeEnabled;

function isLoopbackHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function isLoopbackHost(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === value.replace(/\/+$/, '')
      && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function acceptanceModeConfigErrors(options: { distIndexExists: boolean }): string[] {
  if (!drawAcceptanceModeEnabled) return [];
  const errors: string[] = [];
  const databaseIsPostgres = (() => {
    try {
      const parsed = new URL(DATABASE_URL);
      return (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:')
        && isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  })();
  if (!databaseIsPostgres) errors.push('DATABASE_URL (real, loopback Postgres is required)');
  if (!isLoopbackHost(PUBLIC_URL)) errors.push('PUBLIC_URL (must be a loopback origin)');
  if (!options.distIndexExists) errors.push('dist/index.html (must exist — run `npm run build` first)');
  return errors;
}

export async function drawAcceptanceModeErrors(indexHtmlPath: string): Promise<string[]> {
  const distIndexExists = await stat(indexHtmlPath)
    .then((details) => details.isFile())
    .catch(() => false);
  return acceptanceModeConfigErrors({ distIndexExists });
}

export function assertDrawAcceptanceMode(errors: string[]): void {
  if (errors.length > 0) {
    throw new Error(`DRAW_ACCEPTANCE_MODE preflight failed:\n  - ${errors.join('\n  - ')}`);
  }
}
