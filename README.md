# The Draw

The 2026 Grand Slam singles draws, rendered as radial bundled dendrograms.

128 entrants sit on the rim. Threads bundle inward through seven rounds. The champion
is at dead centre. Stroke weight carries two things at once: how many rounds a player
survived, and how one-sided each win was — the share of total games taken in that match.
The ground is the court surface: grass, terre battue, hard court.

Every result is real. Nothing is modelled, smoothed, or predicted.

## Data

`tools/build_draw.py` reads the published draw sheets from Wikipedia's wikitext,
parses seeds, countries, and set scores, and writes verified JSON into `public/draws/`.
It refuses to emit a draw that does not reconcile: 127 matches, one winner per match,
each round's entrants drawn from the previous round's winners.

```bash
python3 tools/build_draw.py --slam all
```

Six draws are complete for 2026 — Australian Open, Roland-Garros, and Wimbledon, men's
and women's. The US Open is played in late August, so the site shows the structure with
nobody in it yet, alongside a form guide counted from the season's own results.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm start         # production server, needs DATABASE_URL + PUBLIC_URL (see below)
```

## Private leagues

Anyone can start a private, accountless bracket-picking league for a draw: a URL
fragment (`#invite=…`/`#return=…`) is the only credential, never an account or
password. The league owner picks a champion for every match before the draw locks;
autosave keeps drafts durable; standings and a recap update automatically as real
results land. This is a single self-contained feature — one Express server, one
Postgres database, no dependency on any other Rallo service — covering:

- **Capability routes** — invitation/participant/return links signed with
  `SESSION_SECRET`, scoped by same-origin checks against `PUBLIC_URL`
  (`server/draw-routes.ts`, `server/draw-tokens.ts`).
- **Draft autosave & submission** — picks persist as you go and lock at draw start
  (`server/draw-picks.ts`).
- **MediaWiki polling** — a 60-second in-process loop pulls real match results from
  Wikipedia, reconciles them against the current draw, and withholds any update it
  cannot safely apply rather than guessing (`server/draw-ingestion.ts`).
- **Scoring, standings, and recaps** — computed from reconciled results as rounds
  advance (`server/draw-scoring.ts`, `server/draw-standings.ts`).
- **Retention** — expired league data is swept on a schedule (`server/draw-retention.ts`).
- **Operator CLI** — `npm run draw:operations` certifies a live MediaWiki source,
  inspects reconciliation state, and drives maintenance by hand
  (`scripts/draw-operations.ts`).

### Environment variables

The app fails fast in production if required config is missing (see
`server/env.ts`). Every optional subsystem below is off by default and needs an
explicit opt-in — nothing runs "by accident."

| Variable | Required in prod? | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Real `postgres://` URL. Without it, dev falls back to an ephemeral embedded PGlite database (`./.dev-db`) — fine locally, not durable across a redeploy. |
| `PUBLIC_URL` | Yes | Canonical HTTPS origin (no path/query/hash), e.g. `https://the-draw.replit.app`. Mints every invitation/return link and enforces the same-origin boundary on `/api/draw` mutations. |
| `SESSION_SECRET` | Yes | Signs invitation/participant capability tokens. Rotating it invalidates outstanding links. |
| `DRAW_LEAGUE_MUTATIONS_ENABLED` | Yes, for leagues to work at all | `true` to accept league-creation/pick/participant/draft writes (`POST /api/draw/leagues`, `/participants`, `/submissions`, `PUT /api/draw/draft`). Left unset, those routes 404 and the draw serves read-only. This kill-switch does **not** cover participant removal or return-link email — `DELETE /api/draw/participant` and `POST /api/draw/email` stay reachable (same-origin only) regardless of this flag, since they are not league-creation mutations. |
| `DRAW_SOURCE_WORKER_ENABLED` | Yes | `true` to run the 60-second MediaWiki polling/reconciliation loop; the app fails to boot in production without it (draw availability depends on it). Requires `DRAW_SOURCE_USER_AGENT` too. |
| `DRAW_SOURCE_USER_AGENT` | With the line above | Identifies this deployment to MediaWiki per their API etiquette, e.g. `TheDraw/1.0 (you@example.com)`. |
| `DRAW_RETENTION_WORKER_ENABLED` | Yes | `true` to run the scheduled retention sweep of expired league data; the app fails to boot in production without it. |
| `DRAW_EMAIL_WORKER_ENABLED` | No — leave unset | Email delivery for return links is **explicitly disabled** until a standalone canary is proven; see below. |
| `PORT` | No | Defaults to `3000`. Replit sets this automatically for the configured deployment. |

Nothing above requires a Rallo account, Stripe, Blob storage, an account email
provider, a preview password, or any `rallotennis.com` configuration — this app is
fully standalone.

**Email stays off.** `DRAW_EMAIL_WORKER_ENABLED` is not set, so return-link email
delivery is disabled: the app reports a disabled delivery state instead of
pretending a send succeeded. It should only be turned on after a real canary send
is proven end to end with a live `RESEND_API_KEY`/`RESEND_FROM_EMAIL`, at which
point `DRAW_EMAIL_CANARY_PROVEN=true` unlocks the worker. Never fake recovery by
flipping these flags without a proven canary.

## How it is built

- Screen-space SVG for the draw itself. 128 names have to be crisp, selectable, and
  readable by a screen reader, which rules out canvas and WebGL text.
- GSAP for the reveal: the field assembles round by round from the rim inward, decays
  to its resting hierarchy, then the champion's thread ignites.
- Fraunces for the display serif, Geist Sans for interface, Geist Mono for figures.

`prefers-reduced-motion` skips straight to the resting state. A pointer press at any
point during the reveal completes it immediately.

## Testing

```bash
npm run typecheck      # tsc -b --noEmit
npm run lint           # eslint .
npm test               # unit tests (vitest, PGlite — no external DB needed)
npm run test:integration  # needs a real Postgres on DATABASE_URL
npm run test:e2e       # builds, then Playwright end-to-end against a real server
```

`test:integration` looks for `DATABASE_URL` (or falls back to a local Postgres via
`scripts/lib/local-postgres.ts`); `test:e2e` runs the app in "acceptance mode"
(`DRAW_ACCEPTANCE_MODE=true`), which serves the real production build instead of
Vite's dev server so the suite exercises the actual deployed code path.

## Deploying

This is a single Express process — no separate worker, cron, or second service.
MediaWiki polling and league maintenance run in-process on their own interval, so
the deployment target must stay running continuously: on Replit this is a Reserved
VM ("always on"), not autoscale or static (see `.replit`, `deploymentTarget = "vm"`).
An autoscaled/serverless target would spin the instance down between requests and
silently stop polling.

```bash
npm ci
npm run build   # tsc -b && vite build
npm start       # NODE_ENV=production tsx server/bootstrap.ts
```

Set `DATABASE_URL`, `PUBLIC_URL=https://the-draw.replit.app`, `SESSION_SECRET`,
`DRAW_LEAGUE_MUTATIONS_ENABLED=true`, `DRAW_RETENTION_WORKER_ENABLED=true`,
`DRAW_SOURCE_WORKER_ENABLED=true`, and `DRAW_SOURCE_USER_AGENT` as Replit Secrets
(see the environment variable table above; the first two are already committed
in `.replit`, the rest carry operator-specific values and stay secrets). `GET
/api/health` reports liveness — DB connectivity plus MediaWiki-source, email, and
retention worker health — without failing the deployment for expected/valid
states (e.g. no canonical revision yet, email intentionally disabled). `GET
/api/ready`, wired as `.replit`'s `healthCheckPath`, is the deployment readiness
gate: it fails (503) if the source or retention workers are disabled/misconfigured
in production, or if a required worker is genuinely unhealthy — the signal Replit
should use to decide whether the instance is fit to receive traffic.
