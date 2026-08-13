// Standalone Playwright e2e harness: boots the whole app (real ephemeral Postgres,
// the actual `initializeApplication` used in production, MediaWiki polling disabled
// but capability mutations enabled) and seeds two `draw_events` so the league
// lifecycle (invite -> join -> draft autosave -> submit -> standings/recap) can be
// driven end to end through real HTTP, with no Rallo account/Studio/Blob/Stripe
// coupling anywhere in the path.
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import { startLocalPostgres, type LocalPostgres } from './lib/local-postgres.js';

const root = join(import.meta.dirname, '..');
const runDir = join(root, '.draw-e2e-run', randomUUID());
const port = Number(process.env.DRAW_E2E_PORT || 43175);
const origin = `http://127.0.0.1:${port}`;
let postgres: LocalPostgres | undefined;

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function blankDraw(draw: Draw): Draw {
  const next = structuredClone(draw);
  for (const round of next.rounds) {
    for (const match of round.matches) {
      match.winner = null;
      match.terminal = 'incomplete';
      match.sides = round.round === 1 ? match.sides.map((side) => ({ ...side, sets: [] })) : [];
    }
  }
  return next;
}

function completedFirstRound(draw: Draw): Draw {
  const next = structuredClone(draw);
  for (const match of next.rounds[0]!.matches) {
    match.winner = match.sides[0]!.player;
    match.terminal = 'completed';
  }
  return next;
}

async function main(): Promise<void> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  postgres = await startLocalPostgres({ dataDir: join(runDir, 'postgres') });
  Object.assign(process.env, {
    NODE_ENV: 'development',
    DRAW_ACCEPTANCE_MODE: 'true',
    PORT: String(port),
    DATABASE_URL: postgres.url,
    PUBLIC_URL: origin,
    DRAW_SOURCE_WORKER_ENABLED: 'false',
    DRAW_LEAGUE_MUTATIONS_ENABLED: 'true',
    DRAW_EMAIL_WORKER_ENABLED: 'false',
    DRAW_RETENTION_WORKER_ENABLED: 'false',
    SESSION_SECRET: 'draw-e2e-local-only-session-secret-32-characters',
  });

  const [{ db, runMigrations, closeDatabase }, schema, { initializeApplication }, { createStartupGate }, { drawDeploymentInvariants }] = await Promise.all([
    import('../server/db.js'),
    import('../server/schema.js'),
    import('../server/index.js'),
    import('../server/startup-gate.js'),
    import('../server/draw-operations.js'),
  ]);
  await runMigrations();
  const sourceDraw = JSON.parse(
    await readFile(join(root, 'public/draws/wimbledon-men.json'), 'utf8'),
  ) as Draw;
  const initialDraw = blankDraw(sourceDraw);
  const now = new Date();
  const [event] = await db.insert(schema.drawEvents).values({
    slug: 'wimbledon-2026-men',
    drawId: initialDraw.id,
    tournament: initialDraw.tournament,
    tournamentYear: initialDraw.year,
    eventKind: 'mens_singles',
    surface: initialDraw.surface,
    venue: initialDraw.venue,
    city: initialDraw.city,
    sourcePage: initialDraw.source.url,
    lockAt: new Date(now.getTime() + 60 * 60_000),
    completesAt: new Date(now.getTime() + 45 * 24 * 60 * 60_000),
    pollingEnabled: true,
    creationEnabled: true,
    lastAttemptAt: now,
    lastSuccessfulAt: now,
  }).returning();
  if (!event) throw new Error('draw e2e event was not created');
  await db.insert(schema.drawEventOperationsAudit).values({
    eventId: event.id,
    action: 'certified',
    actor: 'draw-e2e',
    reason: 'standalone browser lifecycle',
    configuration: {},
  });

  async function advance(
    eventId: string,
    sourceRevisionId: string,
    draw: Draw,
    explicitCorrections: string[] = [],
  ) {
    const acceptedAt = new Date();
    const payload: AcceptedDrawRevision = {
      revisionId: sourceRevisionId,
      checksum: checksum(draw),
      fetchedAt: acceptedAt.toISOString(),
      acceptedAt: acceptedAt.toISOString(),
      parserVersion: 'mediawiki-v1',
      explicitCorrections,
      complete: false,
      draw,
    };
    const [revision] = await db.insert(schema.drawAcceptedRevisions).values({
      eventId,
      sourceRevisionId,
      checksum: payload.checksum,
      fetchedAt: acceptedAt,
      acceptedAt,
      parserVersion: payload.parserVersion,
      payload,
      explicitCorrections,
      complete: false,
    }).returning();
    if (!revision) throw new Error('draw e2e revision was not created');
    await db.insert(schema.drawEventHeads).values({
      eventId,
      acceptedRevisionId: revision.id,
      revisionAcceptedAt: revision.acceptedAt,
      advancedAt: acceptedAt,
    }).onConflictDoUpdate({
      target: schema.drawEventHeads.eventId,
      set: {
        acceptedRevisionId: revision.id,
        revisionAcceptedAt: revision.acceptedAt,
        advancedAt: acceptedAt,
      },
    });
    await db.update(schema.drawEvents).set({
      lastAttemptAt: acceptedAt,
      lastSuccessfulAt: acceptedAt,
      delayCode: null,
      projectionFailureCode: null,
    }).where(eq(schema.drawEvents.id, eventId));
  }
  await advance(event.id, '9001', initialDraw);

  const frenchSource = JSON.parse(
    await readFile(join(root, 'public/draws/french-open-women.json'), 'utf8'),
  ) as Draw;
  const frenchDraw = blankDraw(frenchSource);
  const [frenchEvent] = await db.insert(schema.drawEvents).values({
    slug: 'french-open-2026-women',
    drawId: frenchDraw.id,
    tournament: frenchDraw.tournament,
    tournamentYear: frenchDraw.year,
    eventKind: 'womens_singles',
    surface: frenchDraw.surface,
    venue: frenchDraw.venue,
    city: frenchDraw.city,
    sourcePage: frenchDraw.source.url,
    lockAt: new Date(now.getTime() + 60 * 60_000),
    completesAt: new Date(now.getTime() + 45 * 24 * 60 * 60_000),
    pollingEnabled: true,
    creationEnabled: true,
    lastAttemptAt: now,
    lastSuccessfulAt: now,
  }).returning();
  if (!frenchEvent) throw new Error('non-default draw e2e event was not created');
  await db.insert(schema.drawEventOperationsAudit).values({
    eventId: frenchEvent.id,
    action: 'certified',
    actor: 'draw-e2e',
    reason: 'direct non-default capability proof',
    configuration: {},
  });
  await advance(frenchEvent.id, '8001', frenchDraw);

  const app = express();
  const gate = createStartupGate();
  app.use(gate.middleware);
  app.post('/__draw-e2e/control/:action', express.json(), async (req, res) => {
    const action = req.params.action;
    if (action === 'lock') {
      await db.update(schema.drawEvents).set({ lockAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.drawEvents.id, event.id));
    } else if (action === 'conflict') {
      await db.update(schema.drawEvents).set({
        delayCode: 'reconciliation_conflict',
        lastAttemptAt: new Date(),
      }).where(eq(schema.drawEvents.id, event.id));
    } else if (action === 'round') {
      await advance(event.id, '9002', completedFirstRound(initialDraw));
    } else if (action === 'correction') {
      const corrected = completedFirstRound(initialDraw);
      corrected.rounds[0]!.matches[0]!.winner = corrected.rounds[0]!.matches[0]!.sides[1]!.player;
      await advance(event.id, '9003', corrected, ['r1m1']);
    } else if (action === 'rollback') {
      await db.update(schema.drawEvents).set({
        creationEnabled: false,
        lockAt: new Date(Date.now() - 1_000),
      }).where(eq(schema.drawEvents.id, event.id));
    } else {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true, action });
  });
  app.get('/__draw-e2e/invariants', async (_req, res) => {
    res.json(await drawDeploymentInvariants(db));
  });
  const server = app.listen(port, '127.0.0.1');
  await initializeApplication(app, gate);
  console.log(JSON.stringify({ ready: true, origin }));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
    await postgres?.stop();
    await rm(runDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

main().catch(async (error) => {
  console.error('[draw-e2e] failed:', error instanceof Error ? error.message : 'unknown');
  await postgres?.stop().catch(() => undefined);
  await rm(runDir, { recursive: true, force: true });
  process.exit(1);
});
