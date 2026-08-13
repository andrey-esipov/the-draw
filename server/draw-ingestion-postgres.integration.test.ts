import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalPostgres, type LocalPostgres } from '../scripts/lib/local-postgres';
import type { db } from './db';
import { pollDrawEvent, type DrawSourceFetch } from './draw-ingestion';
import * as schema from './schema';
import { drawAcceptedRevisions, drawEventHeads, drawEvents } from './schema';

const sourcePage = 'https://en.wikipedia.org/wiki/2026_Wimbledon_Championships_%E2%80%93_Men%27s_singles';
const fixtures = resolve(process.cwd(), 'tools/fixtures/mediawiki');
const partial = readFileSync(resolve(fixtures, 'partial-mid-round.wiki'));
const complete = readFileSync(resolve(fixtures, 'complete-wimbledon-men.wiki'));
const now = new Date('2026-08-11T17:00:00Z');

let pg: LocalPostgres;
let adminClient: postgres.Sql;
let firstPollClient: postgres.Sql;
let secondPollClient: postgres.Sql;
let adminDb: ReturnType<typeof drizzlePg<typeof schema>>;
let firstPollDb: typeof db;
let secondPollDb: typeof db;

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function metadata(revisionId: string) {
  return {
    query: {
      pages: [{
        pageid: 1,
        title: '2026 Wimbledon Championships – Men’s singles',
        revisions: [{ revid: Number(revisionId), timestamp: '2026-08-11T16:00:00Z', comment: '' }],
      }],
    },
  };
}

function revision(revisionId: string, content: Buffer) {
  return {
    query: {
      pages: [{
        pageid: 1,
        title: '2026 Wimbledon Championships – Men’s singles',
        revisions: [{
          revid: Number(revisionId),
          timestamp: '2026-08-11T16:00:00Z',
          slots: { main: { content: content.toString('utf8') } },
        }],
      }],
    },
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

beforeAll(async () => {
  pg = await startLocalPostgres({
    dataDir: join(process.cwd(), `.draw-ingestion-postgres-${randomUUID()}`),
  });
  adminClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  firstPollClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  secondPollClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  adminDb = drizzlePg(adminClient, { schema });
  firstPollDb = drizzlePg(firstPollClient, { schema }) as unknown as typeof db;
  secondPollDb = drizzlePg(secondPollClient, { schema }) as unknown as typeof db;
  await migrate(adminDb, { migrationsFolder: join(process.cwd(), 'drizzle') });
}, 300_000);

afterAll(async () => {
  await Promise.all([
    adminClient?.end({ timeout: 5 }),
    firstPollClient?.end({ timeout: 5 }),
    secondPollClient?.end({ timeout: 5 }),
  ]);
  await pg?.stop();
});

describe('draw ingestion production-Postgres contention', () => {
  it('re-reads the accepted head transactionally and rejects a stale concurrent poller', async () => {
    const [event] = await adminDb.insert(drawEvents).values({
      slug: `ingestion-contention-${randomUUID()}`,
      drawId: `ingestion-contention-${randomUUID()}`,
      tournament: 'Wimbledon',
      tournamentYear: 2026,
      eventKind: 'mens_singles',
      surface: 'Grass',
      venue: 'All England Lawn Tennis and Croquet Club',
      city: 'London',
      sourcePage,
      lockAt: new Date('2026-08-10T10:00:00Z'),
      completesAt: new Date('2026-08-20T20:00:00Z'),
      createdAt: new Date('2026-08-01T00:00:00Z'),
      pollingEnabled: true,
    }).returning();

    const [firstBackend] = await firstPollClient<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [secondBackend] = await secondPollClient<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(firstBackend!.pid).not.toBe(secondBackend!.pid);

    const bothInitialReadsFinished = deferred();
    const firstHeadAdvanced = deferred();
    let metadataRequests = 0;
    const fetchFor = (
      revisionId: string,
      content: Buffer,
      waitForFirstHead: boolean,
    ): DrawSourceFetch => async (url) => {
      const target = new URL(String(url));
      if (target.searchParams.has('revids')) {
        if (waitForFirstHead) await firstHeadAdvanced.promise;
        return json(revision(revisionId, content));
      }
      metadataRequests += 1;
      if (metadataRequests === 2) bothInitialReadsFinished.resolve();
      await bothInitialReadsFinished.promise;
      return json(metadata(revisionId));
    };
    const dependencies = {
      lookup: async () => ['208.80.154.224'],
      now: () => now,
      userAgent: 'TheDraw/1.0 (source-operations@the-draw.replit.app)',
      deadlineMs: 30_000,
    };

    const firstPoll = pollDrawEvent(event!.id, {
      ...dependencies,
      database: firstPollDb,
      fetch: fetchFor('102', complete, false),
    });
    const secondPoll = pollDrawEvent(event!.id, {
      ...dependencies,
      database: secondPollDb,
      fetch: fetchFor('101', partial, true),
    });

    await bothInitialReadsFinished.promise;
    expect(await adminDb.select().from(drawEventHeads)).toEqual([]);

    const firstResult = await firstPoll;
    expect(firstResult).toMatchObject({ state: 'accepted', revisionId: '102' });
    firstHeadAdvanced.resolve();

    const secondResult = await secondPoll;
    expect(secondResult).toMatchObject({ state: 'delayed', delayCode: 'reconciliation_conflict' });

    const revisions = await adminDb.select().from(drawAcceptedRevisions);
    const heads = await adminDb.select().from(drawEventHeads);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.sourceRevisionId).toBe('102');
    expect(heads).toHaveLength(1);
    expect(heads[0]!.acceptedRevisionId).toBe(revisions[0]!.id);
  });
});
