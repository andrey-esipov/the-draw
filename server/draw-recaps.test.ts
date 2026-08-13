import { describe, expect, it } from 'vitest';
import type { Draw } from '../shared/draw/contracts.js';
import { afterRoundState, completedRecapRounds, deriveDrawRecapFacts, priorRoundState } from './draw-recaps.js';
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

  it('derives round-over-round movement (against the immediately prior round), not against whatever accepted revision preceded it', () => {
    const current = draw(['a', 'c'], 'a');
    // priorRoundState synthesizes "the draw as of right before round 2 started": round 1's
    // real results kept, round 2 (and later) masked back to incomplete.
    const priorToFinal = priorRoundState(current, 2);
    expect(priorToFinal).toEqual(draw(['a', 'c']));

    const submissions = [
      submission('one', 1, 'a'), // correct every round, including the final.
      submission('two', 2, 'c'), // correct through the semis, wrong on the final (picked 'c', not 'a').
    ];
    const facts = deriveDrawRecapFacts(current, priorToFinal, submissions, 2)!;
    expect(facts.movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: 'one', previousRank: 1, rank: 1, movement: 0 }),
      expect.objectContaining({ participantId: 'two', previousRank: 1, rank: 2, movement: -1 }),
    ]));

    // The bug this guards against: comparing round 2 against whatever accepted revision
    // happened to precede it (here simulated by a missing/null previous, matching a first-ever
    // computation with no earlier revision on record) silently drops every movement instead of
    // reporting the real round-over-round change.
    const withoutRoundBoundary = deriveDrawRecapFacts(current, null, submissions, 2)!;
    expect(withoutRoundBoundary.movements).toEqual([]);
  });

  it('bounds the round-1 recap to round-1 results even after later rounds have since completed', () => {
    // Regression: readAndAdvanceDrawRecap can catch up several completed rounds in one pass
    // (e.g. after a backfill), deriving round 1's recap facts once round 2 has *also* already
    // completed. Passing the unbounded, fully-current draw as `current` lets round-1 facts leak
    // round-2 outcomes -- a champion pick that is still alive as of round 1 (round 2 hasn't been
    // recapped yet) is wrongly reported as already broken by round 2's real, later result.
    const current = draw(['a', 'c'], 'a'); // round 1 decided (a, c advance); final decided: a wins.
    const priorToRoundOne = priorRoundState(current, 1); // nothing decided yet.
    const submissions = [
      submission('one', 1, 'a'), // champion pick 'a' -- the eventual, real winner.
      submission('two', 2, 'c'), // champion pick 'c' -- correct through round 1, eliminated in round 2's final.
    ];

    const leaked = deriveDrawRecapFacts(current, priorToRoundOne, submissions, 1)!;
    expect(leaked.survivingChampions.map((entry) => entry.participantId)).not.toContain('two');

    const bounded = deriveDrawRecapFacts(afterRoundState(current, 1), priorToRoundOne, submissions, 1)!;
    expect(bounded.survivingChampions.map((entry) => entry.participantId).sort()).toEqual(['one', 'two']);
  });
});
