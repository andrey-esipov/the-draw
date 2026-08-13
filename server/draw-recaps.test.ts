import { describe, expect, it } from 'vitest';
import type { Draw } from '../shared/draw/contracts.js';
import { completedRecapRounds, deriveDrawRecapFacts } from './draw-recaps.js';
import type { ScoringSubmission } from './draw-scoring.js';

function draw(roundOne: Array<string | null>, final: string | null = null): Draw {
  const ids = ['a', 'b', 'c', 'd'];
  return {
    id: 'fixture',
    tournament: 'Fixture',
    year: 2026,
    event: 'Singles',
    surface: 'Hard',
    venue: 'Court',
    city: 'City',
    bestOf: 3,
    source: { wikipedia: 'Fixture', url: 'https://example.test' },
    players: Object.fromEntries(ids.map((id) => [id, { id, name: id.toUpperCase(), short: id, country: null, seed: null }])),
    rounds: [
      {
        round: 1,
        name: 'Semifinals',
        matches: [['a', 'b'], ['c', 'd']].map((sides, position) => ({
          id: `r1m${position + 1}`,
          round: 1,
          position,
          sides: sides.map((player) => ({ player, seed: null, sets: [] })),
          winner: roundOne[position] ?? null,
          terminal: roundOne[position] ? 'completed' : 'incomplete',
        })),
      },
      {
        round: 2,
        name: 'Final',
        matches: [{
          id: 'r2m1',
          round: 2,
          position: 0,
          sides: roundOne.every(Boolean)
            ? roundOne.map((player) => ({ player: player!, seed: null, sets: [] }))
            : [],
          winner: final,
          terminal: final ? 'completed' : 'incomplete',
        }],
      },
    ],
  };
}

function submission(id: string, seat: number, champion: string): ScoringSubmission {
  const submittedDraw = draw([null, null]);
  return {
    participantId: id,
    seat,
    displayName: `Name ${id}`,
    removed: false,
    version: 1,
    checksum: id.padEnd(64, '0'),
    picks: { r1m1: champion === 'b' ? 'b' : 'a', r1m2: 'c', r2m1: champion },
    submittedDraw,
  };
}

describe('completed-round recap derivation', () => {
  it('detects canonical completed rounds and derives deterministic facts without names', () => {
    const previous = draw([null, null]);
    const current = draw(['a', 'c']);
    const facts = deriveDrawRecapFacts(current, previous, [
      submission('one', 1, 'a'),
      submission('two', 2, 'b'),
      submission('three', 3, 'a'),
    ], 1)!;
    expect(completedRecapRounds(current, previous)).toEqual([1]);
    expect(facts.rarestCorrectCall).toMatchObject({ participantId: 'one', playerId: 'a', matchId: 'r1m1', pickCount: 2 });
    expect(facts.highestImpactMiss).toMatchObject({ participantId: 'two', playerId: 'b', lostFuturePoints: 2 });
    expect(facts.survivingChampions.map((entry) => entry.participantId)).toEqual(['one', 'three']);
    expect(JSON.stringify(facts)).not.toContain('Name ');
  });

  it('uses match position, seat, and participant id as stable rarity and impact ties', () => {
    const facts = deriveDrawRecapFacts(draw(['a', 'c']), draw([null, null]), [
      submission('z', 2, 'b'),
      submission('a', 1, 'b'),
      { ...submission('caller', 3, 'a'), picks: { r1m1: 'a', r1m2: 'd', r2m1: 'a' } },
    ], 1)!;
    expect(facts.rarestCorrectCall).toMatchObject({ participantId: 'caller', matchId: 'r1m1' });
    expect(facts.highestImpactMiss).toMatchObject({ participantId: 'a', matchId: 'r1m1' });
  });

  it('reports honest empty highlights and never derives an incomplete round', () => {
    expect(deriveDrawRecapFacts(draw([null, null]), null, [], 1)).toBeNull();
    const facts = deriveDrawRecapFacts(draw(['a', 'c']), draw([null, null]), [], 1)!;
    expect(facts.rarestCorrectCall).toBeNull();
    expect(facts.highestImpactMiss).toBeNull();
    expect(facts.survivingChampions).toEqual([]);
  });

  it('detects two rounds completed in one accepted revision and stays deterministic at 32 participants', () => {
    const current = draw(['a', 'c'], 'a');
    expect(completedRecapRounds(current, draw([null, null]))).toEqual([1, 2]);
    const facts = deriveDrawRecapFacts(current, draw([null, null]), Array.from(
      { length: 32 },
      (_, index) => submission(`p${String(index).padStart(2, '0')}`, index + 1, 'a'),
    ), 1)!;
    expect(facts.rarestCorrectCall?.participantId).toBe('p00');
    expect(facts.survivingChampions).toHaveLength(32);
  });

  it('replays a correction from immutable picks without carrying prior outcomes', () => {
    const fixed = [submission('one', 1, 'a'), submission('two', 2, 'b')];
    const first = deriveDrawRecapFacts(draw(['a', 'c']), draw([null, null]), fixed, 1)!;
    const corrected = deriveDrawRecapFacts(draw(['b', 'c']), draw(['a', 'c']), fixed, 1)!;
    expect(first.rarestCorrectCall?.participantId).toBe('one');
    expect(corrected.rarestCorrectCall?.participantId).toBe('two');
    expect(corrected.highestImpactMiss?.participantId).toBe('one');
  });
});
