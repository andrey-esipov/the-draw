export type SlamId =
  | 'australian-open-men'
  | 'australian-open-women'
  | 'french-open-men'
  | 'french-open-women'
  | 'wimbledon-men'
  | 'wimbledon-women'
  | 'us-open-men'
  | 'us-open-women';

export type Surface = 'Hard' | 'Clay' | 'Grass';

export interface Player {
  id: string;
  name: string;
  short: string;
  country: string | null;
  seed: string | null;
}

export interface SetScore {
  games: number;
  tiebreak: number | null;
  won: boolean;
  /** The set the loser retired in. Its games count is where they stopped. */
  retired?: boolean;
}

export interface Side {
  player: string;
  seed: string | null;
  sets: SetScore[];
}

export interface Match {
  id: string;
  round: number;
  position: number;
  sides: Side[];
  winner: string | null;
}

export interface Round {
  round: number;
  name: string;
  matches: Match[];
}

export interface Draw {
  id: SlamId;
  tournament: string;
  year: number;
  event: string;
  surface: Surface;
  venue: string;
  city: string;
  bestOf: 3 | 5;
  source: { wikipedia: string; url: string };
  players: Record<string, Player>;
  rounds: Round[];
}
