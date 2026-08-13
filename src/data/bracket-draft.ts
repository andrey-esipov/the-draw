import type { Draw, Match } from './types';

export interface PickResult {
  picks: Record<string, string>;
  cleared: string[];
}

function matchMap(draw: Draw): Map<string, Match> {
  return new Map(draw.rounds.flatMap((round) => round.matches).map((match) => [match.id, match]));
}

export function matchEntrants(
  picks: Record<string, string>,
  match: Match,
): string[] {
  if (match.round === 1) return match.sides.map((side) => side.player).filter(Boolean);
  const left = picks[`r${match.round - 1}m${match.position * 2 + 1}`];
  const right = picks[`r${match.round - 1}m${match.position * 2 + 2}`];
  return [left, right].filter((player): player is string => Boolean(player));
}

export function pickWinner(
  draw: Draw,
  current: Record<string, string>,
  matchId: string,
  playerId: string,
): PickResult {
  const matches = matchMap(draw);
  const match = matches.get(matchId);
  if (!match || !matchEntrants(current, match).includes(playerId)) {
    return { picks: current, cleared: [] };
  }
  const picks = { ...current, [matchId]: playerId };
  const cleared: string[] = [];
  let round = match.round + 1;
  let position = Math.floor(match.position / 2);
  while (round <= draw.rounds.length) {
    const nextId = `r${round}m${position + 1}`;
    const next = matches.get(nextId);
    if (!next) break;
    const existing = picks[nextId];
    if (existing && !matchEntrants(picks, next).includes(existing)) {
      delete picks[nextId];
      cleared.push(nextId);
    }
    round += 1;
    position = Math.floor(position / 2);
  }
  return { picks, cleared };
}

function seedValue(seed: string | null): number {
  if (!seed) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(seed.replace(/[^\d].*$/, ''), 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function fillRemainingBySeed(
  draw: Draw,
  current: Record<string, string>,
): Record<string, string> {
  let picks = { ...current };
  for (const round of [...draw.rounds].sort((a, b) => a.round - b.round)) {
    for (const match of [...round.matches].sort((a, b) => a.position - b.position)) {
      if (picks[match.id]) continue;
      const entrants = matchEntrants(picks, match);
      if (entrants.length !== 2) continue;
      const winner = [...entrants].sort((a, b) => {
        const seedDifference = seedValue(draw.players[a]?.seed ?? null) - seedValue(draw.players[b]?.seed ?? null);
        return seedDifference || entrants.indexOf(a) - entrants.indexOf(b);
      })[0]!;
      picks = pickWinner(draw, picks, match.id, winner).picks;
    }
  }
  return picks;
}

export function validPickCount(draw: Draw, picks: Record<string, string>): number {
  let valid = 0;
  for (const round of [...draw.rounds].sort((a, b) => a.round - b.round)) {
    for (const match of round.matches) {
      const pick = picks[match.id];
      if (pick && matchEntrants(picks, match).includes(pick)) valid += 1;
    }
  }
  return valid;
}

export function clearAffectedPicks(
  picks: Record<string, string>,
  affectedMatchIds: string[],
): Record<string, string> {
  const next = { ...picks };
  for (const id of affectedMatchIds) delete next[id];
  return next;
}
