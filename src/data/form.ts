import type { Draw, Player, SlamId } from './types';
import { indexDraw } from './analysis';

export interface FormLine {
  player: Player;
  wins: number;
  slams: number;
  titles: number;
  best: string;
}

const ROUND_RANK = ['', 'R1', 'R2', 'R3', 'R4', 'QF', 'SF', 'F'];

/**
 * The season so far, computed from the completed draws themselves. Every number
 * here is counted from the same verified match data the rest of the site draws on.
 */
export function seasonForm(draws: Draw[], limit = 16): FormLine[] {
  const acc = new Map<string, { player: Player; wins: number; slams: number; titles: number; deepest: number }>();

  for (const draw of draws) {
    const index = indexDraw(draw);
    for (const [id, matches] of index.appearances) {
      const player = draw.players[id];
      if (!player) continue;
      const wins = matches.filter((m) => m.winner === id).length;
      const deepest = Math.max(...matches.map((m) => m.round));
      const entry = acc.get(id) ?? { player, wins: 0, slams: 0, titles: 0, deepest: 0 };
      entry.wins += wins;
      entry.slams += 1;
      entry.deepest = Math.max(entry.deepest, deepest);
      if (index.champion?.id === id) entry.titles += 1;
      acc.set(id, entry);
    }
  }

  return [...acc.values()]
    .sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.deepest - a.deepest)
    .slice(0, limit)
    .map((e) => ({
      player: e.player,
      wins: e.wins,
      slams: e.slams,
      titles: e.titles,
      best: ROUND_RANK[e.deepest] ?? '—',
    }));
}

export const COMPLETED: Record<'men' | 'women', SlamId[]> = {
  men: ['australian-open-men', 'french-open-men', 'wimbledon-men'],
  women: ['australian-open-women', 'french-open-women', 'wimbledon-women'],
};

const ROUND_NAMES = [
  '',
  'First round',
  'Second round',
  'Third round',
  'Fourth round',
  'Quarterfinals',
  'Semifinals',
  'Final',
];

/** The shape of a 128-player draw with nobody in it yet. */
export function emptyDraw(id: SlamId, event: string): Draw {
  const rounds = [];
  for (let r = 1; r <= 7; r++) {
    const count = 2 ** (7 - r);
    rounds.push({
      round: r,
      name: ROUND_NAMES[r]!,
      matches: Array.from({ length: count }, (_, position) => ({
        id: `r${r}m${position + 1}`,
        round: r,
        position,
        sides: [],
        winner: null,
      })),
    });
  }
  return {
    id,
    tournament: 'US Open',
    year: 2026,
    event,
    surface: 'Hard',
    venue: 'USTA Billie Jean King National Tennis Center',
    city: 'New York',
    bestOf: id.endsWith('men') ? 5 : 3,
    source: { wikipedia: '', url: '' },
    players: {},
    rounds,
  };
}
