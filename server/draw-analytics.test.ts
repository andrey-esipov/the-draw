import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import { recordDrawEngagement } from './draw-analytics.js';
import {
  drawAcceptedRevisions,
  drawActiveSubmissions,
  drawEngagementEvents,
  drawEventHeads,
  drawEvents,
  drawLeagues,
  drawParticipants,
  drawRecapFacts,
  drawSubmissions,
} from './schema.js';
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-analytics');
const now = new Date('2026-09-01T12:00:00Z');

function completedDraw(): Draw {
  return {
    id: 'analytics-draw',
    tournament: 'US Open',
    year: 2026,
    event: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    bestOf: 5,
    source: { wikipedia: 'fixture', url: 'https://en.wikipedia.org/wiki/fixture' },
    players: {
      p1: { id: 'p1', name: 'Player 1', short: 'P1', country: null, seed: null },
      p2: { id: 'p2', name: 'Player 2', short: 'P2', country: null, seed: null },
    },
    rounds: [1, 2, 3].map((round) => ({
      round,
      name: `Round ${round}`,
      matches: [{
        id: `r${round}m1`,
        round,
        position: 0,
        sides: [
          { player: 'p1', seed: null, sets: [] },
          { player: 'p2', seed: null, sets: [] },
        ],
        winner: 'p1',
        terminal: 'completed',
      }],
    })),
  };
}

async function seed(database: Parameters<Parameters<typeof withDb>[0]>[0]) {
  const [event] = await database.insert(drawEvents).values({
    slug: 'analytics-event',
    drawId: 'analytics-event',
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: 'https://en.wikipedia.org/wiki/analytics-event',
    lockAt: new Date('2026-08-24T15:00:00Z'),
    completesAt: new Date('2026-09-13T23:00:00Z'),
  }).returning();
  const payload: AcceptedDrawRevision = {
    revisionId: 'analytics-1',
    checksum: 'a'.repeat(64),
    fetchedAt: now.toISOString(),
    acceptedAt: now.toISOString(),
    parserVersion: 'u1',
    explicitCorrections: [],
    complete: false,
    draw: completedDraw(),
  };
  const [revision] = await database.insert(drawAcceptedRevisions).values({
    eventId: event!.id,
    sourceRevisionId: 'analytics-1',
    checksum: 'a'.repeat(64),
    fetchedAt: now,
    acceptedAt: now,
    parserVersion: 'u1',
    payload,
    explicitCorrections: [],
    complete: false,
  }).returning();
  await database.insert(drawEventHeads).values({
    eventId: event!.id,
    acceptedRevisionId: revision!.id,
    revisionAcceptedAt: revision!.acceptedAt,
    advancedAt: now,
  });
  const [league] = await database.insert(drawLeagues).values({
    eventId: event!.id,
    name: 'Friends',
    expiresAt: new Date('2027-10-13T23:00:00Z'),
  }).returning();
  const [participant] = await database.insert(drawParticipants).values({
    leagueId: league!.id,
    seat: 1,
    displayName: 'Sensitive Name',
  }).returning();
  const [submission] = await database.insert(drawSubmissions).values({
    participantId: participant!.id,
    leagueId: league!.id,
    eventId: event!.id,
    acceptedRevisionId: revision!.id,
    version: 1,
    contractVersion: 'draw-bracket-v1',
    checksum: 'b'.repeat(64),
    picks: { r1m1: 'private-pick' },
    validatedAt: now,
  }).returning();
  await database.insert(drawActiveSubmissions).values({
    participantId: participant!.id,
    leagueId: league!.id,
    submissionId: submission!.id,
  });
  await database.insert(drawRecapFacts).values({
    leagueId: league!.id,
    eventId: event!.id,
    round: 3,
    acceptedRevisionId: revision!.id,
    facts: { participantIds: [participant!.id] },
  });
  return { league: league!, participant: participant! };
}

describe('Draw first-party engagement', () => {
  it('deduplicates submissions, qualifying returns, views, and exports across retries and revisions', () => withDb(async (database) => {
    const state = await seed(database);
    for (const kind of ['submission', 'qualifying_return', 'recap_view', 'recap_export'] as const) {
      const round = kind === 'submission' ? 0 : 3;
      const input = { database, leagueId: state.league.id, participantId: state.participant.id, kind, round, now };
      expect(await recordDrawEngagement(input)).toBe(true);
      expect(await recordDrawEngagement(input)).toBe(false);
    }
    const [total] = await database.select({ value: count() }).from(drawEngagementEvents);
    expect(total!.value).toBe(4);
    expect((await database.select().from(drawEngagementEvents)).map((event) => ({
      leagueId: event.leagueId,
      participantId: event.participantId,
      kind: event.kind,
      round: event.round,
      firstAt: event.firstAt,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'submission', round: 0 }),
      expect.objectContaining({ kind: 'qualifying_return', round: 3 }),
      expect.objectContaining({ kind: 'recap_view', round: 3 }),
      expect.objectContaining({ kind: 'recap_export', round: 3 }),
    ]));
  }));

  it('rejects invented rounds, removed owners, and non-allowlisted telemetry fields', () => withDb(async (database) => {
    const state = await seed(database);
    await expect(recordDrawEngagement({
      database,
      leagueId: state.league.id,
      participantId: state.participant.id,
      kind: 'recap_export',
      round: 2,
      now,
    })).rejects.toThrow('engagement_not_eligible');
    await database.update(drawParticipants).set({ removedAt: now, displayName: 'Removed player' })
      .where(eq(drawParticipants.id, state.participant.id));
    await expect(recordDrawEngagement({
      database,
      leagueId: state.league.id,
      participantId: state.participant.id,
      kind: 'recap_view',
      round: 3,
      now,
    })).rejects.toThrow('engagement_not_eligible');
    expect(Object.keys(drawEngagementEvents)).not.toEqual(expect.arrayContaining([
      'displayName', 'email', 'picks', 'token', 'source',
    ]));
  }));
});
