import { createHash, createHmac } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, max, sql } from 'drizzle-orm';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import { downstreamMatchIds, drawMatches } from '../shared/draw/validation.js';
import { deriveStandings, type ScoringSubmission } from './draw-scoring.js';
import { readAndAdvanceDrawRecap } from './draw-projections.js';
import { DRAW_FRESHNESS_TARGET_MS } from './draw-operations.js';
import { db } from './db.js';
import {
  DrawPersistenceValidationError,
  expectedDrawLeagueExpiry,
  validateDrawDraftForPersistence,
} from './draw-persistence.js';
import {
  drawAcceptedRevisions,
  drawActiveSubmissions,
  drawEmailOutbox,
  drawEventHeads,
  drawEventOperationsAudit,
  drawEvents,
  drawLeagues,
  drawParticipantDrafts,
  drawParticipants,
  drawSubmissions,
} from './schema.js';

export type DrawDatabase = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>;
export const DRAW_SUBMISSION_CONTRACT_VERSION = 'draw-bracket-v1';
export const DRAW_LEAGUE_PROJECTION_MAX_QUERIES = 6;

export class DrawApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'DrawApiError';
  }
}

interface Dependencies {
  database?: DrawDatabase;
  now?: () => Date;
  secret: string;
}

interface Capability {
  leagueId: string;
  participantId?: string;
  generation: number;
}

interface Canonical {
  event: typeof drawEvents.$inferSelect;
  revision: typeof drawAcceptedRevisions.$inferSelect;
  draw: Draw;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new DrawApiError('invalid_request', 422, { field });
  const normalized = value.trim().replace(/\s+/g, ' ');
  const hasControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
  });
  if (!normalized || normalized.length > maximum || hasControl) {
    throw new DrawApiError('invalid_request', 422, { field });
  }
  return normalized;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/.test(value)) {
    throw new DrawApiError('invalid_idempotency_key', 422);
  }
  return value;
}

function deterministicUuid(secret: string, purpose: string, value: string): string {
  const hex = createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function opaqueHash(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('hex');
}

function canonicalPicks(picks: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(picks).sort(([a], [b]) => a.localeCompare(b))));
}

function picksChecksum(picks: Record<string, string>): string {
  return createHash('sha256').update(canonicalPicks(picks)).digest('hex');
}

function isParticipantSeatCapacityViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, constraint, cause } = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  const namedViolation = (
    code === '23505' && constraint === 'draw_participants_league_seat_unique'
  ) || (
    code === '23514' && constraint === 'draw_participants_seat_valid'
  );
  return namedViolation || (cause !== undefined && isParticipantSeatCapacityViolation(cause));
}

function asDraw(payload: unknown): Draw {
  if (!payload || typeof payload !== 'object' || !('draw' in payload)) {
    throw new DrawApiError('source_unavailable', 503);
  }
  return (payload as AcceptedDrawRevision).draw;
}

async function canonicalForEvent(
  eventId: string,
  database: Pick<DrawDatabase, 'select'>,
): Promise<Canonical> {
  const [row] = await database.select({
    event: drawEvents,
    revision: drawAcceptedRevisions,
  }).from(drawEvents)
    .innerJoin(drawEventHeads, eq(drawEventHeads.eventId, drawEvents.id))
    .innerJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ))
    .where(eq(drawEvents.id, eventId))
    .limit(1);
  if (!row) throw new DrawApiError('source_unavailable', 503);
  return { ...row, draw: asDraw(row.revision.payload) };
}

function assertAvailable(_event: typeof drawEvents.$inferSelect, expiresAt: Date, now: Date): void {
  if (now >= expiresAt) throw new DrawApiError('not_found', 404);
}

function assertMutable(event: typeof drawEvents.$inferSelect, now: Date): void {
  if (now >= event.lockAt) throw new DrawApiError('locked', 409, { lockAt: event.lockAt.toISOString() });
}

async function consumeLimit(
  database: DrawDatabase,
  input: {
    kind: 'ip' | 'event' | 'league' | 'token' | 'email';
    hash: string;
    now: Date;
    maximum: number;
    eventId?: string;
    leagueId?: string;
  },
): Promise<void> {
  const windowStartedAt = new Date(Math.floor(input.now.getTime() / 3_600_000) * 3_600_000);
  const expiresAt = new Date(windowStartedAt.getTime() + 2 * 3_600_000);
  const windowStartedAtIso = windowStartedAt.toISOString();
  const expiresAtIso = expiresAt.toISOString();
  const nowIso = input.now.toISOString();
  const result = await database.execute(sql`
    INSERT INTO draw_abuse_limits (
      scope_kind, scope_hash, event_id, league_id, window_started_at, attempt_count, expires_at, updated_at
    ) VALUES (
      ${input.kind}, ${input.hash}, ${input.eventId ?? null}, ${input.leagueId ?? null},
      ${windowStartedAtIso}, 1, ${expiresAtIso}, ${nowIso}
    )
    ON CONFLICT (scope_kind, scope_hash, window_started_at)
    DO UPDATE SET attempt_count = draw_abuse_limits.attempt_count + 1, updated_at = ${nowIso}
    RETURNING attempt_count
  `);
  const returned = result as unknown as
    | Array<{ attempt_count: number }>
    | { rows?: Array<{ attempt_count: number }> };
  const first = Array.isArray(returned) ? returned[0] : returned.rows?.[0];
  const count = Number(first?.attempt_count ?? 0);
  if (count > input.maximum) throw new DrawApiError('throttled', 404);
}

async function leagueParticipant(
  capability: Capability & { participantId: string },
  database: Pick<DrawDatabase, 'select'>,
  now: Date,
) {
  const [row] = await database.select({
    league: drawLeagues,
    participant: drawParticipants,
    event: drawEvents,
  }).from(drawParticipants)
    .innerJoin(drawLeagues, eq(drawLeagues.id, drawParticipants.leagueId))
    .innerJoin(drawEvents, eq(drawEvents.id, drawLeagues.eventId))
    .where(and(
      eq(drawParticipants.id, capability.participantId),
      eq(drawParticipants.leagueId, capability.leagueId),
      eq(drawParticipants.returnGeneration, capability.generation),
    ))
    .limit(1);
  if (!row || row.participant.removedAt) throw new DrawApiError('not_found', 404);
  assertAvailable(row.event, row.league.expiresAt, now);
  return row;
}

async function invitationLeague(capability: Capability, database: Pick<DrawDatabase, 'select'>, now: Date) {
  const [row] = await database.select({
    league: drawLeagues,
    event: drawEvents,
  }).from(drawLeagues)
    .innerJoin(drawEvents, eq(drawEvents.id, drawLeagues.eventId))
    .where(and(
      eq(drawLeagues.id, capability.leagueId),
      eq(drawLeagues.invitationGeneration, capability.generation),
    ))
    .limit(1);
  if (!row) throw new DrawApiError('not_found', 404);
  assertAvailable(row.event, row.league.expiresAt, now);
  return row;
}

function validateBracket(draw: Draw, value: unknown, complete: boolean): Record<string, string> {
  let picks: Record<string, string>;
  try {
    picks = validateDrawDraftForPersistence(draw, value);
  } catch (error) {
    if (error instanceof DrawPersistenceValidationError) {
      throw new DrawApiError('invalid_picks', 422);
    }
    throw error;
  }
  const matches = drawMatches(draw);
  const byId = new Map(matches.map((match) => [match.id, match]));
  for (const match of matches) {
    const pick = picks[match.id];
    if (!pick) continue;
    if (match.round === 1) {
      if (!match.sides.some((side) => side.player === pick)) {
        throw new DrawApiError('invalid_picks', 422, { affectedMatchIds: [match.id] });
      }
      continue;
    }
    const left = picks[`r${match.round - 1}m${match.position * 2 + 1}`];
    const right = picks[`r${match.round - 1}m${match.position * 2 + 2}`];
    if (pick !== left && pick !== right) {
      throw new DrawApiError('invalid_picks', 422, { affectedMatchIds: [match.id] });
    }
  }
  if (complete && (Object.keys(picks).length !== 127 || matches.some((match) => !picks[match.id]))) {
    throw new DrawApiError('incomplete_bracket', 422, { pickCount: Object.keys(picks).length });
  }
  if (complete && byId.size !== 127) throw new DrawApiError('source_unavailable', 503);
  return picks;
}

function changedBranches(previous: Draw, current: Draw): string[] {
  const affected = new Set<string>();
  const priorMatches = new Map(drawMatches(previous).map((match) => [match.id, match]));
  for (const match of drawMatches(current)) {
    const prior = priorMatches.get(match.id);
    if (!prior) {
      affected.add(match.id);
      continue;
    }
    const priorSides = prior.sides.map((side) => side.player);
    const sides = match.sides.map((side) => side.player);
    if (match.round === 1 && JSON.stringify(priorSides) !== JSON.stringify(sides)) {
      downstreamMatchIds(match.round, match.position).forEach((id) => affected.add(id));
    } else if (previous.source.url === current.source.url && prior.winner !== match.winner) {
      downstreamMatchIds(match.round, match.position).forEach((id) => affected.add(id));
    }
  }
  return [...affected].sort();
}

async function revisionDraw(revisionId: string, database: Pick<DrawDatabase, 'select'>): Promise<Draw> {
  const [revision] = await database.select({ payload: drawAcceptedRevisions.payload })
    .from(drawAcceptedRevisions)
    .where(eq(drawAcceptedRevisions.id, revisionId))
    .limit(1);
  if (!revision) throw new DrawApiError('not_found', 404);
  return asDraw(revision.payload);
}

export async function createDrawLeague(
  input: {
    eventSlug: unknown;
    leagueName: unknown;
    displayName: unknown;
    idempotencyKey: unknown;
    ip: string;
  },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  const eventSlug = boundedText(input.eventSlug, 'eventSlug', 120);
  const leagueName = boundedText(input.leagueName, 'leagueName', 80);
  const displayName = boundedText(input.displayName, 'displayName', 60);
  const requestKey = idempotencyKey(input.idempotencyKey);
  const leagueId = deterministicUuid(dependencies.secret, 'league', `${eventSlug}\0${requestKey}`);
  const participantId = deterministicUuid(dependencies.secret, 'creator', leagueId);

  return database.transaction(async (tx) => {
    const [replayed] = await tx.select({
      league: drawLeagues,
      participant: drawParticipants,
      event: drawEvents,
    }).from(drawLeagues)
      .innerJoin(drawParticipants, and(
        eq(drawParticipants.leagueId, drawLeagues.id),
        eq(drawParticipants.id, participantId),
      ))
      .innerJoin(drawEvents, eq(drawEvents.id, drawLeagues.eventId))
      .where(eq(drawLeagues.id, leagueId))
      .limit(1);
    if (replayed) {
      const now = dependencies.now?.() ?? new Date();
      if (!replayed.event.creationEnabled) throw new DrawApiError('not_found', 404);
      assertAvailable(replayed.event, replayed.league.expiresAt, now);
      assertMutable(replayed.event, now);
      if (
        replayed.league.name !== leagueName
        || replayed.participant.displayName !== displayName
        || replayed.event.slug !== eventSlug
      ) throw new DrawApiError('idempotency_conflict', 409);
      return { league: replayed.league, participant: replayed.participant, event: replayed.event };
    }

    const [event] = await tx.select().from(drawEvents)
      .where(and(eq(drawEvents.slug, eventSlug), eq(drawEvents.creationEnabled, true)))
      .limit(1);
    if (!event) throw new DrawApiError('not_found', 404);
    const audit = await tx.select({
      action: drawEventOperationsAudit.action,
      createdAt: drawEventOperationsAudit.createdAt,
    })
      .from(drawEventOperationsAudit)
      .where(eq(drawEventOperationsAudit.eventId, event.id))
      .orderBy(desc(drawEventOperationsAudit.createdAt));
    const certification = audit.find((entry) => entry.action === 'certified');
    const configuration = audit.find((entry) => entry.action === 'configured');
    if (!certification || configuration && certification.createdAt < configuration.createdAt) {
      throw new DrawApiError('not_found', 404);
    }
    const now = dependencies.now?.() ?? new Date();
    assertMutable(event, now);
    await consumeLimit(tx as unknown as DrawDatabase, {
      kind: 'ip',
      hash: opaqueHash(dependencies.secret, 'rate-ip', input.ip),
      now,
      maximum: 5,
    });
    await consumeLimit(tx as unknown as DrawDatabase, {
      kind: 'event',
      hash: opaqueHash(dependencies.secret, 'rate-event', event.id),
      eventId: event.id,
      now,
      maximum: 100,
    });
    const expiresAt = expectedDrawLeagueExpiry(event.completesAt);
    const [league] = await tx.insert(drawLeagues).values({
      id: leagueId,
      eventId: event.id,
      name: leagueName,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const [participant] = await tx.insert(drawParticipants).values({
      id: participantId,
      leagueId,
      seat: 1,
      displayName,
      isCreator: true,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return { league: league!, participant: participant!, event };
  });
}

export async function readDrawEventAvailability(
  eventSlugInput: unknown,
  dependencies: Pick<Dependencies, 'database'>,
): Promise<{ state: 'awaiting' } | { state: 'ready'; draw: Draw }> {
  const database = dependencies.database ?? db;
  const eventSlug = boundedText(eventSlugInput, 'eventSlug', 120);
  const [event] = await database.select({ id: drawEvents.id }).from(drawEvents)
    .where(and(eq(drawEvents.slug, eventSlug), eq(drawEvents.creationEnabled, true)))
    .limit(1);
  if (!event) throw new DrawApiError('not_found', 404);
  try {
    const canonical = await canonicalForEvent(event.id, database);
    return { state: 'ready', draw: canonical.draw };
  } catch (error) {
    if (error instanceof DrawApiError && error.code === 'source_unavailable') {
      return { state: 'awaiting' };
    }
    throw error;
  }
}

export async function inspectDrawInvitation(capability: Capability, dependencies: Dependencies) {
  const database = dependencies.database ?? db;
  const now = dependencies.now?.() ?? new Date();
  const row = await invitationLeague(capability, database, now);
  if (now >= row.event.lockAt) throw new DrawApiError('not_found', 404);
  const participants = await database.select({ seat: drawParticipants.seat })
    .from(drawParticipants)
    .where(eq(drawParticipants.leagueId, row.league.id));
  return {
    leagueId: row.league.id,
    leagueName: row.league.name,
    event: { slug: row.event.slug, kind: row.event.eventKind },
    seatsRemaining: Math.max(0, 32 - participants.length),
    lockAt: row.event.lockAt.toISOString(),
  };
}

export async function joinDrawLeague(
  capability: Capability,
  input: { displayName: unknown; idempotencyKey: unknown; ip: string },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  const displayName = boundedText(input.displayName, 'displayName', 60);
  const requestKey = idempotencyKey(input.idempotencyKey);
  const participantId = deterministicUuid(
    dependencies.secret,
    'participant',
    `${capability.leagueId}\0${requestKey}`,
  );
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM draw_leagues WHERE id = ${capability.leagueId} FOR UPDATE`);
      const now = dependencies.now?.() ?? new Date();
      const row = await invitationLeague(capability, tx as unknown as DrawDatabase, now);
      assertMutable(row.event, now);
      const [existing] = await tx.select().from(drawParticipants)
        .where(and(
          eq(drawParticipants.id, participantId),
          eq(drawParticipants.leagueId, capability.leagueId),
        ))
        .limit(1);
      if (existing) {
        if (existing.displayName !== displayName || existing.removedAt) {
          throw new DrawApiError('idempotency_conflict', 409);
        }
        return existing;
      }
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'token',
        hash: opaqueHash(dependencies.secret, 'rate-token', `${capability.leagueId}:${capability.generation}`),
        now,
        maximum: 40,
      });
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'ip',
        hash: opaqueHash(dependencies.secret, 'rate-ip', input.ip),
        now,
        maximum: 40,
      });
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'league',
        hash: opaqueHash(dependencies.secret, 'rate-league', capability.leagueId),
        leagueId: capability.leagueId,
        now,
        maximum: 40,
      });
      const [seatRow] = await tx.select({ seat: max(drawParticipants.seat) })
        .from(drawParticipants)
        .where(eq(drawParticipants.leagueId, capability.leagueId));
      const seat = Number(seatRow?.seat ?? 0) + 1;
      if (seat > 32) throw new DrawApiError('league_full', 409);
      const [participant] = await tx.insert(drawParticipants).values({
        id: participantId,
        leagueId: capability.leagueId,
        seat,
        displayName,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return participant!;
    });
  } catch (error) {
    if (isParticipantSeatCapacityViolation(error)) throw new DrawApiError('league_full', 409);
    throw error;
  }
}

export async function readDrawDraft(
  capability: Capability & { participantId: string },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  const now = dependencies.now?.() ?? new Date();
  const owner = await leagueParticipant(capability, database, now);
  assertMutable(owner.event, now);
  const canonical = await canonicalForEvent(owner.event.id, database);
  const [draft] = await database.select().from(drawParticipantDrafts)
    .where(eq(drawParticipantDrafts.participantId, owner.participant.id))
    .limit(1);
  if (!draft) {
    return {
      version: 0,
      picks: {},
      acceptedRevisionId: canonical.revision.id,
      acceptedRevisionChecksum: canonical.revision.checksum,
      affectedMatchIds: [],
      locked: now >= owner.event.lockAt,
      draw: canonical.draw,
    };
  }
  const previous = draft.acceptedRevisionId === canonical.revision.id
    ? canonical.draw
    : await revisionDraw(draft.acceptedRevisionId, database);
  const affectedMatchIds = draft.acceptedRevisionId === canonical.revision.id
    ? draft.invalidatedMatchIds as string[]
    : changedBranches(previous, canonical.draw);
  return {
    version: draft.version,
    picks: draft.picks as Record<string, string>,
    acceptedRevisionId: canonical.revision.id,
    acceptedRevisionChecksum: canonical.revision.checksum,
    affectedMatchIds,
    locked: now >= owner.event.lockAt,
    draw: canonical.draw,
  };
}

export async function saveDrawDraft(
  capability: Capability & { participantId: string },
  input: { expectedVersion: unknown; picks: unknown },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) {
    throw new DrawApiError('invalid_request', 422, { field: 'expectedVersion' });
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM draw_participants WHERE id = ${capability.participantId} FOR UPDATE`);
    const now = dependencies.now?.() ?? new Date();
    const owner = await leagueParticipant(capability, tx as unknown as DrawDatabase, now);
    assertMutable(owner.event, now);
    const canonical = await canonicalForEvent(owner.event.id, tx as unknown as DrawDatabase);
    const picks = validateBracket(canonical.draw, input.picks, false);
    const [existing] = await tx.select().from(drawParticipantDrafts)
      .where(eq(drawParticipantDrafts.participantId, owner.participant.id))
      .limit(1);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new DrawApiError('draft_conflict', 409, {
        currentVersion,
        currentPicks: existing?.picks ?? {},
        acceptedRevisionId: canonical.revision.id,
        acceptedRevisionChecksum: canonical.revision.checksum,
      });
    }
    let affected: string[] = [];
    if (existing && existing.acceptedRevisionId !== canonical.revision.id) {
      const previous = await revisionDraw(existing.acceptedRevisionId, tx as unknown as DrawDatabase);
      affected = changedBranches(previous, canonical.draw).filter((id) => {
        const oldValue = (existing.picks as Record<string, string>)[id];
        return oldValue !== undefined && picks[id] === oldValue;
      });
    }
    const version = currentVersion + 1;
    const values = {
      participantId: owner.participant.id,
      leagueId: owner.league.id,
      eventId: owner.event.id,
      acceptedRevisionId: canonical.revision.id,
      version,
      picks,
      invalidatedMatchIds: affected,
      updatedAt: now,
    };
    if (existing) {
      await tx.update(drawParticipantDrafts).set(values)
        .where(eq(drawParticipantDrafts.participantId, owner.participant.id));
    } else {
      await tx.insert(drawParticipantDrafts).values(values);
    }
    return {
      version,
      picks,
      acceptedRevisionId: canonical.revision.id,
      acceptedRevisionChecksum: canonical.revision.checksum,
      affectedMatchIds: affected,
    };
  });
}

export async function submitDrawBracket(
  capability: Capability & { participantId: string },
  input: { expectedDraftVersion: unknown },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  if (!Number.isInteger(input.expectedDraftVersion) || Number(input.expectedDraftVersion) < 1) {
    throw new DrawApiError('invalid_request', 422, { field: 'expectedDraftVersion' });
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM draw_participants WHERE id = ${capability.participantId} FOR UPDATE`);
    const now = dependencies.now?.() ?? new Date();
    const owner = await leagueParticipant(capability, tx as unknown as DrawDatabase, now);
    assertMutable(owner.event, now);
    const canonical = await canonicalForEvent(owner.event.id, tx as unknown as DrawDatabase);
    const [draft] = await tx.select().from(drawParticipantDrafts)
      .where(eq(drawParticipantDrafts.participantId, owner.participant.id))
      .limit(1);
    if (!draft || draft.version !== input.expectedDraftVersion) {
      throw new DrawApiError('draft_conflict', 409, { currentVersion: draft?.version ?? 0 });
    }
    if (draft.acceptedRevisionId !== canonical.revision.id) {
      const previous = await revisionDraw(draft.acceptedRevisionId, tx as unknown as DrawDatabase);
      throw new DrawApiError('revision_conflict', 409, {
        affectedMatchIds: changedBranches(previous, canonical.draw),
        acceptedRevisionId: canonical.revision.id,
        acceptedRevisionChecksum: canonical.revision.checksum,
      });
    }
    const invalidated = draft.invalidatedMatchIds as string[];
    if (invalidated.length) {
      throw new DrawApiError('revision_conflict', 409, {
        affectedMatchIds: invalidated,
        acceptedRevisionId: canonical.revision.id,
        acceptedRevisionChecksum: canonical.revision.checksum,
      });
    }
    const picks = validateBracket(canonical.draw, draft.picks, true);
    const checksum = picksChecksum(picks);
    const [active] = await tx.select({
      submissionId: drawSubmissions.id,
      version: drawSubmissions.version,
      checksum: drawSubmissions.checksum,
      acceptedRevisionId: drawSubmissions.acceptedRevisionId,
    }).from(drawActiveSubmissions)
      .innerJoin(drawSubmissions, and(
        eq(drawSubmissions.id, drawActiveSubmissions.submissionId),
        eq(drawSubmissions.participantId, drawActiveSubmissions.participantId),
        eq(drawSubmissions.leagueId, drawActiveSubmissions.leagueId),
      ))
      .where(eq(drawActiveSubmissions.participantId, owner.participant.id))
      .limit(1);
    if (active?.acceptedRevisionId === canonical.revision.id && active.checksum === checksum) {
      return {
        submissionId: active.submissionId,
        version: active.version,
        checksum: active.checksum,
        active: true,
      };
    }
    await consumeLimit(tx as unknown as DrawDatabase, {
      kind: 'league',
      hash: opaqueHash(dependencies.secret, 'submission-participant', owner.participant.id),
      leagueId: owner.league.id,
      now,
      maximum: 60,
    });
    const [latest] = await tx.select({ version: max(drawSubmissions.version) })
      .from(drawSubmissions)
      .where(eq(drawSubmissions.participantId, owner.participant.id));
    const version = Number(latest?.version ?? 0) + 1;
    const [submission] = await tx.insert(drawSubmissions).values({
      participantId: owner.participant.id,
      leagueId: owner.league.id,
      eventId: owner.event.id,
      acceptedRevisionId: canonical.revision.id,
      version,
      contractVersion: DRAW_SUBMISSION_CONTRACT_VERSION,
      checksum,
      picks,
      validatedAt: now,
      createdAt: now,
    }).returning();
    await tx.insert(drawActiveSubmissions).values({
      participantId: owner.participant.id,
      leagueId: owner.league.id,
      submissionId: submission!.id,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: drawActiveSubmissions.participantId,
      set: { submissionId: submission!.id, updatedAt: now },
    });
    return {
      submissionId: submission!.id,
      version,
      checksum: submission!.checksum,
      active: true,
    };
  });
}

export async function readDrawLeague(
  capability: Capability & { participantId: string },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  const now = dependencies.now?.() ?? new Date();
  const owner = await leagueParticipant(capability, database, now);
  const revealed = now >= owner.event.lockAt;
  const participants = await database.select({
    id: drawParticipants.id,
    seat: drawParticipants.seat,
    displayName: drawParticipants.displayName,
    removedAt: drawParticipants.removedAt,
  }).from(drawParticipants)
    .where(eq(drawParticipants.leagueId, owner.league.id))
    .orderBy(asc(drawParticipants.seat));
  const base = {
    league: {
      id: owner.league.id,
      name: owner.league.name,
      eventSlug: owner.event.slug,
      eventKind: owner.event.eventKind,
      lockAt: owner.event.lockAt.toISOString(),
      revealed,
    },
    participantId: owner.participant.id,
    participantCount: participants.length,
  };
  if (!revealed) {
    const [draft] = await database.select({
      version: drawParticipantDrafts.version,
      picks: drawParticipantDrafts.picks,
    }).from(drawParticipantDrafts)
      .where(eq(drawParticipantDrafts.participantId, owner.participant.id))
      .limit(1);
    const [active] = await database.select({ id: drawActiveSubmissions.submissionId })
      .from(drawActiveSubmissions)
      .where(and(
        eq(drawActiveSubmissions.leagueId, owner.league.id),
        eq(drawActiveSubmissions.participantId, owner.participant.id),
      ))
      .limit(1);
    return {
      ...base,
      viewer: {
        draft: {
          exists: Boolean(draft),
          version: draft?.version ?? 0,
          pickCount: draft && typeof draft.picks === 'object' && draft.picks
            ? Object.keys(draft.picks).length
            : 0,
        },
        submission: { active: Boolean(active), complete: Boolean(active) },
      },
      projection: null,
    };
  }

  const canonical = await canonicalForEvent(owner.event.id, database);
  const submissions = await database.select({
    participantId: drawSubmissions.participantId,
    acceptedRevisionId: drawSubmissions.acceptedRevisionId,
    version: drawSubmissions.version,
    contractVersion: drawSubmissions.contractVersion,
    checksum: drawSubmissions.checksum,
    picks: drawSubmissions.picks,
  }).from(drawActiveSubmissions)
    .innerJoin(drawSubmissions, and(
      eq(drawSubmissions.id, drawActiveSubmissions.submissionId),
      eq(drawSubmissions.participantId, drawActiveSubmissions.participantId),
      eq(drawSubmissions.leagueId, drawActiveSubmissions.leagueId),
    ))
    .where(eq(drawActiveSubmissions.leagueId, owner.league.id));
  const revisionIds = [...new Set(submissions.map((submission) => submission.acceptedRevisionId))];
  const submissionRevisions = revisionIds.length
    ? await database.select({
      id: drawAcceptedRevisions.id,
      payload: drawAcceptedRevisions.payload,
    }).from(drawAcceptedRevisions)
      .where(and(
        eq(drawAcceptedRevisions.eventId, owner.event.id),
        inArray(drawAcceptedRevisions.id, revisionIds),
      ))
    : [];
  const drawsByRevision = new Map(submissionRevisions.map((revision) => [
    revision.id,
    asDraw(revision.payload),
  ]));
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const scoringSubmissions: ScoringSubmission[] = submissions.flatMap((submission) => {
    const participant = participantById.get(submission.participantId);
    const submittedDraw = drawsByRevision.get(submission.acceptedRevisionId);
    if (
      !participant
      || !submittedDraw
      || submission.contractVersion !== DRAW_SUBMISSION_CONTRACT_VERSION
      || !/^[a-f0-9]{64}$/.test(submission.checksum)
      || !submission.picks
      || typeof submission.picks !== 'object'
      || Array.isArray(submission.picks)
      || picksChecksum(submission.picks as Record<string, string>) !== submission.checksum
    ) return [];
    return [{
      participantId: submission.participantId,
      seat: participant.seat,
      displayName: participant.removedAt ? 'Removed player' : participant.displayName,
      removed: Boolean(participant.removedAt),
      version: submission.version,
      checksum: submission.checksum,
      picks: submission.picks,
      submittedDraw,
    }];
  });
  const currentStandings = deriveStandings(canonical.draw, scoringSubmissions);
  const [previousRevision] = await database.select({
    payload: drawAcceptedRevisions.payload,
  }).from(drawAcceptedRevisions)
    .where(and(
      eq(drawAcceptedRevisions.eventId, owner.event.id),
      lt(drawAcceptedRevisions.acceptedAt, canonical.revision.acceptedAt),
    ))
    .orderBy(desc(drawAcceptedRevisions.acceptedAt))
    .limit(1);
  const previousRanks = previousRevision
    ? new Map(deriveStandings(asDraw(previousRevision.payload), scoringSubmissions)
      .map((standing) => [standing.participantId, standing.rank]))
    : null;
  const standings = currentStandings.map((standing) => ({
    ...standing,
    movement: previousRanks?.has(standing.participantId)
      ? previousRanks.get(standing.participantId)! - standing.rank
      : null,
  }));
  const freshnessState = owner.event.delayCode === 'reconciliation_conflict'
    ? 'conflicting' as const
    : owner.event.delayCode || owner.event.failureCode || owner.event.projectionFailureCode
      ? 'delayed' as const
      : owner.event.lastSuccessfulAt
        && now.getTime() - owner.event.lastSuccessfulAt.getTime() > DRAW_FRESHNESS_TARGET_MS
        ? 'stale' as const
      : 'current' as const;
  const delayReason = owner.event.delayCode ?? owner.event.failureCode ?? owner.event.projectionFailureCode ?? null;
  const correctionReplay = Array.isArray(canonical.revision.explicitCorrections)
    && canonical.revision.explicitCorrections.length > 0 ? 'replayed' as const : 'not_needed' as const;
  const recap = await readAndAdvanceDrawRecap({
    database,
    leagueId: owner.league.id,
    leagueName: owner.league.name,
    eventId: owner.event.id,
    eventLabel: `${owner.event.tournament} ${owner.event.tournamentYear} · ${owner.event.eventKind === 'mens_singles' ? "Men's singles" : "Women's singles"}`,
    acceptedRevisionId: canonical.revision.id,
    sourceRevisionId: canonical.revision.sourceRevisionId,
    acceptedAt: canonical.revision.acceptedAt.toISOString(),
    sourceFreshness: freshnessState,
    correctionReplay,
    delayReason,
    currentDraw: canonical.draw,
    previousDraw: previousRevision ? asDraw(previousRevision.payload) : null,
    submissions: scoringSubmissions,
    participants: participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      removed: Boolean(participant.removedAt),
    })),
  }).catch(() => ({
    state: 'updating' as const,
    acceptedRevisionId: canonical.revision.id,
  }));
  const scoredIds = new Set(standings.map((standing) => standing.participantId));
  return {
    ...base,
    viewer: {
      draft: { exists: false, version: 0, pickCount: 0 },
      submission: {
        active: scoredIds.has(owner.participant.id),
        complete: scoredIds.has(owner.participant.id),
      },
    },
    projection: {
      canonical: {
        revisionId: canonical.revision.id,
        sourceRevisionId: canonical.revision.sourceRevisionId,
        checksum: canonical.revision.checksum,
        fetchedAt: canonical.revision.fetchedAt.toISOString(),
        acceptedAt: canonical.revision.acceptedAt.toISOString(),
        sourceUrl: owner.event.sourcePage,
        corrected: Array.isArray(canonical.revision.explicitCorrections)
          && canonical.revision.explicitCorrections.length > 0,
        freshness: {
          state: freshnessState,
          lastAttemptAt: owner.event.lastAttemptAt?.toISOString() ?? null,
          lastSuccessfulAt: owner.event.lastSuccessfulAt?.toISOString() ?? null,
          delayReason,
        },
      },
      movementAvailable: previousRanks !== null,
      standings,
      participants: participants.map((participant) => ({
        id: participant.id,
        seat: participant.seat,
        displayName: participant.removedAt ? 'Removed player' : participant.displayName,
        removed: Boolean(participant.removedAt),
        submitted: scoredIds.has(participant.id),
      })),
      recap,
    },
  };
}

export async function removeDrawParticipant(
  capability: Capability & { participantId: string },
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db;
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM draw_participants WHERE id = ${capability.participantId} FOR UPDATE`);
    const now = dependencies.now?.() ?? new Date();
    const owner = await leagueParticipant(capability, tx as unknown as DrawDatabase, now);
    const nextGeneration = owner.participant.returnGeneration + 1;
    await tx.update(drawParticipants).set({
      displayName: 'Removed player',
      removedAt: now,
      returnGeneration: nextGeneration,
      updatedAt: now,
    }).where(eq(drawParticipants.id, owner.participant.id));
    const tombstoneHash = opaqueHash(dependencies.secret, 'removed-email', owner.participant.id);
    await tx.update(drawEmailOutbox).set({
      participantId: null,
      recipientEmail: null,
      recipientHash: tombstoneHash,
      status: 'failed',
      lastErrorCode: 'participant_removed',
      updatedAt: now,
    }).where(and(
      eq(drawEmailOutbox.participantId, owner.participant.id),
      inArray(drawEmailOutbox.status, ['pending', 'sending']),
    ));
    await tx.update(drawEmailOutbox).set({
      participantId: null,
      recipientEmail: null,
      recipientHash: tombstoneHash,
      updatedAt: now,
    }).where(and(
      eq(drawEmailOutbox.participantId, owner.participant.id),
      inArray(drawEmailOutbox.status, ['sent', 'failed']),
    ));
    return { removed: true, seat: owner.participant.seat };
  });
}

export async function queueDrawReturnEmail(
  capability: Capability & { participantId: string },
  input: { email: unknown; confirmed: unknown; ip: string; enabled: boolean },
  dependencies: Dependencies,
) {
  if (!input.enabled) return { state: 'unavailable' as const };
  if (input.confirmed !== true) return { state: 'unconfirmed' as const };
  const email = boundedText(input.email, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DrawApiError('invalid_request', 422, { field: 'email' });
  const database = dependencies.database ?? db;
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM draw_participants WHERE id = ${capability.participantId} FOR UPDATE`);
      const now = dependencies.now?.() ?? new Date();
      const owner = await leagueParticipant(capability, tx as unknown as DrawDatabase, now);
      const recipientHash = opaqueHash(dependencies.secret, 'email-address', email);
      await tx.execute(sql`
        SELECT id FROM draw_email_outbox
        WHERE participant_id = ${owner.participant.id}
          AND recipient_hash = ${recipientHash}
        FOR UPDATE
      `);
      const [existing] = await tx.select({
        id: drawEmailOutbox.id,
        status: drawEmailOutbox.status,
      })
        .from(drawEmailOutbox)
        .where(and(
          eq(drawEmailOutbox.participantId, owner.participant.id),
          eq(drawEmailOutbox.recipientHash, recipientHash),
        ))
        .orderBy(asc(drawEmailOutbox.createdAt))
        .limit(1);
      if (existing && existing.status !== 'failed') {
        return { state: 'queued' as const };
      }
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'token',
        hash: opaqueHash(dependencies.secret, 'email-participant', owner.participant.id),
        now,
        maximum: 3,
      });
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'email',
        hash: recipientHash,
        now,
        maximum: 5,
      });
      await consumeLimit(tx as unknown as DrawDatabase, {
        kind: 'ip',
        hash: opaqueHash(dependencies.secret, 'rate-ip', input.ip),
        now,
        maximum: 10,
      });
      if (existing) {
        await tx.update(drawEmailOutbox).set({
          recipientEmail: email,
          status: 'pending',
          attempts: 0,
          availableAt: now,
          claimedAt: null,
          sentAt: null,
          lastErrorCode: null,
          updatedAt: now,
        }).where(and(
          eq(drawEmailOutbox.id, existing.id),
          eq(drawEmailOutbox.status, 'failed'),
        ));
        return { state: 'queued' as const };
      }
      await tx.insert(drawEmailOutbox).values({
        leagueId: owner.league.id,
        participantId: owner.participant.id,
        kind: 'return_link',
        recipientEmail: email,
        recipientHash,
        status: 'pending',
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [drawEmailOutbox.participantId, drawEmailOutbox.recipientHash],
      });
      return { state: 'queued' as const };
    });
  } catch (error) {
    if (error instanceof DrawApiError && error.code === 'throttled') return { state: 'throttled' as const };
    throw error;
  }
}
