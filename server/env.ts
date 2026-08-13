// All external wiring is env-config: the app redeploys anywhere by changing env,
// never code. Local development runs with PGlite (data in ./.dev-db) with zero
// config; production requires DATABASE_URL. Env is injected by the host (Replit
// Secrets / shell export) — no dotenv dependency.
const env = process.env;
export const isProd = env.NODE_ENV === 'production';
export const PORT = Number(env.PORT) || 3000;

// Public origin used to mint invitation/return links (#invite=…, #return=…) and to
// enforce the same-origin/cross-origin boundary on every /api/draw mutation. On
// Replit this is the deployment URL; set PUBLIC_URL explicitly in production.
export const PUBLIC_URL = env.PUBLIC_URL
  || (env.REPLIT_DEV_DOMAIN && `https://${env.REPLIT_DEV_DOMAIN}`)
  || `http://localhost:${PORT}`;

export function isCanonicalHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && value === url.origin
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}
export const hasCanonicalPublicUrl = isCanonicalHttpsOrigin(env.PUBLIC_URL);

// Signs invitation/participant capability JWTs (draw-tokens.ts). A stable secret
// keeps capability links valid across restarts; the insecure dev default is fine
// locally (links just stop verifying on rotation).
export const SESSION_SECRET = env.SESSION_SECRET || 'dev-insecure-secret-change-me';

// Draw return-link transactional email. Unset => email-send routes return a
// disabled delivery instead of pretending the request succeeded.
export const RESEND_API_KEY = env.RESEND_API_KEY || '';
export const RESEND_FROM_EMAIL = env.RESEND_FROM_EMAIL || '';
export const hasDrawEmailProvider = Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);

const DRAW_SOURCE_USER_AGENT_RAW = env.DRAW_SOURCE_USER_AGENT?.trim() || '';
export const DRAW_SOURCE_USER_AGENT = DRAW_SOURCE_USER_AGENT_RAW
  || 'TheDraw/0.1 (https://the-draw.replit.app)';
export const DRAW_SOURCE_WORKER_ENABLED = env.DRAW_SOURCE_WORKER_ENABLED === 'true';
export const DRAW_LEAGUE_MUTATIONS_ENABLED = env.DRAW_LEAGUE_MUTATIONS_ENABLED === 'true';
export const DRAW_SOURCE_MAXLAG_SECONDS = 5;
export const DRAW_SOURCE_DEADLINE_MS = 10_000;
export const DRAW_EMAIL_WORKER_ENABLED = env.DRAW_EMAIL_WORKER_ENABLED === 'true';
export const DRAW_EMAIL_CANARY_PROVEN = env.DRAW_EMAIL_CANARY_PROVEN === 'true';
export const DRAW_RETENTION_WORKER_ENABLED = env.DRAW_RETENTION_WORKER_ENABLED === 'true';

// Postgres: a real postgres:// URL uses postgres-js; otherwise embedded pglite.
export const DATABASE_URL = env.DATABASE_URL || '';
export const hasPostgres = /^postgres(ql)?:\/\//.test(DATABASE_URL);
export const DATABASE_POOL_MAX = (() => {
  const value = Number(env.DATABASE_POOL_MAX?.trim() || '5');
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 5;
})();

export function requiredEnvErrors(): string[] {
  const missing: string[] = [];
  if (isProd && !hasPostgres) {
    missing.push('DATABASE_URL (a real postgres:// URL is required in production — pglite is ephemeral on redeploy)');
  }
  if (isProd && !hasCanonicalPublicUrl) {
    missing.push('PUBLIC_URL (must be a canonical HTTPS origin with no path, e.g. https://the-draw.replit.app)');
  }
  if (isProd && SESSION_SECRET === 'dev-insecure-secret-change-me') {
    missing.push('SESSION_SECRET (required in production — signs invitation/participant capability tokens)');
  }
  if (DRAW_SOURCE_WORKER_ENABLED && !DRAW_SOURCE_USER_AGENT_RAW) {
    missing.push('DRAW_SOURCE_USER_AGENT (required when DRAW_SOURCE_WORKER_ENABLED=true and must identify the operator)');
  }
  if (DRAW_EMAIL_WORKER_ENABLED && !DRAW_EMAIL_CANARY_PROVEN) {
    missing.push('DRAW_EMAIL_CANARY_PROVEN=true (required after a successful canary before enabling Draw email)');
  }
  if (DRAW_EMAIL_WORKER_ENABLED && !hasDrawEmailProvider) {
    missing.push('RESEND_API_KEY and RESEND_FROM_EMAIL (required when DRAW_EMAIL_WORKER_ENABLED=true)');
  }
  return missing;
}
