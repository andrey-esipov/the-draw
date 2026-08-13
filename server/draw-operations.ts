import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  DRAW_SOURCE_USER_AGENT,
  DRAW_SOURCE_WORKER_ENABLED,
  DRAW_LEAGUE_MUTATIONS_ENABLED,
} from './env.js';
import { DRAW_PARSER_VERSION, drawEventSourceIdentityConfigured } from './draw-source.js';
import {
  drawAcceptedRevisions,
  drawEventHeads,
  drawEventOperationsAudit,
  drawEvents,
} from './schema.js';

type DrawDatabase = typeof db;
export const DRAW_FRESHNESS_TARGET_MS = 15 * 60_000;

export interface DrawEventConfiguration {
  slug: string;
  drawId: string;
  tournament: string;
  tournamentYear: number;
  eventKind: 'mens_singles' | 'womens_singles';
  surface: 'Hard' | 'Clay' | 'Grass';
  venue: string;
  city: string;
  sourcePage: string;
  lockAt: Date;
  completesAt: Date;
}

interface OperatorContext {
  database?: DrawDatabase;
  actor: string;
  reason: string;
}

function operatorText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} is required and must be at most ${maximum} characters`);
  }
  return normalized;
}

function validatedSourcePage(value: string): string {
  const source = new URL(value);
  if (
    source.protocol !== 'https:'
    || source.hostname !== 'en.wikipedia.org'
    || source.username
    || source.password
    || !source.pathname.startsWith('/wiki/')
    || source.search
    || source.hash
  ) {
    throw new Error('sourcePage must be an allowlisted HTTPS en.wikipedia.org article');
  }
  return source.toString();
}

function auditedConfiguration(event: typeof drawEvents.$inferSelect) {
  return {
    slug: event.slug,
    drawId: event.drawId,
    tournament: event.tournament,
    tournamentYear: event.tournamentYear,
    eventKind: event.eventKind,
    surface: event.surface,
    venue: event.venue,
    city: event.city,
    lockAt: event.lockAt.toISOString(),
    completesAt: event.completesAt.toISOString(),
    pollingEnabled: event.pollingEnabled,
    creationEnabled: event.creationEnabled,
  };
}

export async function configureDrawEvent(
  input: DrawEventConfiguration,
  context: OperatorContext,
) {
  const database = context.database ?? db;
  const actor = operatorText(context.actor, 'actor', 200);
  const reason = operatorText(context.reason, 'reason', 500);
  const sourcePage = validatedSourcePage(input.sourcePage);
  if (!Number.isInteger(input.tournamentYear) || input.tournamentYear < 2000 || input.tournamentYear > 2200) {
    throw new Error('tournamentYear is invalid');
  }
  if (!['Hard', 'Clay', 'Grass'].includes(input.surface)) throw new Error('surface is invalid');
  if (input.completesAt <= input.lockAt) throw new Error('completesAt must be after lockAt');

  return database.transaction(async (tx) => {
    const [existing] = await tx.select().from(drawEvents).where(eq(drawEvents.slug, input.slug)).limit(1);
    const [event] = existing
      ? await tx.update(drawEvents).set({
        drawId: input.drawId,
        tournament: input.tournament,
        tournamentYear: input.tournamentYear,
        eventKind: input.eventKind,
        surface: input.surface,
        venue: operatorText(input.venue, 'venue', 200),
        city: operatorText(input.city, 'city', 200),
        sourcePage,
        lockAt: input.lockAt,
        completesAt: input.completesAt,
        pollingEnabled: false,
        creationEnabled: false,
        updatedAt: new Date(),
      }).where(eq(drawEvents.id, existing.id)).returning()
      : await tx.insert(drawEvents).values({
        ...input,
        venue: operatorText(input.venue, 'venue', 200),
        city: operatorText(input.city, 'city', 200),
        sourcePage,
        pollingEnabled: false,
        creationEnabled: false,
      }).returning();
    await tx.insert(drawEventOperationsAudit).values({
      eventId: event.id,
      action: 'configured',
      actor,
      reason,
      configuration: auditedConfiguration(event),
    });
    return event;
  });
}

export async function certifyDrawEvent(
  slug: string,
  context: OperatorContext & { pollingEnabled: boolean },
) {
  const database = context.database ?? db;
  const actor = operatorText(context.actor, 'actor', 200);
  const reason = operatorText(context.reason, 'reason', 500);
  return database.transaction(async (tx) => {
    const [configured] = await tx.select({
      surface: drawEvents.surface,
      venue: drawEvents.venue,
      city: drawEvents.city,
    }).from(drawEvents).where(eq(drawEvents.slug, slug)).limit(1);
    if (!configured) throw new Error('draw event not found');
    if (!drawEventSourceIdentityConfigured(configured)) {
      throw new Error('draw event source identity must be configured before certification');
    }
    const [event] = await tx.update(drawEvents).set({
      pollingEnabled: context.pollingEnabled,
      updatedAt: new Date(),
    }).where(eq(drawEvents.slug, slug)).returning();
    if (!event) throw new Error('draw event not found');
    await tx.insert(drawEventOperationsAudit).values({
      eventId: event.id,
      action: 'certified',
      actor,
      reason,
      configuration: auditedConfiguration(event),
    });
    return event;
  });
}

export async function setDrawEventFlags(
  slug: string,
  flags: { pollingEnabled?: boolean; creationEnabled?: boolean },
  context: OperatorContext,
) {
  if (flags.pollingEnabled === undefined && flags.creationEnabled === undefined) {
    throw new Error('at least one launch flag is required');
  }
  const database = context.database ?? db;
  const actor = operatorText(context.actor, 'actor', 200);
  const reason = operatorText(context.reason, 'reason', 500);
  return database.transaction(async (tx) => {
    if (flags.pollingEnabled === true || flags.creationEnabled === true) {
      const [configured] = await tx.select({
        surface: drawEvents.surface,
        venue: drawEvents.venue,
        city: drawEvents.city,
      }).from(drawEvents).where(eq(drawEvents.slug, slug)).limit(1);
      if (!configured) throw new Error('draw event not found');
      if (!drawEventSourceIdentityConfigured(configured)) {
        throw new Error('draw event source identity must be configured before enabling flags');
      }
    }
    const [event] = await tx.update(drawEvents).set({
      ...flags,
      updatedAt: new Date(),
    }).where(eq(drawEvents.slug, slug)).returning();
    if (!event) throw new Error('draw event not found');
    await tx.insert(drawEventOperationsAudit).values({
      eventId: event.id,
      action: 'flags_changed',
      actor,
      reason,
      configuration: auditedConfiguration(event),
    });
    return event;
  });
}

export async function inspectDrawEvent(slug: string, database: DrawDatabase = db) {
  const [event] = await database.select().from(drawEvents).where(eq(drawEvents.slug, slug)).limit(1);
  if (!event) throw new Error('draw event not found');
  const audit = await database.select().from(drawEventOperationsAudit)
    .where(eq(drawEventOperationsAudit.eventId, event.id))
    .orderBy(desc(drawEventOperationsAudit.createdAt));
  const [certification] = audit.filter((entry) => entry.action === 'certified');
  const [head] = await database.select({
    id: drawAcceptedRevisions.id,
    sourceRevisionId: drawAcceptedRevisions.sourceRevisionId,
    checksum: drawAcceptedRevisions.checksum,
    fetchedAt: drawAcceptedRevisions.fetchedAt,
    acceptedAt: drawAcceptedRevisions.acceptedAt,
  }).from(drawEventHeads)
    .innerJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ))
    .where(eq(drawEventHeads.eventId, event.id))
    .limit(1);
  return {
    event: {
      ...event,
      failureCode: event.failureCode ? operatorDiagnostic(event.failureCode) : null,
      projectionFailureCode: event.projectionFailureCode
        ? operatorDiagnostic(event.projectionFailureCode)
        : null,
    },
    canonicalAcceptedRevision: head ?? null,
    certification: certification ? {
      actor: certification.actor,
      reason: certification.reason,
      at: certification.createdAt,
    } : null,
    audit,
  };
}

export type DrawSourceHealthState =
  | 'never_fetched'
  | 'current'
  | 'delayed'
  | 'conflicting'
  | 'stale';

const PUBLIC_DELAY_CODES = new Set([
  'acceptance_failed',
  'event_missing',
  'reconciliation_conflict',
  'reconciliation_incomplete',
  'source_compressed_size',
  'source_content_type',
  'source_encoding',
  'source_expanded_size',
  'source_failure',
  'source_http_error',
  'source_identity_conflict',
  'source_identity_unconfigured',
  'source_malformed',
  'source_maxlag',
  'source_network_rejected',
  'source_page_rejected',
  'source_parse_rejected',
  'source_parser_work',
  'source_rate_limited',
  'source_redirect_limit',
  'source_redirect_rejected',
  'source_timeout',
]);

function publicDelayCode(value: string | null): string | null {
  if (!value) return null;
  return PUBLIC_DELAY_CODES.has(value) ? value : 'source_failure';
}

export async function drawSourceHealth(
  database: DrawDatabase = db,
  now = new Date(),
) {
  const rows = await database.select({
    event: drawEvents,
    sourceRevisionId: drawAcceptedRevisions.sourceRevisionId,
    checksum: drawAcceptedRevisions.checksum,
    parserVersion: drawAcceptedRevisions.parserVersion,
    acceptedAt: drawAcceptedRevisions.acceptedAt,
  }).from(drawEvents)
    .leftJoin(drawEventHeads, eq(drawEventHeads.eventId, drawEvents.id))
    .leftJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ));

  return {
    contractVersion: 2,
    workerEnabled: DRAW_SOURCE_WORKER_ENABLED,
    mutationEnabled: DRAW_LEAGUE_MUTATIONS_ENABLED,
    // Brand-agnostic check: a MediaWiki-etiquette user agent needs a
    // "name/version" token and a parenthesized contact/URL, not any specific
    // product name.
    identifyingUserAgentConfigured: /\S+\/\S+/.test(DRAW_SOURCE_USER_AGENT)
      && DRAW_SOURCE_USER_AGENT.includes('('),
    events: rows.map(({ event, sourceRevisionId, checksum, acceptedAt }) => {
      const freshnessAgeMs = event.lastSuccessfulAt
        ? Math.max(0, now.getTime() - event.lastSuccessfulAt.getTime())
        : null;
      let state: DrawSourceHealthState;
      if (event.delayCode === 'reconciliation_conflict') state = 'conflicting';
      else if (event.delayCode) state = 'delayed';
      else if (!event.lastSuccessfulAt) state = 'never_fetched';
      else if (freshnessAgeMs !== null && freshnessAgeMs > DRAW_FRESHNESS_TARGET_MS) state = 'stale';
      else state = 'current';
      // Once an event's lifecycle has completed (now > completesAt) and stopped being
      // actively polled, its freshness/staleness is historical, not a live-production
      // concern — a finished tournament must not keep failing readiness forever. An event
      // that completed without ever acquiring canonical history is still a real problem,
      // so it stays readiness-relevant regardless of lifecycle state.
      const hasCanonicalAcceptedRevision = Boolean(sourceRevisionId);
      const pollingActive = event.pollingEnabled && now <= event.completesAt;
      const readinessRelevant = pollingActive || !hasCanonicalAcceptedRevision;
      return {
        id: event.id,
        slug: event.slug,
        state,
        pollingEnabled: event.pollingEnabled,
        pollingActive,
        readinessRelevant,
        creationEnabled: event.creationEnabled,
        lastAttemptAt: event.lastAttemptAt?.toISOString() ?? null,
        lastSuccessfulAt: event.lastSuccessfulAt?.toISOString() ?? null,
        sourceFreshnessAgeMs: freshnessAgeMs,
        delayCode: publicDelayCode(event.delayCode),
        projectionLag: Boolean(event.projectionFailureCode),
        hasCanonicalAcceptedRevision,
        canonicalSourceRevisionId: sourceRevisionId ?? null,
        canonicalChecksum: checksum ?? null,
        canonicalAcceptedAt: sourceRevisionId
          ? acceptedAt?.toISOString() ?? null
          : null,
        canonicalAcceptedAgeMs: sourceRevisionId && acceptedAt
          ? Math.max(0, now.getTime() - acceptedAt.getTime())
          : null,
      };
    }),
  };
}

export async function drawSourceOperatorStatus(
  database: DrawDatabase = db,
  now = new Date(),
) {
  const rows = await database.select({
    event: drawEvents,
    sourceRevisionId: drawAcceptedRevisions.sourceRevisionId,
    acceptedAt: drawAcceptedRevisions.acceptedAt,
    parserVersion: drawAcceptedRevisions.parserVersion,
  }).from(drawEvents)
    .leftJoin(drawEventHeads, eq(drawEventHeads.eventId, drawEvents.id))
    .leftJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ));
  const publicHealth = await drawSourceHealth(database, now);
  return {
    ...publicHealth,
    parserVersion: DRAW_PARSER_VERSION,
    events: rows.map(({ event, sourceRevisionId, acceptedAt, parserVersion }) => {
      const summary = publicHealth.events.find((candidate) => candidate.id === event.id);
      return {
        ...summary,
        sourcePage: event.sourcePage,
        failureDetail: event.failureCode ? operatorDiagnostic(event.failureCode) : null,
        projectionFailureDetail: event.projectionFailureCode
          ? operatorDiagnostic(event.projectionFailureCode)
          : null,
        canonicalAcceptedRevision: sourceRevisionId ? {
          sourceRevisionId,
          acceptedAt: acceptedAt?.toISOString() ?? null,
          acceptedAgeMs: acceptedAt ? Math.max(0, now.getTime() - acceptedAt.getTime()) : null,
          parserVersion,
        } : null,
      };
    }),
  };
}

function operatorDiagnostic(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export async function recordDrawSourceStatusAudit(
  slug: string,
  context: OperatorContext,
) {
  const database = context.database ?? db;
  const actor = operatorText(context.actor, 'actor', 200);
  const reason = operatorText(context.reason, 'reason', 500);
  const [event] = await database.select().from(drawEvents).where(eq(drawEvents.slug, slug)).limit(1);
  if (!event) throw new Error('draw event not found');
  await database.insert(drawEventOperationsAudit).values({
    eventId: event.id,
    action: 'source_status',
    actor,
    reason,
    configuration: auditedConfiguration(event),
  });
  return drawSourceHealth(database);
}

export async function countDrawProjectionLag(database: DrawDatabase = db): Promise<number> {
  const [row] = await database.select({ count: sql<number>`count(*)::int` })
    .from(drawEvents)
    .where(sql`${drawEvents.projectionFailureCode} is not null`);
  return row?.count ?? 0;
}

function operationRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as T[];
  }
  throw new Error('draw invariant query returned an unsupported result');
}

export async function drawDeploymentInvariants(database: DrawDatabase = db) {
  const result = await database.execute(sql`
    SELECT
      (SELECT count(*)::int FROM draw_events) AS "drawEvents",
      (SELECT count(*)::int FROM draw_leagues) AS "drawLeagues",
      (SELECT count(*)::int FROM draw_participants) AS "drawParticipants",
      (SELECT count(*)::int FROM draw_event_heads h
        LEFT JOIN draw_accepted_revisions r
          ON r.id = h.accepted_revision_id AND r.event_id = h.event_id
        WHERE r.id IS NULL OR r.accepted_at <> h.revision_accepted_at) AS "invalidHeads",
      (SELECT count(*)::int FROM draw_participants WHERE seat NOT BETWEEN 1 AND 32) AS "invalidSeats",
      (SELECT count(*)::int FROM (
        SELECT league_id, seat FROM draw_participants GROUP BY league_id, seat HAVING count(*) > 1
      ) duplicate_seats) AS "duplicateSeats",
      (SELECT count(*)::int FROM (
        SELECT participant_id, version FROM draw_submissions
        GROUP BY participant_id, version HAVING count(*) > 1
      ) duplicate_submissions) AS "duplicateSubmissionVersions",
      (SELECT count(*)::int FROM draw_active_submissions a
        LEFT JOIN draw_submissions s
          ON s.id = a.submission_id
          AND s.participant_id = a.participant_id
          AND s.league_id = a.league_id
        WHERE s.id IS NULL) AS "invalidActiveSubmissions",
      (SELECT count(*)::int FROM draw_participants p
        LEFT JOIN draw_leagues l ON l.id = p.league_id WHERE l.id IS NULL)
        + (SELECT count(*)::int FROM draw_participant_drafts d
          LEFT JOIN draw_leagues l ON l.id = d.league_id WHERE l.id IS NULL)
        + (SELECT count(*)::int FROM draw_submissions s
          LEFT JOIN draw_leagues l ON l.id = s.league_id WHERE l.id IS NULL)
        + (SELECT count(*)::int FROM draw_recap_facts r
          LEFT JOIN draw_leagues l ON l.id = r.league_id WHERE l.id IS NULL)
        + (SELECT count(*)::int FROM draw_email_outbox e
          LEFT JOIN draw_leagues l ON l.id = e.league_id WHERE l.id IS NULL)
        + (SELECT count(*)::int FROM draw_engagement_events e
          LEFT JOIN draw_leagues l ON l.id = e.league_id WHERE l.id IS NULL)
        AS "orphans",
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name LIKE 'draw_%'
          AND (column_name ILIKE '%token%' OR column_name ILIKE '%capability%')) AS "rawCapabilityColumns",
      (SELECT count(*)::int FROM pg_constraint WHERE conname IN (
        'draw_event_heads_accepted_revision_ownership_fk',
        'draw_participants_league_seat_unique',
        'draw_submissions_participant_version_unique',
        'draw_active_submissions_submission_ownership_fk',
        'draw_email_outbox_participant_recipient_unique',
        'draw_engagement_events_metric_unique'
      )) AS "requiredConstraints",
      (SELECT count(*)::int FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN (
          'draw_accepted_revisions_append_only',
          'draw_submissions_append_only',
          'draw_recap_facts_append_only'
        )) AS "requiredTriggers"
  `);
  const row = operationRows<{
    drawEvents: number;
    drawLeagues: number;
    drawParticipants: number;
    invalidHeads: number;
    invalidSeats: number;
    duplicateSeats: number;
    duplicateSubmissionVersions: number;
    invalidActiveSubmissions: number;
    orphans: number;
    rawCapabilityColumns: number;
    requiredConstraints: number;
    requiredTriggers: number;
  }>(result)[0];
  if (!row) throw new Error('draw invariant query returned no row');
  const violations = {
    invalidHeads: Number(row.invalidHeads),
    invalidSeats: Number(row.invalidSeats),
    duplicateSeats: Number(row.duplicateSeats),
    duplicateSubmissionVersions: Number(row.duplicateSubmissionVersions),
    invalidActiveSubmissions: Number(row.invalidActiveSubmissions),
    orphans: Number(row.orphans),
    rawCapabilityColumns: Number(row.rawCapabilityColumns),
    missingRequiredConstraints: Math.max(0, 6 - Number(row.requiredConstraints)),
    missingRequiredTriggers: Math.max(0, 3 - Number(row.requiredTriggers)),
  };
  return {
    contractVersion: 1,
    coreCounts: {
      drawEvents: Number(row.drawEvents),
      drawLeagues: Number(row.drawLeagues),
      drawParticipants: Number(row.drawParticipants),
    },
    violations,
    ok: Object.values(violations).every((value) => value === 0),
  };
}
