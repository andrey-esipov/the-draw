import { and, eq } from 'drizzle-orm';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import { db } from './db.js';
import { newestCompletedDrawRound } from './draw-recaps.js';
import {
  drawAcceptedRevisions,
  drawActiveSubmissions,
  drawEngagementEvents,
  drawEventHeads,
  drawLeagues,
  drawParticipants,
  drawRecapFacts,
} from './schema.js';

type DrawAnalyticsDatabase = Pick<typeof db, 'select' | 'insert'>;
export type DrawEngagementKind = 'submission' | 'qualifying_return' | 'recap_view' | 'recap_export';

export interface DrawEngagementInput {
  database?: DrawAnalyticsDatabase;
  leagueId: string;
  participantId: string;
  kind: DrawEngagementKind;
  round: number;
  now?: Date;
}

function acceptedDraw(payload: unknown): Draw | null {
  if (!payload || typeof payload !== 'object' || !('draw' in payload)) return null;
  return (payload as AcceptedDrawRevision).draw;
}

async function qualifyingRound(
  database: DrawAnalyticsDatabase,
  input: Pick<DrawEngagementInput, 'leagueId' | 'participantId'>,
  now: Date,
): Promise<number | null> {
  const [eligible] = await database.select({
    expiresAt: drawLeagues.expiresAt,
    removedAt: drawParticipants.removedAt,
    payload: drawAcceptedRevisions.payload,
  }).from(drawParticipants)
    .innerJoin(drawLeagues, eq(drawLeagues.id, drawParticipants.leagueId))
    .innerJoin(drawActiveSubmissions, and(
      eq(drawActiveSubmissions.participantId, drawParticipants.id),
      eq(drawActiveSubmissions.leagueId, drawLeagues.id),
    ))
    .innerJoin(drawEventHeads, eq(drawEventHeads.eventId, drawLeagues.eventId))
    .innerJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ))
    .where(and(
      eq(drawParticipants.id, input.participantId),
      eq(drawParticipants.leagueId, input.leagueId),
    ))
    .limit(1);
  const draw = eligible ? acceptedDraw(eligible.payload) : null;
  const round = draw ? newestCompletedDrawRound(draw) : null;
  if (!eligible || eligible.removedAt || now >= eligible.expiresAt || !draw) {
    throw new Error('engagement_not_eligible');
  }
  return round !== null && round >= 3 ? round : null;
}

export async function recordDrawQualifyingReturn(
  input: Omit<DrawEngagementInput, 'kind' | 'round'>,
): Promise<boolean> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const round = await qualifyingRound(database, input, now);
  if (round === null) return false;
  const inserted = await database.insert(drawEngagementEvents).values({
    leagueId: input.leagueId,
    participantId: input.participantId,
    kind: 'qualifying_return',
    round,
    firstAt: now,
  }).onConflictDoNothing({
    target: [
      drawEngagementEvents.participantId,
      drawEngagementEvents.kind,
      drawEngagementEvents.round,
    ],
  }).returning({ id: drawEngagementEvents.id });
  return inserted.length === 1;
}

export async function recordDrawEngagement(input: DrawEngagementInput): Promise<boolean> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const validRound = input.kind === 'submission'
    ? input.round === 0
    : Number.isInteger(input.round) && input.round >= 1 && input.round <= 7;
  if (!validRound) throw new Error('engagement_not_eligible');
  if (input.kind === 'qualifying_return') {
    const round = await qualifyingRound(database, input, now);
    if (round === null || round !== input.round) throw new Error('engagement_not_eligible');
  }

  const [owner] = await database.select({
    expiresAt: drawLeagues.expiresAt,
    removedAt: drawParticipants.removedAt,
  }).from(drawParticipants)
    .innerJoin(drawLeagues, eq(drawLeagues.id, drawParticipants.leagueId))
    .where(and(
      eq(drawParticipants.id, input.participantId),
      eq(drawParticipants.leagueId, input.leagueId),
    ))
    .limit(1);
  if (!owner || owner.removedAt || now >= owner.expiresAt) throw new Error('engagement_not_eligible');

  if (input.kind === 'submission' || input.kind === 'qualifying_return') {
    const [active] = await database.select({ participantId: drawActiveSubmissions.participantId })
      .from(drawActiveSubmissions)
      .where(and(
        eq(drawActiveSubmissions.participantId, input.participantId),
        eq(drawActiveSubmissions.leagueId, input.leagueId),
      ))
      .limit(1);
    if (!active) throw new Error('engagement_not_eligible');
  }

  if (input.kind !== 'submission' && input.kind !== 'qualifying_return') {
    const [currentRecap] = await database.select({ id: drawRecapFacts.id })
      .from(drawRecapFacts)
      .innerJoin(drawLeagues, eq(drawLeagues.id, drawRecapFacts.leagueId))
      .innerJoin(drawEventHeads, and(
        eq(drawEventHeads.eventId, drawRecapFacts.eventId),
        eq(drawEventHeads.acceptedRevisionId, drawRecapFacts.acceptedRevisionId),
      ))
      .where(and(
        eq(drawRecapFacts.leagueId, input.leagueId),
        eq(drawRecapFacts.round, input.round),
      ))
      .limit(1);
    if (!currentRecap) throw new Error('engagement_not_eligible');
  }

  const inserted = await database.insert(drawEngagementEvents).values({
    leagueId: input.leagueId,
    participantId: input.participantId,
    kind: input.kind,
    round: input.round,
    firstAt: now,
  }).onConflictDoNothing({
    target: [
      drawEngagementEvents.participantId,
      drawEngagementEvents.kind,
      drawEngagementEvents.round,
    ],
  }).returning({ id: drawEngagementEvents.id });
  return inserted.length === 1;
}

export function drawAnalyticsFailure(kind: DrawEngagementKind): void {
  console.error(`[draw-analytics] write_failed kind=${kind} reason=analytics_write_failed`);
}
