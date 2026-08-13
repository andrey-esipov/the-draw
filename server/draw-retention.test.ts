import { count, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  drawRetentionHealth,
  processDrawRetentionPass,
} from './draw-retention.js';
import {
  drawAcceptedRevisions,
  drawActiveSubmissions,
  drawEmailOutbox,
  drawEngagementEvents,
  drawEvents,
  drawLeagues,
  drawParticipantDrafts,
  drawParticipants,
  drawRecapFacts,
  drawSubmissions,
} from './schema.js';
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-retention');
const expiry = new Date('2027-10-13T23:00:00Z');

async function seedExpired(database: Parameters<Parameters<typeof withDb>[0]>[0]) {
  const [event] = await database.insert(drawEvents).values({
    slug: 'retention-event',
    drawId: 'retention-event',
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: 'https://en.wikipedia.org/wiki/retention-event',
    lockAt: new Date('2026-08-24T15:00:00Z'),
    completesAt: new Date('2026-09-13T23:00:00Z'),
  }).returning();
  const [revision] = await database.insert(drawAcceptedRevisions).values({
    eventId: event!.id,
    sourceRevisionId: 'retention-1',
    checksum: 'a'.repeat(64),
    fetchedAt: expiry,
    acceptedAt: expiry,
    parserVersion: 'u1',
    payload: {},
    explicitCorrections: [],
    complete: true,
  }).returning();
  const [league] = await database.insert(drawLeagues).values({
    eventId: event!.id,
    name: 'Private league',
    expiresAt: expiry,
  }).returning();
  const [participant] = await database.insert(drawParticipants).values({
    leagueId: league!.id,
    seat: 1,
    displayName: 'Sensitive Name',
  }).returning();
  await database.insert(drawParticipantDrafts).values({
    participantId: participant!.id,
    leagueId: league!.id,
    eventId: event!.id,
    acceptedRevisionId: revision!.id,
    version: 1,
    picks: { r1m1: 'p1' },
    invalidatedMatchIds: [],
  });
  const [submission] = await database.insert(drawSubmissions).values({
    participantId: participant!.id,
    leagueId: league!.id,
    eventId: event!.id,
    acceptedRevisionId: revision!.id,
    version: 1,
    contractVersion: 'draw-bracket-v1',
    checksum: 'c'.repeat(64),
    picks: { r1m1: 'p1' },
    validatedAt: expiry,
  }).returning();
  await database.insert(drawActiveSubmissions).values({
    participantId: participant!.id,
    leagueId: league!.id,
    submissionId: submission!.id,
  });
  await database.insert(drawRecapFacts).values({
    leagueId: league!.id,
    eventId: event!.id,
    round: 1,
    acceptedRevisionId: revision!.id,
    facts: { participantIds: [participant!.id] },
  });
  await database.insert(drawEmailOutbox).values({
    leagueId: league!.id,
    participantId: participant!.id,
    kind: 'return_link',
    recipientEmail: 'private@example.test',
    recipientHash: 'b'.repeat(64),
    status: 'pending',
    availableAt: expiry,
  });
  await database.insert(drawEngagementEvents).values({
    leagueId: league!.id,
    participantId: participant!.id,
    kind: 'submission',
    round: 0,
  });
  return { event: event!, league: league! };
}

describe('Draw retention maintenance', () => {
  it('deletes the complete league aggregate while retaining canonical revisions', () => withDb(async (database) => {
    const state = await seedExpired(database);
    const result = await processDrawRetentionPass({
      database,
      now: new Date(expiry.getTime() + 60_000),
    });
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
    expect(await database.select().from(drawLeagues)).toEqual([]);
    expect(await database.select().from(drawParticipants)).toEqual([]);
    expect(await database.select().from(drawParticipantDrafts)).toEqual([]);
    expect(await database.select().from(drawSubmissions)).toEqual([]);
    expect(await database.select().from(drawActiveSubmissions)).toEqual([]);
    expect(await database.select().from(drawRecapFacts)).toEqual([]);
    expect(await database.select().from(drawEmailOutbox)).toEqual([]);
    expect(await database.select().from(drawEngagementEvents)).toEqual([]);
    const [revisions] = await database.select({ value: count() }).from(drawAcceptedRevisions)
      .where(eq(drawAcceptedRevisions.eventId, state.event.id));
    expect(revisions!.value).toBe(1);
  }));

  it('rolls back a partial failure, retries idempotently, and reports the 24-hour health boundary', () => withDb(async (database) => {
    const state = await seedExpired(database);
    const failOnce = vi.fn(async () => {
      if (failOnce.mock.calls.length === 1) throw new Error('private provider detail');
    });
    const overdueNow = new Date(expiry.getTime() + 24 * 60 * 60_000 + 1);
    expect(await processDrawRetentionPass({
      database,
      now: overdueNow,
      beforeDelete: failOnce,
    })).toMatchObject({
      deleted: 0,
      failed: 1,
      failures: [{ leagueId: state.league.id, reason: 'cleanup_failed' }],
    });
    expect(await database.select().from(drawLeagues)).toHaveLength(1);
    expect(await drawRetentionHealth(database, overdueNow, true)).toMatchObject({
      state: 'unhealthy',
      expiredLeagues: 1,
      orphanRecords: 0,
      oldestOverdueMs: 24 * 60 * 60_000 + 1,
    });
    expect(await processDrawRetentionPass({
      database,
      now: overdueNow,
      beforeDelete: failOnce,
    })).toMatchObject({ deleted: 1, failed: 0 });
    expect(await processDrawRetentionPass({ database, now: overdueNow }))
      .toMatchObject({ deleted: 0, failed: 0 });
    expect(await drawRetentionHealth(database, overdueNow, true)).toMatchObject({
      state: 'current',
      expiredLeagues: 0,
      orphanRecords: 0,
    });
  }));

  it('reuses orphan scan results within the health interval', () => withDb(async (database) => {
    let selects = 0;
    const counted = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'select') {
          return (...args: Parameters<typeof target.select>) => {
            selects += 1;
            return target.select(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await drawRetentionHealth(counted, expiry, true);
    const firstPassSelects = selects;
    await drawRetentionHealth(counted, new Date(expiry.getTime() + 1_000), true);
    expect(firstPassSelects).toBe(8);
    expect(selects - firstPassSelects).toBe(1);
  }));

  it('shares one orphan scan across concurrent health checks', () => withDb(async (database) => {
    let selects = 0;
    const counted = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'select') {
          return (...args: Parameters<typeof target.select>) => {
            selects += 1;
            return target.select(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await Promise.all([
      drawRetentionHealth(counted, expiry, true),
      drawRetentionHealth(counted, expiry, true),
    ]);
    expect(selects).toBe(9);
  }));
});
