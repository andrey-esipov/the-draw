// One server, one port — a single Express process that in dev mounts Vite as
// middleware (HMR) and in prod serves the built SPA from dist/. Everything
// The Draw needs (Postgres, MediaWiki polling, league capability routes,
// health/readiness) hangs off this one process, so it runs on Replit's
// always-on Reserved VM model without any second service to coordinate.
// Must be imported before any router/handler is defined: it patches Express 4 so an
// async handler's rejected promise is forwarded to next(err) automatically, instead
// of crashing the process unhandled — every route below relies on that patch.
import 'express-async-errors';
import { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, runMigrations } from './db.js';
import {
  DRAW_LEAGUE_MUTATIONS_ENABLED,
  isProd,
  PORT,
  requiredEnvErrors,
} from './env.js';
import { startDrawIngestionMaintenance } from './draw-ingestion.js';
import { drawSourceHealth } from './draw-operations.js';
import { mountDrawRoutes } from './draw-routes.js';
import { mountDrawStatic } from './draw-static.js';
import { drawEmailHealth, startDrawEmailDelivery } from './draw-email-outbox.js';
import { drawRetentionHealth, startDrawRetentionMaintenance } from './draw-retention.js';
import { assertDrawAcceptanceMode, drawAcceptanceModeErrors, shouldServeBuiltSpa } from './draw-acceptance.js';
import type { StartupGate } from './startup-gate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');


export async function initializeApplication(app: Express, startupGate: StartupGate) {
  // An e2e acceptance run (DRAW_ACCEPTANCE_MODE=true under NODE_ENV=development) exercises
  // the real production static-serving/CSP path, not Vite's dev middleware — so its own
  // preflight must fail loudly if that path's prerequisites (real Postgres, a loopback
  // PUBLIC_URL, an actual dist/ build) are not in place, the same way the prod fail-fast
  // check below does for a real deploy.
  if (shouldServeBuiltSpa && !isProd) {
    assertDrawAcceptanceMode(await drawAcceptanceModeErrors(join(root, 'dist', 'index.html')));
  }

  // Fail fast in prod when required config is missing: a half-configured "prod" boot
  // (no DATABASE_URL, no PUBLIC_URL) would otherwise start successfully and only fail
  // — or silently lose data — on the first real request. Collect every gap into one
  // error so the operator fixes them all in one pass.
  if (isProd) {
    const missing = requiredEnvErrors();
    if (missing.length) {
      console.error(`[the-draw] FATAL: missing/invalid required production env vars — refusing to boot:\n  - ${missing.join('\n  - ')}`);
      process.exit(1);
    }
  }

  await runMigrations();
  startDrawIngestionMaintenance();
  startDrawEmailDelivery();
  startDrawRetentionMaintenance();

  // Behind Replit's proxy (one hop): trust it so req.ip is the real client, not the
  // proxy socket.
  app.set('trust proxy', 1);

  // ── Security headers ─────────────────────────────────────────────────────
  // Mounted before all other middleware so every response (API, static files,
  // HTML, errors) gets the full header set. draw-static.ts sets its own
  // (stricter, script-nonce-free) CSP on the HTML document itself, which
  // overrides this default for the app shell.
  app.use(helmet({
    contentSecurityPolicy: {
      reportOnly: !isProd,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", ...(!isProd ? ['ws:', 'wss:'] : [])],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
    strictTransportSecurity: isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));

  // Health check: mounted before body parsing — a load-balancer/monitoring probe,
  // not an authenticated route. Pings the DB with a short timeout so "200 OK"
  // actually means the app can serve real requests, not just that the process
  // is alive.
  app.get('/api/health', async (_req, res) => {
    try {
      const [, drawSource, drawEmail, drawRetention] = await Promise.race([
        Promise.all([
          db.execute(sql`select 1`),
          drawSourceHealth(),
          drawEmailHealth(),
          drawRetentionHealth(),
        ]),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('db_health_timeout')), 2000)),
      ]);
      const drawOperational = drawEmail.state !== 'unhealthy' && drawRetention.state !== 'unhealthy';
      res.json({
        ok: true,
        drawOperational,
        db: 'ok',
        ts: Date.now(),
        drawSource,
        drawEmail,
        drawRetention,
      });
    } catch (e) {
      console.error('[the-draw] health check: db ping failed:', e);
      res.status(503).json({ ok: false, db: 'error', ts: Date.now() });
    }
  });

  app.use(compression());

  // Accountless Draw capabilities own strict body and transport boundaries and
  // must remain reachable before any generic parser/404 handler.
  mountDrawRoutes(app, { mutationsEnabled: DRAW_LEAGUE_MUTATIONS_ENABLED });

  // Anything under /api that no route above claimed is a real 404, not the
  // SPA catch-all's index.html, so API clients get a clean signal to branch on.
  app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'not_found' }));

  if (shouldServeBuiltSpa) {
    mountDrawStatic(app, { dist: join(root, 'dist') });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  // Central error handler — must be mounted LAST (Express matches it by arity/position,
  // not by an explicit registration call). express-async-errors (imported above) forwards
  // rejected promises from every async route handler here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { console.error('[the-draw] error after response sent:', err); return; }
    console.error('[the-draw] unhandled request error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  startupGate.markReady();
  console.log(`[the-draw] :${PORT} ${isProd ? '(prod)' : '(dev)'}`);
}
