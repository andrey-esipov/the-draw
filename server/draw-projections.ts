import { and, desc, eq } from 'drizzle-orm';
import type {
  Draw,
  DrawRecapProjection,
  DrawRecapViewModel,
} from '../shared/draw/contracts.js';
import { afterRoundState, deriveDrawRecapFacts, isCompletedRound, isDrawRecapFacts, priorRoundState, type DrawRecapFacts } from './draw-recaps.js';
import type { ScoringSubmission } from './draw-scoring.js';
import { drawRecapFacts } from './schema.js';

interface RecapDatabase {
  select: typeof import('./db.js').db.select;
  insert: typeof import('./db.js').db.insert;
}

interface ParticipantName {
  id: string;
  displayName: string;
  removed: boolean;
}

export interface DrawRecapProjectionInput {
  database: RecapDatabase;
  leagueId: string;
  leagueName: string;
  eventId: string;
  eventLabel: string;
  acceptedRevisionId: string;
  sourceRevisionId: string;
  acceptedAt: string;
  sourceFreshness: 'current' | 'delayed' | 'conflicting' | 'stale';
  correctionReplay: 'not_needed' | 'replayed';
  delayReason: string | null;
  currentDraw: Draw;
  submissions: ScoringSubmission[];
  participants: ParticipantName[];
}

function playerName(draw: Draw, id: string): string {
  return draw.players[id]?.name ?? 'Unavailable player';
}

function participantName(participants: Map<string, ParticipantName>, id: string): string {
  const participant = participants.get(id);
  return !participant || participant.removed ? 'Removed player' : participant.displayName;
}

export function resolveDrawRecapViewModel(
  facts: DrawRecapFacts,
  input: Omit<DrawRecapProjectionInput, 'database' | 'submissions'>,
): DrawRecapViewModel {
  const participants = new Map(input.participants.map((participant) => [participant.id, participant]));
  return {
    leagueName: input.leagueName,
    eventLabel: input.eventLabel,
    round: facts.round,
    roundLabel: facts.roundLabel,
    headline: `${facts.roundLabel} changed the clubhouse`,
    acceptedRevisionId: input.acceptedRevisionId,
    sourceRevisionId: input.sourceRevisionId,
    acceptedAt: input.acceptedAt,
    sourceFreshness: input.sourceFreshness,
    correctionReplay: input.correctionReplay,
    delayReason: input.delayReason,
    movements: facts.movements.map((movement) => ({
      ...movement,
      displayName: participantName(participants, movement.participantId),
    })),
    rarestCorrectCall: facts.rarestCorrectCall ? {
      ...facts.rarestCorrectCall,
      displayName: participantName(participants, facts.rarestCorrectCall.participantId),
      playerName: playerName(input.currentDraw, facts.rarestCorrectCall.playerId),
    } : null,
    highestImpactMiss: facts.highestImpactMiss ? {
      ...facts.highestImpactMiss,
      displayName: participantName(participants, facts.highestImpactMiss.participantId),
      playerName: playerName(input.currentDraw, facts.highestImpactMiss.playerId),
    } : null,
    survivingChampions: facts.survivingChampions.map((champion) => ({
      ...champion,
      displayName: participantName(participants, champion.participantId),
      playerName: playerName(input.currentDraw, champion.playerId),
    })),
  };
}

export async function readAndAdvanceDrawRecap(input: DrawRecapProjectionInput): Promise<DrawRecapProjection> {
  // Cheap structural check first: whether a round is complete never requires deriving full recap
  // facts (movements, rarest call, etc.), so only compute facts for rounds that actually need them.
  const completedRounds = input.currentDraw.rounds
    .map((round) => round.round)
    .filter((round) => isCompletedRound(input.currentDraw, round));
  if (!completedRounds.length) return { state: 'none' };

  const existing = await input.database.select({
    round: drawRecapFacts.round,
    facts: drawRecapFacts.facts,
  }).from(drawRecapFacts).where(and(
    eq(drawRecapFacts.leagueId, input.leagueId),
    eq(drawRecapFacts.acceptedRevisionId, input.acceptedRevisionId),
  )).orderBy(desc(drawRecapFacts.round));
  const existingByRound = new Map(existing.map((row) => [row.round, row.facts]));
  const maxCompletedRound = Math.max(...completedRounds);
  const newest = existing[0];
  if (newest && isDrawRecapFacts(newest.facts) && newest.round === maxCompletedRound) {
    return {
      state: 'current',
      acceptedRevisionId: input.acceptedRevisionId,
      viewModel: resolveDrawRecapViewModel(newest.facts, input),
    };
  }

  const missingRounds = completedRounds.filter((round) => !existingByRound.has(round));
  for (const round of missingRounds) {
    const facts = deriveDrawRecapFacts(
      afterRoundState(input.currentDraw, round),
      priorRoundState(input.currentDraw, round),
      input.submissions,
      round,
    );
    if (!facts) continue;
    await input.database.insert(drawRecapFacts).values({
      leagueId: input.leagueId,
      eventId: input.eventId,
      round,
      acceptedRevisionId: input.acceptedRevisionId,
      facts,
    }).onConflictDoNothing({
      target: [
        drawRecapFacts.leagueId,
        drawRecapFacts.round,
        drawRecapFacts.acceptedRevisionId,
      ],
    });
  }
  return { state: 'updating', acceptedRevisionId: input.acceptedRevisionId };
}
