# Replit run notes

## Architecture

The Draw is a single self-contained Express + Postgres app (not a static site):
one process, one port, serving the SPA, the `/api/draw` capability routes, and the
in-process MediaWiki polling/reconciliation/retention loops together. There is no
second service, worker, or cron to coordinate — everything hangs off
`server/bootstrap.ts`. See `README.md` for the full environment-variable table.

## Run the app (dev)

The configured `Dev` workflow runs:

```bash
npm run dev
```

The app listens on port `3000` (configurable via `PORT`), already wired to the
Replit preview. Locally this runs against an ephemeral embedded PGlite database
with zero setup — no `DATABASE_URL` required for development.

## Deployment

`deploymentTarget = "vm"` (Reserved VM, always-on) in `.replit` — deliberately not
`autoscale` or `static`. Polling and retention run on in-process intervals
(`server/draw-ingestion.ts`, `server/draw-retention.ts`); an autoscaled instance
can be spun down between requests and would silently stop polling, and a static
target has no server at all.

```bash
npm ci && npm run build   # [deployment].build
npm start                 # [deployment].run — NODE_ENV=production tsx server/bootstrap.ts
```

Required Replit Secrets for a real production deploy:

- `DATABASE_URL` — real Postgres (Replit's `postgresql-16` module, or any external
  Postgres). Required — the app refuses to boot in production without it.
- `PUBLIC_URL` — `https://the-draw.replit.app`. Required — mints every
  invitation/return link and enforces the mutation same-origin boundary.
- `SESSION_SECRET` — signs capability tokens. Required.
- `DRAW_LEAGUE_MUTATIONS_ENABLED=true` — without it every league-creation/pick
  route 404s (an explicit safety gate, not a bug).
- `DRAW_SOURCE_WORKER_ENABLED=true` plus `DRAW_SOURCE_USER_AGENT` — turns on the
  60-second MediaWiki polling loop.
- `DRAW_RETENTION_WORKER_ENABLED=true` — recommended, sweeps expired league data.
- Email stays intentionally unset (`DRAW_EMAIL_WORKER_ENABLED` off) until a
  standalone canary send is proven — see `README.md`.

No Rallo account, Studio, Blob storage, Stripe, account email provider, preview
password, or `rallotennis.com` configuration is required or read anywhere in this
app.

`GET /api/health` is the readiness/health-check endpoint (`healthCheckPath` in
`.replit`): it pings Postgres and reports MediaWiki-source, email, and retention
worker health in one JSON response.

## Rendering

The app normally opens in the WebGL Board view. When WebGL is unavailable (such as
in a preview environment without a graphics context), it opens in the SVG Radial
view so the draw remains visible and interactive.
