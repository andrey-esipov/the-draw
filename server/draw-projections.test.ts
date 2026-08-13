import { describe, expect, it } from 'vitest';
import type { Draw } from '../shared/draw/contracts.js';
import { isDrawRecapFacts, type DrawRecapFacts } from './draw-recaps.js';
import { readAndAdvanceDrawRecap, resolveDrawRecapViewModel } from './draw-projections.js';
import { drawAcceptedRevisions, drawEvents, drawLeagues, drawRecapFacts } from './schema.js';
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-projections');

function completedDraw(): Draw {
  return {
    id: 'draw',
    tournament: 'Fixture',
    year: 2026,
    event: 'Singles',
    surface: 'Hard',
    venue: 'Court',
    city: 'City',
    bestOf: 3,
    source: { wikipedia: 'Fixture', url: 'https://example.test' },
    players: {
      a: { id: 'a', name: 'A Player', short: 'A', country: null, seed: null },
      b: { id: 'b', name: 'B Player', short: 'B', country: null, seed: null },
    },
    rounds: [{
      round: 1,
      name: 'Final',
      matches: [{
        id: 'r1m1',
        round: 1,
        position: 0,
        sides: ['a', 'b'].map((player) => ({ player, seed: null, sets: [] })),
        winner: 'a',
        terminal: 'completed',
      }],
    }],
  };
}

describe('recap persistence and read projection', () => {
  it('appends once per accepted revision, returns updating before current, and preserves corrections', () => withDb(async (database) => {
    const draw = completedDraw();
    const [event] = await database.insert(drawEvents).values({
      slug: 'fixture',
      drawId: 'fixture',
      tournament: 'Fixture',
      tournamentYear: 2026,
      eventKind: 'mens_singles',
      surface: 'Hard',
      venue: 'Court',
      city: 'City',
      sourcePage: 'https://example.test/draw',
      lockAt: new Date('2026-08-01T00:00:00Z'),
      completesAt: new Date('2026-09-01T00:00:00Z'),
    }).returning();
    const revisions = await database.insert(drawAcceptedRevisions).values([1, 2].map((number) => ({
      eventId: event!.id,
      sourceRevisionId: String(number),
      checksum: String(number).repeat(64),
      fetchedAt: new Date(`2026-08-0${number}T00:00:00Z`),
      acceptedAt: new Date(`2026-08-0${number}T00:01:00Z`),
      parserVersion: 'u8',
      payload: { draw },
      explicitCorrections: number === 2 ? ['r1m1'] : [],
      complete: true,
    }))).returning();
    const [league] = await database.insert(drawLeagues).values({
      eventId: event!.id,
      name: 'Private names',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    }).returning();
    const base = {
      database,
      leagueId: league!.id,
      leagueName: league!.name,
      eventId: event!.id,
      eventLabel: 'Fixture 2026',
      sourceRevisionId: '1',
      acceptedAt: '2026-08-01T00:01:00.000Z',
      sourceFreshness: 'current' as const,
      correctionReplay: 'not_needed' as const,
      delayReason: null,
      currentDraw: draw,
      previousDraw: null,
      submissions: [],
      participants: [{ id: 'person', displayName: 'Private Name', removed: false }],
    };
    expect(await readAndAdvanceDrawRecap({ ...base, acceptedRevisionId: revisions[0]!.id })).toEqual({
      state: 'updating',
      acceptedRevisionId: revisions[0]!.id,
    });
    expect((await readAndAdvanceDrawRecap({ ...base, acceptedRevisionId: revisions[0]!.id })).state).toBe('current');
    await Promise.all(Array.from({ length: 4 }, () => readAndAdvanceDrawRecap({
      ...base,
      acceptedRevisionId: revisions[0]!.id,
    })));
    expect(await database.select().from(drawRecapFacts)).toHaveLength(1);
    expect(await readAndAdvanceDrawRecap({
      ...base,
      acceptedRevisionId: revisions[1]!.id,
      sourceRevisionId: '2',
      previousDraw: draw,
    })).toMatchObject({ state: 'updating', acceptedRevisionId: revisions[1]!.id });
    const rows = await database.select().from(drawRecapFacts);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('Private Name');
  }));

  it('resolves removed names only at read time and rejects malformed stored facts', () => {
    const facts: DrawRecapFacts = {
      version: 1,
      round: 1,
      roundLabel: 'Final',
      movements: [{ participantId: 'person', previousRank: 2, rank: 1, score: 4, movement: 1 }],
      rarestCorrectCall: { participantId: 'person', playerId: 'a', matchId: 'r1m1', pickCount: 1, submittedCount: 2 },
      highestImpactMiss: null,
      survivingChampions: [{ participantId: 'person', playerId: 'a' }],
    };
    expect(isDrawRecapFacts({ ...facts, movements: 'bad' })).toBe(false);
    const model = resolveDrawRecapViewModel(facts, {
      leagueId: 'league',
      leagueName: 'League',
      eventId: 'event',
      eventLabel: 'Fixture',
      acceptedRevisionId: 'revision',
      sourceRevisionId: '22',
      acceptedAt: '2026-08-01T00:00:00.000Z',
      sourceFreshness: 'delayed',
      correctionReplay: 'replayed',
      delayReason: 'source_timeout',
      currentDraw: completedDraw(),
      participants: [{ id: 'person', displayName: 'Prior Name', removed: true }],
    });
    expect(JSON.stringify(model)).not.toContain('Prior Name');
    expect(model.movements[0]?.displayName).toBe('Removed player');
    expect(model).toMatchObject({
      sourceFreshness: 'delayed',
      correctionReplay: 'replayed',
      delayReason: 'source_timeout',
    });
  });
});
