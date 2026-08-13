import { describe, expect, it } from 'vitest';
import type { Draw, Match } from '../shared/draw/contracts.js';
import { competitionRanks, deriveStandings, pointsForRound, scoreSubmission, type ScoringSubmission } from './draw-scoring.js';

function draw(winners: Array<string | null>, opponent = 'b'): Draw {
  const players = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { id, name: id.toUpperCase(), short: id, country: null, seed: null }]));
  const rounds = winners.map((winner, index) => {
    const match: Match = {
      id: `r${index + 1}m1`,
      round: index + 1,
      position: 0,
      sides: index === 0 ? [{ player: 'a', seed: null, sets: [] }, { player: opponent, seed: null, sets: [] }] : [
        { player: 'a', seed: null, sets: [] }, { player: opponent, seed: null, sets: [] },
      ],
      winner,
      terminal: winner ? 'completed' : 'incomplete',
    };
    return { round: index + 1, name: `Round ${index + 1}`, matches: [match] };
  });
  return { id: 'd', tournament: 'T', year: 2026, event: 'E', surface: 'Hard', venue: 'V', city: 'C', bestOf: 3, source: { wikipedia: 'W', url: 'https://example.test' }, players, rounds };
}

function submission(submittedDraw: Draw, id = 'one', seat = 1): ScoringSubmission {
  return {
    participantId: id, seat, displayName: id, removed: false, version: 1, checksum: id,
    picks: Object.fromEntries(submittedDraw.rounds.map((round) => [round.matches[0]!.id, 'a'])),
    submittedDraw,
  };
}

describe('canonical draw scoring', () => {
  it('uses exact doubling round points', () => {
    expect(Array.from({ length: 7 }, (_, index) => pointsForRound(index + 1))).toEqual([1, 2, 4, 8, 16, 32, 64]);
    const source = draw(Array(7).fill(null));
    expect(scoreSubmission(draw(Array(7).fill('a')), submission(source))?.score).toBe(127);
  });

  it('scores the advancing player independently of a changed opponent', () => {
    const source = draw(Array(7).fill(null), 'b');
    const result = scoreSubmission(draw(Array(7).fill('a'), 'c'), submission(source))!;
    expect(result.score).toBe(127);
    expect(result.path[4]).toMatchObject({ points: 16, state: 'changed-opponent', predictedOpponentId: 'b', acceptedOpponentId: 'c' });
  });

  it('withholds only the still-undecided pick affected by a withdrawal, keeping already-decided rounds scored', () => {
    const submitted = draw([null, null]);
    const stale = submission(submitted);
    stale.picks = { r1m1: 'a', r2m1: 'a' };
    // 'a' actually won round 1 (a decided, historical fact) then withdrew before round 2 was played.
    const canonical = draw(['a', null]);
    delete canonical.players.a;
    const result = scoreSubmission(canonical, stale)!;
    expect(result).not.toBeNull();
    expect(result.unscorable).toBe(true);
    expect(result.path[0]).toMatchObject({ matchId: 'r1m1', state: 'alive', predictedWinnerId: 'a' });
    expect(result.path[1]).toMatchObject({ matchId: 'r2m1', state: 'withdrawn', predictedWinnerId: 'a' });
    expect(result.score).toBe(1);
    expect(result.maxPossible).toBe(1);
    expect(result.correctByRound).toEqual([1, 0]);
  });

  it('reports unscorable: false and a real submission for ordinary scored brackets', () => {
    const source = draw(Array(7).fill(null));
    expect(scoreSubmission(draw(Array(7).fill('a')), submission(source))?.unscorable).toBe(false);
  });

  it('still includes a withdrawn-affected submission in standings rather than dropping it', () => {
    const submitted = draw([null]);
    const stale = submission(submitted, 'withdrawn-participant');
    stale.picks = { r1m1: 'b' };
    const canonical = draw([null], 'c');
    delete canonical.players.b;
    const standings = deriveStandings(canonical, [stale]);
    expect(standings).toHaveLength(1);
    expect(standings[0]).toMatchObject({ participantId: 'withdrawn-participant', unscorable: true, score: 0 });
  });

  it.each(['retirement', 'walkover'] as const)('scores a %s only when it names a winner', (terminal) => {
    const canonical = draw([null]);
    canonical.rounds[0]!.matches[0]!.winner = 'a';
    canonical.rounds[0]!.matches[0]!.terminal = terminal;
    expect(scoreSubmission(canonical, submission(draw([null])))?.score).toBe(1);
  });

  it('withholds incomplete and suspended-looking outcomes even if winner bytes exist', () => {
    const canonical = draw([null]);
    canonical.rounds[0]!.matches[0]!.winner = 'a';
    canonical.rounds[0]!.matches[0]!.terminal = 'incomplete';
    const result = scoreSubmission(canonical, submission(draw([null])))!;
    expect(result).toMatchObject({ score: 0, maxPossible: 1 });
    expect(result.path[0]!.state).toBe('unresolved');
  });

  it('uses competition ranking and deterministic seat order without a fabricated tiebreak', () => {
    expect([...competitionRanks([
      { participantId: 'c', seat: 3, score: 4 },
      { participantId: 'b', seat: 2, score: 8 },
      { participantId: 'a', seat: 1, score: 8 },
      { participantId: 'd', seat: 4, score: 1 },
    ])]).toEqual([
      ['a', { rank: 1, tied: true }],
      ['b', { rank: 1, tied: true }],
      ['c', { rank: 3, tied: false }],
      ['d', { rank: 4, tied: false }],
    ]);
  });

  it('replays a correction from immutable picks with no residual score', () => {
    const source = draw([null, null]);
    const fixed = submission(source);
    expect(scoreSubmission(draw(['a', 'a']), fixed)?.score).toBe(3);
    expect(scoreSubmission(draw(['b', 'b']), fixed)?.score).toBe(0);
    expect(scoreSubmission(draw(['a', null]), fixed)).toMatchObject({ score: 1, maxPossible: 3 });
  });

  it('classifies every path state and champion survival while calculating future ceiling', () => {
    const source = draw([null, null, null, null]);
    const canonical = draw(['a', 'b', null, 'a'], 'c');
    canonical.rounds[1]!.matches[0]!.sides = [{ player: 'a', seed: null, sets: [] }, { player: 'b', seed: null, sets: [] }];
    const result = scoreSubmission(canonical, submission(source))!;
    expect(result.path.map((step) => step.state)).toEqual(['changed-opponent', 'broken', 'unresolved', 'changed-opponent']);
    expect(result.champion.state).toBe('broken');
    expect(result.correctByRound).toEqual([1, 0, 0, 1]);
  });

  it('rejects incomplete or invalid active submission bytes and handles 32 tied entries deterministically', () => {
    const source = draw([null]);
    expect(scoreSubmission(source, { ...submission(source), picks: {} })).toBeNull();
    const standings = deriveStandings(source, Array.from({ length: 32 }, (_, index) => submission(source, `p${index}`, 32 - index)));
    expect(standings).toHaveLength(32);
    expect(standings.every((standing) => standing.rank === 1 && standing.tied)).toBe(true);
    expect(standings.map((standing) => standing.seat)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
  });
});
