import type { Draw, Match, Player } from './types';

export interface PathStep {
  match: Match;
  roundName: string;
  opponent: Player | null;
  opponentSeed: string | null;
  won: boolean;
  score: string;
  games: number;
}

export interface DrawIndex {
  draw: Draw;
  matchById: Map<string, Match>;
  roundName: Map<number, string>;
  /** Every match a player appeared in, ordered by round. */
  appearances: Map<string, Match[]>;
  champion: Player | null;
  runnerUp: Player | null;
  seeded: Player[];
}

const setsNeeded = (bestOf: number) => Math.ceil(bestOf / 2);

export function indexDraw(draw: Draw): DrawIndex {
  const matchById = new Map<string, Match>();
  const roundName = new Map<number, string>();
  const appearances = new Map<string, Match[]>();

  for (const round of draw.rounds) {
    roundName.set(round.round, round.name);
    for (const match of round.matches) {
      matchById.set(match.id, match);
      for (const side of match.sides) {
        const list = appearances.get(side.player);
        if (list) list.push(match);
        else appearances.set(side.player, [match]);
      }
    }
  }

  const final = draw.rounds[draw.rounds.length - 1]?.matches[0] ?? null;
  const championId = final?.winner ?? null;
  const runnerUpId = final ? (final.sides.find((s) => s.player !== championId)?.player ?? null) : null;

  const seeded = Object.values(draw.players)
    .filter((p) => p.seed !== null)
    .sort((a, b) => Number(a.seed) - Number(b.seed));

  return {
    draw,
    matchById,
    roundName,
    appearances,
    champion: championId ? (draw.players[championId] ?? null) : null,
    runnerUp: runnerUpId ? (draw.players[runnerUpId] ?? null) : null,
    seeded,
  };
}

/** Games won across a whole match, both sides. A crude but honest proxy for length. */
export function totalGames(match: Match): number {
  return match.sides.reduce((sum, side) => sum + side.sets.reduce((s, set) => s + set.games, 0), 0);
}

export function isIncomplete(match: Match, bestOf: number): boolean {
  if (!match.winner) return false;
  const side = match.sides.find((s) => s.player === match.winner);
  if (!side) return false;
  return side.sets.filter((s) => s.won).length < setsNeeded(bestOf);
}

/**
 * Score from the winner's point of view: "6–4, 3–6, 7–6(6), 6–2".
 * Tiebreak points shown are the loser's, matching tennis convention.
 */
export function formatScore(match: Match, bestOf: number): string {
  if (!match.winner || match.sides.length !== 2) return '—';
  const winner = match.sides.find((s) => s.player === match.winner);
  const loser = match.sides.find((s) => s.player !== match.winner);
  if (!winner || !loser) return '—';

  const sets: string[] = [];
  const count = Math.max(winner.sets.length, loser.sets.length);
  for (let i = 0; i < count; i++) {
    const w = winner.sets[i];
    const l = loser.sets[i];
    if (!w || !l) continue;
    const tb = w.tiebreak !== null && l.tiebreak !== null ? Math.min(w.tiebreak, l.tiebreak) : null;
    sets.push(`${w.games}–${l.games}${tb !== null ? `(${tb})` : ''}`);
  }
  const score = sets.join(', ');
  return isIncomplete(match, bestOf) ? `${score} ret.` : score;
}

export function pathOf(index: DrawIndex, playerId: string): PathStep[] {
  const { draw } = index;
  const matches = index.appearances.get(playerId) ?? [];
  return [...matches]
    .sort((a, b) => a.round - b.round)
    .map((match) => {
      const other = match.sides.find((s) => s.player !== playerId) ?? null;
      return {
        match,
        roundName: index.roundName.get(match.round) ?? `Round ${match.round}`,
        opponent: other ? (draw.players[other.player] ?? null) : null,
        opponentSeed: other?.seed ?? null,
        won: match.winner === playerId,
        score: formatScore(match, draw.bestOf),
        games: totalGames(match),
      };
    });
}

const SEED_UPSET_THRESHOLD = 16;

const seedNum = (seed: string | null): number | null => {
  if (!seed) return null;
  const n = Number(seed);
  return Number.isFinite(n) ? n : null;
};

export function upsetMatchIds(index: DrawIndex): string[] {
  const out: string[] = [];
  for (const round of index.draw.rounds) {
    for (const match of round.matches) {
      if (!match.winner) continue;
      const win = match.sides.find((s) => s.player === match.winner);
      const lose = match.sides.find((s) => s.player !== match.winner);
      if (!win || !lose) continue;
      const loseSeed = seedNum(lose.seed);
      const winSeed = seedNum(win.seed);
      if (loseSeed === null || loseSeed > SEED_UPSET_THRESHOLD) continue;
      if (winSeed !== null && winSeed - loseSeed <= 8) continue;
      out.push(match.id);
    }
  }
  return out;
}
