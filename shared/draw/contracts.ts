export type Surface = 'Hard' | 'Clay' | 'Grass';
export type MatchTerminality = 'completed' | 'retirement' | 'walkover' | 'incomplete';

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
  terminal?: MatchTerminality;
}

export interface Round {
  round: number;
  name: string;
  matches: Match[];
}

export interface Draw {
  id: string;
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

export type DrawDescriptor = Omit<Draw, 'source' | 'players' | 'rounds'>;

export interface DrawSourceRevisionInput {
  draw: DrawDescriptor;
  source: Draw['source'];
  revisionId: string;
  fetchedAt: string;
  wikitext: string;
  checksum?: string;
  explicitCorrections?: string[];
}

export interface ParsedDrawRevision {
  revisionId: string;
  checksum: string;
  fetchedAt: string;
  parserVersion: string;
  explicitCorrections: string[];
  complete: boolean;
  draw: Draw;
}

export interface AcceptedDrawRevision extends ParsedDrawRevision {
  acceptedAt: string;
}

export type ReconciliationClassification =
  | 'unchanged'
  | 'safe_advance'
  | 'correction'
  | 'structural_revision'
  | 'incomplete'
  | 'conflicting';

export interface ReconciliationResult {
  classification: ReconciliationClassification;
  canonical: AcceptedDrawRevision;
  diagnostics: string[];
  invalidatedMatchIds: string[];
  correctedMatchIds: string[];
}

export interface ReconciliationContext {
  locked: boolean;
  acceptedAt?: string;
}

export type DrawEventKind = 'mens_singles' | 'womens_singles';

export interface DrawInvitationAccess {
  leagueId: string;
  leagueName: string;
  event: { slug: string; kind: DrawEventKind };
  seatsRemaining: number;
  lockAt: string;
}

export interface DrawParticipantAccess {
  league: {
    id: string;
    name: string;
    eventSlug: string;
    eventKind: DrawEventKind;
    lockAt: string;
    revealed: boolean;
  };
  participantId: string;
  participantCount: number;
  viewer: {
    draft: { exists: boolean; version: number; pickCount: number };
    submission: { active: boolean; complete: boolean };
  };
  projection: DrawLeagueProjection | null;
}

export type DrawPathState = 'alive' | 'broken' | 'unresolved' | 'changed-opponent';
export type DrawChampionState = 'alive' | 'broken' | 'unresolved';

export interface DrawPathStepProjection {
  matchId: string;
  round: number;
  roundName: string;
  points: number;
  predictedWinnerId: string;
  predictedWinnerName: string;
  predictedOpponentId: string | null;
  predictedOpponentName: string | null;
  acceptedWinnerId: string | null;
  acceptedWinnerName: string | null;
  acceptedOpponentId: string | null;
  acceptedOpponentName: string | null;
  state: DrawPathState;
}

export interface DrawLeagueStanding {
  participantId: string;
  seat: number;
  displayName: string;
  removed: boolean;
  rank: number;
  tied: boolean;
  score: number;
  maxPossible: number;
  movement: number | null;
  champion: {
    playerId: string;
    playerName: string;
    state: DrawChampionState;
  };
  correctByRound: number[];
  submission: {
    version: number;
    checksum: string;
    picks: Record<string, string>;
  };
  path: DrawPathStepProjection[];
}

export interface DrawLeagueProjection {
  canonical: {
    revisionId: string;
    sourceRevisionId: string;
    checksum: string;
    fetchedAt: string;
    acceptedAt: string;
    sourceUrl: string;
    corrected: boolean;
    freshness: {
      state: 'current' | 'delayed' | 'conflicting' | 'stale';
      lastAttemptAt: string | null;
      lastSuccessfulAt: string | null;
      delayReason: string | null;
    };
  };
  movementAvailable: boolean;
  standings: DrawLeagueStanding[];
  participants: Array<{
    id: string;
    seat: number;
    displayName: string;
    removed: boolean;
    submitted: boolean;
  }>;
  recap: DrawRecapProjection;
}

export interface DrawRecapMovement {
  participantId: string;
  displayName: string;
  previousRank: number;
  rank: number;
  score: number;
  movement: number;
}

export interface DrawRecapCall {
  participantId: string;
  displayName: string;
  playerId: string;
  playerName: string;
  matchId: string;
  pickCount: number;
  submittedCount: number;
}

export interface DrawRecapMiss {
  participantId: string;
  displayName: string;
  playerId: string;
  playerName: string;
  matchId: string;
  lostFuturePoints: number;
}

export interface DrawRecapChampion {
  participantId: string;
  displayName: string;
  playerId: string;
  playerName: string;
}

export interface DrawRecapViewModel {
  leagueName: string;
  eventLabel: string;
  round: number;
  roundLabel: string;
  headline: string;
  acceptedRevisionId: string;
  sourceRevisionId: string;
  acceptedAt: string;
  sourceFreshness: 'current' | 'delayed' | 'conflicting' | 'stale';
  correctionReplay: 'not_needed' | 'replayed';
  delayReason: string | null;
  movements: DrawRecapMovement[];
  rarestCorrectCall: DrawRecapCall | null;
  highestImpactMiss: DrawRecapMiss | null;
  survivingChampions: DrawRecapChampion[];
}

export type DrawRecapProjection =
  | { state: 'none' }
  | { state: 'updating'; acceptedRevisionId: string }
  | { state: 'current'; acceptedRevisionId: string; viewModel: DrawRecapViewModel };
