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

export interface Storyline {
  kind: 'upset' | 'marathon' | 'run';
  matchId: string;
  playerId: string;
  headline: string;
  detail: string;
  weight: number;
}

const seedNum = (seed: string | null): number | null => {
  if (!seed) return null;
  const n = Number(seed);
  return Number.isFinite(n) ? n : null;
};

/** Storylines derived purely from the draw itself — no outside data, no editorial. */
export function storylines(index: DrawIndex, limit = 6): Storyline[] {
  const { draw } = index;
  const out: Storyline[] = [];

  for (const round of draw.rounds) {
    for (const match of round.matches) {
      if (!match.winner) continue;
      const winSide = match.sides.find((s) => s.player === match.winner);
      const loseSide = match.sides.find((s) => s.player !== match.winner);
      if (!winSide || !loseSide) continue;

      const winSeed = seedNum(winSide.seed);
      const loseSeed = seedNum(loseSide.seed);
      const winner = draw.players[winSide.player];
      const loser = draw.players[loseSide.player];
      if (!winner || !loser) continue;

      if (loseSeed !== null && loseSeed <= 8 && (winSeed === null || winSeed - loseSeed > 12)) {
        out.push({
          kind: 'upset',
          matchId: match.id,
          playerId: winner.id,
          headline: `${winner.name} over ${loser.name}`,
          detail: `${index.roundName.get(match.round)} · ${formatScore(match, draw.bestOf)}`,
          weight: (9 - loseSeed) * 10 + (winSeed === null ? 8 : 0) + match.round,
        });
      }

      const games = totalGames(match);
      if (games >= (draw.bestOf === 5 ? 58 : 36)) {
        out.push({
          kind: 'marathon',
          matchId: match.id,
          playerId: winner.id,
          headline: `${games} games`,
          detail: `${winner.name} d. ${loser.name} · ${formatScore(match, draw.bestOf)}`,
          weight: games,
        });
      }
    }
  }

  const unseededRun = [...(index.appearances.entries() as Iterable<[string, Match[]]>)]
    .map(([id, matches]) => ({ id, wins: matches.filter((m) => m.winner === id).length }))
    .filter(({ id, wins }) => wins >= 4 && draw.players[id]?.seed === null)
    .sort((a, b) => b.wins - a.wins)[0];

  if (unseededRun) {
    const player = draw.players[unseededRun.id]!;
    const last = (index.appearances.get(unseededRun.id) ?? []).slice(-1)[0];
    out.push({
      kind: 'run',
      matchId: last?.id ?? '',
      playerId: player.id,
      headline: `${player.name}, unseeded`,
      detail: `${unseededRun.wins} wins from the qualifying side of the draw`,
      weight: unseededRun.wins * 25,
    });
  }

  const seen = new Set<string>();
  return out
    .sort((a, b) => b.weight - a.weight)
    .filter((s) => {
      if (seen.has(s.playerId)) return false;
      seen.add(s.playerId);
      return true;
    })
    .slice(0, limit);
}

const SEED_UPSET_THRESHOLD = 16;

/**
 * Matches where a seed inside the top eight lost to someone seeded far below
 * them or unseeded. Marked on the draw so the shocks are legible without
 * anyone having to hunt for them.
 */
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
