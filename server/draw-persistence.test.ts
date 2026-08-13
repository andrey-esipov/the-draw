import { describe, expect, it } from 'vitest';
import type { Draw } from '../shared/draw/contracts.js';
import {
  expectedDrawLeagueExpiry,
  validateDrawDraftForPersistence,
  validateDrawLeagueExpiry,
  validateDrawRecapRound,
} from './draw-persistence.js';

function validDraw(): Draw {
  const players = Object.fromEntries(Array.from({ length: 128 }, (_, index) => {
    const id = `p${index + 1}`;
    return [id, { id, name: id, short: id, country: null, seed: null }];
  }));
  const rounds = [64, 32, 16, 8, 4, 2, 1].map((size, roundIndex) => ({
    round: roundIndex + 1,
    name: `Round ${roundIndex + 1}`,
    matches: Array.from({ length: size }, (_, position) => ({
      id: `r${roundIndex + 1}m${position + 1}`,
      round: roundIndex + 1,
      position,
      sides: roundIndex === 0
        ? [`p${position * 2 + 1}`, `p${position * 2 + 2}`].map((player) => ({
          player,
          seed: null,
          sets: [],
        }))
        : [],
      winner: null,
    })),
  }));
  return {
    id: 'fixture',
    tournament: 'US Open',
    year: 2026,
    event: 'Men’s Singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    bestOf: 5,
    source: { wikipedia: 'fixture', url: 'https://en.wikipedia.org/wiki/fixture' },
    players,
    rounds,
  };
}

describe('Draw persistence validation', () => {
  it('rejects malformed, unknown-match, and unknown-player draft payloads before persistence', () => {
    const draw = validDraw();
    expect(() => validateDrawDraftForPersistence(draw, []))
      .toThrow(/object/i);
    expect(() => validateDrawDraftForPersistence(draw, { unknown: 'p1' }))
      .toThrow(/match/i);
    expect(() => validateDrawDraftForPersistence(draw, { r1m1: 'unknown' }))
      .toThrow(/player/i);
  });

  it('accepts a bounded partial draft and rejects invalid recap rounds', () => {
    const draw = validDraw();
    expect(validateDrawDraftForPersistence(draw, { r1m1: 'p1' })).toEqual({ r1m1: 'p1' });
    expect(() => validateDrawRecapRound(0)).toThrow(/round/i);
    expect(() => validateDrawRecapRound(8)).toThrow(/round/i);
    expect(validateDrawRecapRound(7)).toBe(7);
  });

  it('owns the exact 13-month retention boundary and rejects early expiry', () => {
    const completesAt = new Date('2026-09-13T23:00:00Z');
    const expiry = expectedDrawLeagueExpiry(completesAt);
    expect(expiry.toISOString()).toBe('2027-10-13T23:00:00.000Z');
    expect(() => validateDrawLeagueExpiry(completesAt, new Date('2026-09-13T22:59:59Z')))
      .toThrow(/expiry/i);
    expect(() => validateDrawLeagueExpiry(completesAt, new Date('2027-10-14T23:00:00Z')))
      .toThrow(/13 months/i);
    expect(validateDrawLeagueExpiry(completesAt, expiry)).toEqual(expiry);
  });
});
