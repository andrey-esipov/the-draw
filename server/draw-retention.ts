import { and, count, eq, isNull, lt, min } from 'drizzle-orm';
import { db } from './db.js';
import { DRAW_RETENTION_WORKER_ENABLED } from './env.js';
import {
  drawActiveSubmissions,
  drawEmailOutbox,
  drawEngagementEvents,
  drawLeagues,
  drawParticipantDrafts,
  drawParticipants,
  drawRecapFacts,
  drawSubmissions,
} from './schema.js';

type DrawRetentionDatabase = typeof db;
const PHYSICAL_DELETION_BOUNDARY_MS = 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const ORPHAN_CHECK_INTERVAL_MS = 5 * 60_000;
const orphanCache = new WeakMap<object, { checkedAt: number; value: number }>();
const orphanScans = new WeakMap<object, Promise<number>>();

export const DRAW_DATA_LIFECYCLE_MATRIX = {
  participants: 'anonymize display name; revoke return generation; preserve opaque ID and seat',
  submissions: 'preserve participant ID, immutable picks, score lineage, and revision; contains no name or email',
  recaps: 'preserve participant IDs and competition facts; resolve names only at read time',
  outbox: 'purge destination and replace address hash; discard provider detail; retain bounded delivery state',
  engagement: 'preserve opaque league/participant IDs, allowlisted kind, round, and first timestamp only',
  logs: 'allow bounded reason codes and event kind only; never bearer, name, email, picks, or source payload',
  health: 'aggregate counts, ages, worker state, and bounded reason codes only',
  diagnostics: 'opaque IDs and bounded reason codes only; authorization and request bodies excluded',
  providerMetadata: 'not persisted; destination is purged on removal and league cleanup',
} as const;

export interface DrawRetentionPassResult {
  examined: number;
  deleted: number;
  failed: number;
  failures: Array<{ leagueId: string; reason: 'cleanup_failed' }>;
}

export async function processDrawRetentionPass(input: {
  database?: DrawRetentionDatabase;
  now?: Date;
  batchSize?: number;
  beforeDelete?: (leagueId: string) => Promise<void>;
} = {}): Promise<DrawRetentionPassResult> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('invalid_retention_batch_size');
  }
  const expired = await database.select({ id: drawLeagues.id }).from(drawLeagues)
    .where(lt(drawLeagues.expiresAt, new Date(now.getTime() + 1)))
    .orderBy(drawLeagues.expiresAt)
    .limit(batchSize);
  const result: DrawRetentionPassResult = {
    examined: expired.length,
    deleted: 0,
    failed: 0,
    failures: [],
  };
  for (const league of expired) {
    try {
      const deleted = await database.transaction(async (tx) => {
        const [locked] = await tx.select({ id: drawLeagues.id, expiresAt: drawLeagues.expiresAt })
          .from(drawLeagues)
          .where(eq(drawLeagues.id, league.id))
          .for('update')
          .limit(1);
        if (!locked || now < locked.expiresAt) return false;
        await input.beforeDelete?.(league.id);
        await tx.delete(drawLeagues).where(eq(drawLeagues.id, league.id));
        return true;
      });
      if (deleted) result.deleted += 1;
    } catch {
      result.failed += 1;
      result.failures.push({ leagueId: league.id, reason: 'cleanup_failed' });
    }
  }
  return result;
}

async function orphanCount(database: DrawRetentionDatabase): Promise<number> {
  const [participants, drafts, submissions, active, recaps, outbox, engagement] = await Promise.all([
    database.select({ value: count() }).from(drawParticipants)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawParticipants.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawParticipantDrafts)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawParticipantDrafts.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawSubmissions)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawSubmissions.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawActiveSubmissions)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawActiveSubmissions.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawRecapFacts)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawRecapFacts.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawEmailOutbox)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawEmailOutbox.leagueId))
      .where(isNull(drawLeagues.id)),
    database.select({ value: count() }).from(drawEngagementEvents)
      .leftJoin(drawLeagues, eq(drawLeagues.id, drawEngagementEvents.leagueId))
      .where(isNull(drawLeagues.id)),
  ]);
  return [participants, drafts, submissions, active, recaps, outbox, engagement]
    .reduce((total, rows) => total + Number(rows[0]?.value ?? 0), 0);
}

async function cachedOrphanCount(database: DrawRetentionDatabase, now: Date): Promise<number> {
  const key = database as object;
  const cached = orphanCache.get(key);
  if (cached && now.getTime() - cached.checkedAt < ORPHAN_CHECK_INTERVAL_MS) return cached.value;
  const active = orphanScans.get(key);
  if (active) return active;
  const scan = orphanCount(database).then((value) => {
    orphanCache.set(key, { checkedAt: now.getTime(), value });
    return value;
  }).finally(() => {
    orphanScans.delete(key);
  });
  orphanScans.set(key, scan);
  return scan;
}

export async function drawRetentionHealth(
  database: DrawRetentionDatabase = db,
  now: Date = new Date(),
  workerEnabled = DRAW_RETENTION_WORKER_ENABLED,
) {
  const [backlog] = await database.select({
    value: count(),
    oldest: min(drawLeagues.expiresAt),
  }).from(drawLeagues).where(and(lt(drawLeagues.expiresAt, new Date(now.getTime() + 1))));
  const expiredLeagues = Number(backlog?.value ?? 0);
  const oldestOverdueMs = backlog?.oldest
    ? Math.max(0, now.getTime() - backlog.oldest.getTime())
    : 0;
  const orphanRecords = await cachedOrphanCount(database, now);
  const unhealthy = orphanRecords > 0 || oldestOverdueMs > PHYSICAL_DELETION_BOUNDARY_MS;
  return {
    state: unhealthy ? 'unhealthy' as const : workerEnabled ? 'current' as const : 'disabled' as const,
    workerEnabled,
    expiredLeagues,
    oldestOverdueMs,
    orphanRecords,
    deletionBoundaryMs: PHYSICAL_DELETION_BOUNDARY_MS,
  };
}

export function createDrawRetentionWorker(input: {
  database?: DrawRetentionDatabase;
  now?: () => Date;
  batchSize?: number;
  beforeDelete?: (leagueId: string) => Promise<void>;
} = {}) {
  let running: Promise<DrawRetentionPassResult> | null = null;
  return {
    run(): Promise<DrawRetentionPassResult> {
      if (running) return running;
      running = processDrawRetentionPass({
        ...input,
        now: input.now?.() ?? new Date(),
      }).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export function startDrawRetentionMaintenance(input: {
  database?: DrawRetentionDatabase;
  now?: () => Date;
  batchSize?: number;
  workerEnabled?: boolean;
  intervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
} = {}) {
  if (!(input.workerEnabled ?? DRAW_RETENTION_WORKER_ENABLED)) return null;
  const worker = createDrawRetentionWorker(input);
  const tick = () => {
    void worker.run().then((result) => {
      if (result.failed > 0) {
        console.error(`[draw-retention] pass_partial reason=cleanup_failed count=${result.failed}`);
      }
    }).catch(() => {
      console.error('[draw-retention] pass_failed reason=retention_worker_failed');
    });
  };
  tick();
  const timer = (input.setInterval ?? globalThis.setInterval)(
    tick,
    input.intervalMs ?? 60 * 60_000,
  );
  timer.unref();
  return worker;
}
