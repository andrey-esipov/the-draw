import { and, desc, eq } from 'drizzle-orm';
import type {
  Draw,
  DrawRecapProjection,
  DrawRecapViewModel,
} from '../shared/draw/contracts.js';
import { deriveDrawRecapFacts, isDrawRecapFacts, type DrawRecapFacts } from './draw-recaps.js';
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
  previousDraw: Draw | null;
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
  input: Omit<DrawRecapProjectionInput, 'database' | 'previousDraw' | 'submissions'>,
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
  const completedRounds = input.currentDraw.rounds
    .filter((round) => deriveDrawRecapFacts(
      input.currentDraw,
      input.previousDraw,
      input.submissions,
      round.round,
    ))
    .map((round) => round.round);
  if (!completedRounds.length) return { state: 'none' };

  const existing = await input.database.select({
    round: drawRecapFacts.round,
    facts: drawRecapFacts.facts,
  }).from(drawRecapFacts).where(and(
    eq(drawRecapFacts.leagueId, input.leagueId),
    eq(drawRecapFacts.acceptedRevisionId, input.acceptedRevisionId),
  )).orderBy(desc(drawRecapFacts.round));
  const newest = existing[0];
  if (newest && isDrawRecapFacts(newest.facts) && newest.round === Math.max(...completedRounds)) {
    return {
      state: 'current',
      acceptedRevisionId: input.acceptedRevisionId,
      viewModel: resolveDrawRecapViewModel(newest.facts, input),
    };
  }

  for (const round of completedRounds) {
    const facts = deriveDrawRecapFacts(input.currentDraw, input.previousDraw, input.submissions, round);
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
