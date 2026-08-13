import { describe, expect, it } from 'vitest';
import type { Draw } from './types';
import { fillRemainingBySeed, pickWinner, validPickCount } from './bracket-draft';

function draw(): Draw {
  const players = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => {
      const id = `p${index + 1}`;
      return [id, {
        id,
        name: `Player ${index + 1}`,
        short: `P${index + 1}`,
        country: null,
        seed: index < 32 ? String(index + 1) : null,
      }];
    }),
  );
  return {
    id: 'us-open-2026-men',
    tournament: 'US Open',
    year: 2026,
    event: "Men's Singles",
    surface: 'Hard',
    venue: 'Flushing Meadows',
    city: 'New York',
    bestOf: 5,
    source: { wikipedia: 'source', url: 'source' },
    players,
    rounds: Array.from({ length: 7 }, (_, roundIndex) => {
      const round = roundIndex + 1;
      return {
        round,
        name: round === 7 ? 'Final' : `Round ${round}`,
        matches: Array.from({ length: 2 ** (7 - round) }, (_, position) => ({
          id: `r${round}m${position + 1}`,
          round,
          position,
          sides: round === 1
            ? [{ player: `p${position * 2 + 1}`, seed: null, sets: [] }, { player: `p${position * 2 + 2}`, seed: null, sets: [] }]
            : [],
          winner: null,
        })),
      };
    }),
  };
}

describe('prediction bracket propagation', () => {
  it('propagates winners into exact stable downstream slots', () => {
    const source = draw();
    let picks = pickWinner(source, {}, 'r1m1', 'p1').picks;
    picks = pickWinner(source, picks, 'r1m2', 'p3').picks;
    expect(pickWinner(source, picks, 'r2m1', 'p1').picks).toMatchObject({
      r1m1: 'p1',
      r1m2: 'p3',
      r2m1: 'p1',
    });
  });

  it('repicking clears only incompatible downstream lineage', () => {
    const source = draw();
    const original = { r1m1: 'p1', r1m2: 'p3', r2m1: 'p1', r1m3: 'p5', r1m4: 'p7', r2m2: 'p5', r3m1: 'p1' };
    const result = pickWinner(source, original, 'r1m1', 'p2');
    expect(result.picks).toEqual({ r1m1: 'p2', r1m2: 'p3', r1m3: 'p5', r1m4: 'p7', r2m2: 'p5' });
    expect(result.cleared).toEqual(['r2m1', 'r3m1']);
  });

  it('fills every unresolved match by seed without overriding existing choices', () => {
    const source = draw();
    const filled = fillRemainingBySeed(source, { r1m1: 'p2' });
    expect(filled.r1m1).toBe('p2');
    expect(validPickCount(source, filled)).toBe(127);
    expect(filled.r7m1).toBe('p2');
  });
});
