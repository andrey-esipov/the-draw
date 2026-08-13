import type { Draw } from '../shared/draw/contracts.js';
import { competitionRanks, pointsForRound, scoreSubmission, type ScoringSubmission } from './draw-scoring.js';

export interface DrawRecapFacts {
  version: 1;
  round: number;
  roundLabel: string;
  movements: Array<{
    participantId: string;
    previousRank: number;
    rank: number;
    score: number;
    movement: number;
  }>;
  rarestCorrectCall: {
    participantId: string;
    playerId: string;
    matchId: string;
    pickCount: number;
    submittedCount: number;
  } | null;
  highestImpactMiss: {
    participantId: string;
    playerId: string;
    matchId: string;
    lostFuturePoints: number;
  } | null;
  survivingChampions: Array<{
    participantId: string;
    playerId: string;
  }>;
}

function terminalWinner(match: Draw['rounds'][number]['matches'][number]): string | null {
  return match.winner && ['completed', 'retirement', 'walkover'].includes(match.terminal ?? '')
    ? match.winner
    : null;
}

function isCompletedRound(draw: Draw, round: number): boolean {
  const matches = draw.rounds.find((candidate) => candidate.round === round)?.matches ?? [];
  return matches.length > 0 && matches.every((match) => terminalWinner(match));
}

export function newestCompletedDrawRound(draw: Draw): number | null {
  const completed = draw.rounds
    .filter(({ round }) => isCompletedRound(draw, round))
    .map(({ round }) => round);
  return completed.length ? Math.max(...completed) : null;
}

function picks(submission: ScoringSubmission): Record<string, string> {
  return submission.picks && typeof submission.picks === 'object' && !Array.isArray(submission.picks)
    ? submission.picks as Record<string, string>
    : {};
}

function eliminatedPlayers(draw: Draw): Set<string> {
  const eliminated = new Set<string>();
  for (const round of draw.rounds) {
    for (const match of round.matches) {
      const winner = terminalWinner(match);
      if (winner) for (const side of match.sides) if (side.player !== winner) eliminated.add(side.player);
    }
  }
  return eliminated;
}

export function completedRecapRounds(current: Draw, previous: Draw | null): number[] {
  return current.rounds
    .map(({ round }) => round)
    .filter((round) => isCompletedRound(current, round) && (!previous || !isCompletedRound(previous, round)))
    .sort((a, b) => a - b);
}

export function deriveDrawRecapFacts(
  current: Draw,
  previous: Draw | null,
  submissions: ScoringSubmission[],
  round: number,
): DrawRecapFacts | null {
  if (!isCompletedRound(current, round)) return null;
  const currentRound = current.rounds.find((candidate) => candidate.round === round)!;
  const currentScored = submissions.flatMap((submission) => {
    const scored = scoreSubmission(current, submission);
    return scored ? [{ submission, scored }] : [];
  });
  const currentRanks = competitionRanks(currentScored.map(({ submission, scored }) => ({
    participantId: submission.participantId,
    seat: submission.seat,
    score: scored.score,
  })));
  const previousScores = previous
    ? currentScored.flatMap(({ submission }) => {
        const scored = scoreSubmission(previous, submission);
        return scored ? [{ submission, scored }] : [];
      })
    : [];
  const previousRanks = previous
    ? competitionRanks(previousScores.map(({ submission, scored }) => ({
        participantId: submission.participantId,
        seat: submission.seat,
        score: scored.score,
      })))
    : null;
  const movements = currentScored.flatMap(({ submission, scored }) => {
    const rank = currentRanks.get(submission.participantId)?.rank;
    const previousRank = previousRanks?.get(submission.participantId)?.rank;
    return rank && previousRank
      ? [{ participantId: submission.participantId, previousRank, rank, score: scored.score, movement: previousRank - rank }]
      : [];
  }).sort((a, b) => b.movement - a.movement || a.rank - b.rank || a.participantId.localeCompare(b.participantId));

  const positions = new Map(currentRound.matches.map((match) => [match.id, match.position]));
  const correctCalls = currentRound.matches.flatMap((match) => {
    const winner = terminalWinner(match);
    if (!winner) return [];
    const callers = currentScored.filter(({ submission }) => picks(submission)[match.id] === winner);
    return callers.map(({ submission }) => ({
      participantId: submission.participantId,
      seat: submission.seat,
      playerId: winner,
      matchId: match.id,
      pickCount: callers.length,
      submittedCount: currentScored.length,
    }));
  }).sort((a, b) => (
    a.pickCount - b.pickCount
    || (positions.get(a.matchId) ?? 0) - (positions.get(b.matchId) ?? 0)
    || a.seat - b.seat
    || a.participantId.localeCompare(b.participantId)
  ));
  const rarest = correctCalls[0] ?? null;

  const previouslyEliminated = previous ? eliminatedPlayers(previous) : new Set<string>();
  const misses = currentRound.matches.flatMap((match) => {
    const winner = terminalWinner(match);
    if (!winner) return [];
    return currentScored.flatMap(({ submission }) => {
      const selected = picks(submission)[match.id];
      if (!selected || selected === winner || previouslyEliminated.has(selected)) return [];
      const lostFuturePoints = current.rounds
        .filter((future) => future.round > round)
        .flatMap((future) => future.matches)
        .filter((future) => {
          if (picks(submission)[future.id] !== selected) return false;
          const priorMatch = previous?.rounds
            .find((candidate) => candidate.round === future.round)
            ?.matches.find((candidate) => candidate.id === future.id);
          return !priorMatch || terminalWinner(priorMatch) === null;
        })
        .reduce((total, future) => total + pointsForRound(future.round), 0);
      return lostFuturePoints > 0 ? [{
        participantId: submission.participantId,
        seat: submission.seat,
        playerId: selected,
        matchId: match.id,
        lostFuturePoints,
      }] : [];
    });
  }).sort((a, b) => (
    b.lostFuturePoints - a.lostFuturePoints
    || (positions.get(a.matchId) ?? 0) - (positions.get(b.matchId) ?? 0)
    || a.seat - b.seat
    || a.participantId.localeCompare(b.participantId)
  ));
  const miss = misses[0] ?? null;

  const survivingChampions = currentScored
    .filter(({ scored }) => scored.champion.state === 'alive' && scored.champion.playerId)
    .map(({ submission, scored }) => ({
      participantId: submission.participantId,
      seat: submission.seat,
      playerId: scored.champion.playerId,
    }))
    .sort((a, b) => a.seat - b.seat || a.participantId.localeCompare(b.participantId));

  return {
    version: 1,
    round,
    roundLabel: currentRound.name,
    movements,
    rarestCorrectCall: rarest ? {
      participantId: rarest.participantId,
      playerId: rarest.playerId,
      matchId: rarest.matchId,
      pickCount: rarest.pickCount,
      submittedCount: rarest.submittedCount,
    } : null,
    highestImpactMiss: miss ? {
      participantId: miss.participantId,
      playerId: miss.playerId,
      matchId: miss.matchId,
      lostFuturePoints: miss.lostFuturePoints,
    } : null,
    survivingChampions: survivingChampions.map(({ participantId, playerId }) => ({ participantId, playerId })),
  };
}

export function isDrawRecapFacts(value: unknown): value is DrawRecapFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fact = value as Partial<DrawRecapFacts>;
  const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 128;
  const validNumber = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  return fact.version === 1
    && validNumber(fact.round) && fact.round! >= 1 && fact.round! <= 7
    && typeof fact.roundLabel === 'string' && fact.roundLabel.length <= 80
    && Array.isArray(fact.movements) && fact.movements.length <= 32
    && fact.movements.every((movement) => validId(movement.participantId)
      && validNumber(movement.previousRank) && validNumber(movement.rank)
      && validNumber(movement.score) && typeof movement.movement === 'number' && Number.isSafeInteger(movement.movement))
    && (fact.rarestCorrectCall === null || Boolean(fact.rarestCorrectCall
      && validId(fact.rarestCorrectCall.participantId) && validId(fact.rarestCorrectCall.playerId)
      && validId(fact.rarestCorrectCall.matchId) && validNumber(fact.rarestCorrectCall.pickCount)
      && validNumber(fact.rarestCorrectCall.submittedCount)))
    && (fact.highestImpactMiss === null || Boolean(fact.highestImpactMiss
      && validId(fact.highestImpactMiss.participantId) && validId(fact.highestImpactMiss.playerId)
      && validId(fact.highestImpactMiss.matchId) && validNumber(fact.highestImpactMiss.lostFuturePoints)))
    && Array.isArray(fact.survivingChampions) && fact.survivingChampions.length <= 32
    && fact.survivingChampions.every((champion) => validId(champion.participantId) && validId(champion.playerId));
}
