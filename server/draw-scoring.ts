import type {
  Draw,
  DrawChampionState,
  DrawLeagueStanding,
  DrawPathState,
  DrawPathStepProjection,
  Match,
} from '../shared/draw/contracts.js';

export const DRAW_ROUND_POINTS = [1, 2, 4, 8, 16, 32, 64] as const;

export interface ScoringSubmission {
  participantId: string;
  seat: number;
  displayName: string;
  removed: boolean;
  version: number;
  checksum: string;
  picks: unknown;
  submittedDraw: Draw;
}

function terminalWinner(match: Match): string | null {
  if (!match.winner) return null;
  return match.terminal === 'completed' || match.terminal === 'retirement' || match.terminal === 'walkover'
    ? match.winner
    : null;
}

function allMatches(draw: Draw): Match[] {
  return draw.rounds.flatMap((round) => round.matches);
}

function asCompletePicks(draw: Draw, value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const picks = value as Record<string, unknown>;
  const matches = allMatches(draw);
  if (Object.keys(picks).length !== matches.length) return null;
  const winners = new Map<string, string>();
  for (const match of matches) {
    const picked = picks[match.id];
    if (typeof picked !== 'string') return null;
    if (match.round === 1) {
      if (!match.sides.some((side) => side.player === picked)) return null;
    } else {
      const previous = draw.rounds.find((round) => round.round === match.round - 1);
      const entrants = [
        previous?.matches[match.position * 2],
        previous?.matches[match.position * 2 + 1],
      ].map((feeding) => feeding ? winners.get(feeding.id) : undefined);
      if (!entrants.includes(picked)) return null;
    }
    winners.set(match.id, picked);
  }
  return picks as Record<string, string>;
}

function predictedEntrants(draw: Draw, picks: Record<string, string>, match: Match): string[] {
  const submittedMatch = draw.rounds
    .find((round) => round.round === match.round)
    ?.matches.find((candidate) => candidate.id === match.id);
  if (match.round === 1) return submittedMatch?.sides.map((side) => side.player) ?? [];
  const previous = draw.rounds.find((round) => round.round === match.round - 1);
  const fromPicks = [
    previous?.matches[match.position * 2],
    previous?.matches[match.position * 2 + 1],
  ].flatMap((feeding) => feeding && picks[feeding.id] ? [picks[feeding.id]!] : []);
  return fromPicks.length === 2 ? fromPicks : submittedMatch?.sides.map((side) => side.player) ?? [];
}

function name(draw: Draw, playerId: string | null): string | null {
  return playerId ? draw.players[playerId]?.name ?? playerId : null;
}

function pathState(
  match: Match,
  predictedWinner: string,
  predictedOpponent: string | null,
): DrawPathState {
  const winner = terminalWinner(match);
  if (!winner) return 'unresolved';
  if (winner !== predictedWinner) return 'broken';
  const acceptedOpponent = match.sides.find((side) => side.player !== winner)?.player ?? null;
  return predictedOpponent && acceptedOpponent && predictedOpponent !== acceptedOpponent
    ? 'changed-opponent'
    : 'alive';
}

function championState(draw: Draw, championId: string | undefined): DrawChampionState {
  if (!championId || !draw.players[championId]) return 'unresolved';
  for (const match of allMatches(draw)) {
    const winner = terminalWinner(match);
    if (winner && match.sides.some((side) => side.player === championId) && winner !== championId) return 'broken';
  }
  return 'alive';
}

export function pointsForRound(round: number): number {
  return DRAW_ROUND_POINTS[round - 1] ?? 0;
}

export function competitionRanks(scores: Array<{ participantId: string; seat: number; score: number }>): Map<string, {
  rank: number;
  tied: boolean;
}> {
  const ordered = [...scores].sort((a, b) => b.score - a.score || a.seat - b.seat || a.participantId.localeCompare(b.participantId));
  const counts = new Map<number, number>();
  for (const row of ordered) counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
  const ranks = new Map<string, { rank: number; tied: boolean }>();
  let previousScore: number | null = null;
  let rank = 0;
  ordered.forEach((row, index) => {
    if (row.score !== previousScore) rank = index + 1;
    ranks.set(row.participantId, { rank, tied: (counts.get(row.score) ?? 0) > 1 });
    previousScore = row.score;
  });
  return ranks;
}

export function scoreSubmission(canonicalDraw: Draw, submission: ScoringSubmission): Omit<DrawLeagueStanding, 'rank' | 'tied'> | null {
  const picks = asCompletePicks(submission.submittedDraw, submission.picks);
  if (!picks) return null;
  const canonicalMatchIds = new Set(allMatches(canonicalDraw).map((match) => match.id));
  if (allMatches(submission.submittedDraw).some((match) => !canonicalMatchIds.has(match.id))) return null;
  // A structural revision (e.g. a pre-lock withdrawal replaced by a lucky loser) can leave one or
  // more picked player IDs absent from the canonical roster. That makes only those specific picks
  // unscorable -- it must not null out an otherwise-valid submission and hide it from standings.
  const withdrawnPickedIds = new Set(
    Object.values(picks).filter((playerId) => !canonicalDraw.players[playerId]),
  );
  const eliminated = new Set<string>();
  for (const match of allMatches(canonicalDraw)) {
    const winner = terminalWinner(match);
    if (!winner) continue;
    for (const side of match.sides) if (side.player !== winner) eliminated.add(side.player);
  }
  let score = 0;
  let maxPossible = 0;
  let hasUnscorablePick = false;
  const correctByRound = canonicalDraw.rounds.map(() => 0);
  const path: DrawPathStepProjection[] = [];
  for (const round of canonicalDraw.rounds) {
    for (const match of round.matches) {
      const predictedWinner = picks[match.id];
      if (!predictedWinner) continue;
      const entrants = predictedEntrants(submission.submittedDraw, picks, match);
      const predictedOpponent = entrants.find((id) => id !== predictedWinner) ?? null;
      const winner = terminalWinner(match);
      // Only an undecided match can be made unscorable by a withdrawal: once a match has a real,
      // decided winner, whether the predicted player is still in the current roster afterward is
      // irrelevant to whether that decided outcome was predicted correctly.
      const predictedWithdrawn = !winner && withdrawnPickedIds.has(predictedWinner);
      if (predictedWithdrawn) hasUnscorablePick = true;
      const state = predictedWithdrawn ? 'withdrawn' : pathState(match, predictedWinner, predictedOpponent);
      const points = pointsForRound(round.round);
      if (!predictedWithdrawn) {
        if (winner === predictedWinner) {
          score += points;
          correctByRound[round.round - 1] = (correctByRound[round.round - 1] ?? 0) + 1;
        } else if (!winner && !eliminated.has(predictedWinner)) {
          maxPossible += points;
        }
      }
      const acceptedOpponent = winner
        ? match.sides.find((side) => side.player !== winner)?.player ?? null
        : null;
      path.push({
        matchId: match.id,
        round: round.round,
        roundName: round.name,
        points,
        predictedWinnerId: predictedWinner,
        predictedWinnerName: name(submission.submittedDraw, predictedWinner) ?? predictedWinner,
        predictedOpponentId: predictedOpponent,
        predictedOpponentName: name(submission.submittedDraw, predictedOpponent),
        acceptedWinnerId: winner,
        acceptedWinnerName: name(canonicalDraw, winner),
        acceptedOpponentId: acceptedOpponent,
        acceptedOpponentName: name(canonicalDraw, acceptedOpponent),
        state,
      });
    }
  }
  const finalMatch = submission.submittedDraw.rounds.at(-1)?.matches[0];
  const championId = finalMatch ? picks[finalMatch.id] : undefined;
  return {
    participantId: submission.participantId,
    seat: submission.seat,
    displayName: submission.displayName,
    removed: submission.removed,
    score,
    maxPossible: score + maxPossible,
    movement: null,
    unscorable: hasUnscorablePick,
    champion: {
      playerId: championId ?? '',
      playerName: name(submission.submittedDraw, championId ?? null) ?? 'Unavailable',
      state: championState(canonicalDraw, championId),
    },
    correctByRound,
    submission: {
      version: submission.version,
      checksum: submission.checksum,
      picks,
    },
    path,
  };
}

export function deriveStandings(canonicalDraw: Draw, submissions: ScoringSubmission[]): DrawLeagueStanding[] {
  const scored = submissions.flatMap((submission) => {
    const result = scoreSubmission(canonicalDraw, submission);
    return result ? [result] : [];
  });
  const ranks = competitionRanks(scored);
  return scored
    .map((standing) => ({ ...standing, ...ranks.get(standing.participantId)! }))
    .sort((a, b) => a.rank - b.rank || a.seat - b.seat || a.participantId.localeCompare(b.participantId));
}
