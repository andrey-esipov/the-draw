// Relational graph for The Draw's standalone Postgres persistence. Standard Postgres
// only — no Neon/Replit-proprietary extensions, so pg_dump/pg_restore works against
// any Postgres at any time. Every table here is one of the 13 draw_* tables owning
// private-league invitations, participant capabilities, drafts, submissions, recap
// facts, email delivery, engagement metrics, and abuse limits. This schema is the
// full and only schema for this application — there is no accounts/clips/billing
// surface here; The Draw never depends on a Rallo account.
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, index, unique, foreignKey, check } from 'drizzle-orm/pg-core';

export const drawEvents = pgTable('draw_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  drawId: text('draw_id').notNull(),
  tournament: text('tournament').notNull(),
  tournamentYear: integer('tournament_year').notNull(),
  eventKind: text('event_kind').notNull(),
  surface: text('surface').notNull(),
  venue: text('venue').notNull(),
  city: text('city').notNull(),
  sourcePage: text('source_page').notNull(),
  lockAt: timestamp('lock_at', { withTimezone: true }).notNull(),
  completesAt: timestamp('completes_at', { withTimezone: true }).notNull(),
  pollingEnabled: boolean('polling_enabled').notNull().default(false),
  creationEnabled: boolean('creation_enabled').notNull().default(false),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  lastSuccessfulAt: timestamp('last_successful_at', { withTimezone: true }),
  delayCode: text('delay_code'),
  failureCode: text('failure_code'),
  projectionFailureCode: text('projection_failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUnique: unique('draw_events_slug_unique').on(t.slug),
  drawIdUnique: unique('draw_events_draw_id_unique').on(t.drawId),
  sourcePageUnique: unique('draw_events_source_page_unique').on(t.sourcePage),
  activePollingIdx: index('draw_events_active_polling_idx').on(t.pollingEnabled, t.lastAttemptAt),
  cleanupIdx: index('draw_events_cleanup_idx').on(t.completesAt),
  eventKindValid: check(
    'draw_events_event_kind_valid',
    sql`${t.eventKind} in ('mens_singles', 'womens_singles')`,
  ),
  surfaceValid: check(
    'draw_events_surface_valid',
    sql`${t.surface} in ('Hard', 'Clay', 'Grass', 'Unknown')`,
  ),
  lifecycleValid: check('draw_events_lifecycle_valid', sql`${t.completesAt} > ${t.lockAt}`),
  sourcePageHttps: check('draw_events_source_page_https', sql`${t.sourcePage} like 'https://%'`),
}));

export const drawEventOperationsAudit = pgTable('draw_event_operations_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => drawEvents.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  configuration: jsonb('configuration').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  eventCreatedIdx: index('draw_event_operations_audit_event_created_idx').on(t.eventId, t.createdAt),
  actionValid: check(
    'draw_event_operations_audit_action_valid',
    sql`${t.action} in ('configured', 'certified', 'flags_changed', 'source_status')`,
  ),
}));

export const drawAcceptedRevisions = pgTable('draw_accepted_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => drawEvents.id, { onDelete: 'restrict' }),
  sourceRevisionId: text('source_revision_id').notNull(),
  checksum: text('checksum').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  parserVersion: text('parser_version').notNull(),
  payload: jsonb('payload').notNull(),
  explicitCorrections: jsonb('explicit_corrections').notNull(),
  complete: boolean('complete').notNull(),
}, (t) => ({
  eventIdUnique: unique('draw_accepted_revisions_event_id_unique').on(t.eventId, t.id),
  eventIdAcceptedUnique: unique('draw_accepted_revisions_event_id_accepted_unique')
    .on(t.eventId, t.id, t.acceptedAt),
  sourceIdentityUnique: unique('draw_accepted_revisions_source_identity_unique')
    .on(t.eventId, t.sourceRevisionId),
  eventAcceptedIdx: index('draw_accepted_revisions_event_accepted_idx').on(t.eventId, t.acceptedAt),
  checksumValid: check('draw_accepted_revisions_checksum_valid', sql`length(${t.checksum}) = 64`),
}));

export const drawEventHeads = pgTable('draw_event_heads', {
  eventId: uuid('event_id').primaryKey().references(() => drawEvents.id, { onDelete: 'restrict' }),
  acceptedRevisionId: uuid('accepted_revision_id').notNull(),
  revisionAcceptedAt: timestamp('revision_accepted_at', { withTimezone: true }).notNull(),
  advancedAt: timestamp('advanced_at', { withTimezone: true }).notNull(),
}, (t) => ({
  acceptedRevisionOwnership: foreignKey({
    name: 'draw_event_heads_accepted_revision_ownership_fk',
    columns: [t.eventId, t.acceptedRevisionId, t.revisionAcceptedAt],
    foreignColumns: [
      drawAcceptedRevisions.eventId,
      drawAcceptedRevisions.id,
      drawAcceptedRevisions.acceptedAt,
    ],
  }).onDelete('restrict'),
  acceptedRevisionIdx: index('draw_event_heads_accepted_revision_idx').on(t.acceptedRevisionId),
}));

export const drawLeagues = pgTable('draw_leagues', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => drawEvents.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  invitationGeneration: integer('invitation_generation').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idEventUnique: unique('draw_leagues_id_event_unique').on(t.id, t.eventId),
  eventCreatedIdx: index('draw_leagues_event_created_idx').on(t.eventId, t.createdAt),
  expiryIdx: index('draw_leagues_expiry_idx').on(t.expiresAt),
  invitationGenerationValid: check(
    'draw_leagues_invitation_generation_valid',
    sql`${t.invitationGeneration} >= 0`,
  ),
}));

export const drawParticipants = pgTable('draw_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueId: uuid('league_id').notNull().references(() => drawLeagues.id, { onDelete: 'cascade' }),
  seat: integer('seat').notNull(),
  displayName: text('display_name').notNull(),
  returnGeneration: integer('return_generation').notNull().default(0),
  isCreator: boolean('is_creator').notNull().default(false),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idLeagueUnique: unique('draw_participants_id_league_unique').on(t.id, t.leagueId),
  leagueSeatUnique: unique('draw_participants_league_seat_unique').on(t.leagueId, t.seat),
  leagueCreatedIdx: index('draw_participants_league_created_idx').on(t.leagueId, t.createdAt),
  accessIdx: index('draw_participants_access_idx').on(t.id, t.returnGeneration),
  seatValid: check('draw_participants_seat_valid', sql`${t.seat} between 1 and 32`),
  returnGenerationValid: check(
    'draw_participants_return_generation_valid',
    sql`${t.returnGeneration} >= 0`,
  ),
}));

export const drawParticipantDrafts = pgTable('draw_participant_drafts', {
  participantId: uuid('participant_id').primaryKey(),
  leagueId: uuid('league_id').notNull(),
  eventId: uuid('event_id').notNull(),
  acceptedRevisionId: uuid('accepted_revision_id').notNull(),
  version: integer('version').notNull().default(1),
  picks: jsonb('picks').notNull(),
  invalidatedMatchIds: jsonb('invalidated_match_ids').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  participantOwnership: foreignKey({
    name: 'draw_participant_drafts_participant_ownership_fk',
    columns: [t.participantId, t.leagueId],
    foreignColumns: [drawParticipants.id, drawParticipants.leagueId],
  }).onDelete('cascade'),
  leagueOwnership: foreignKey({
    name: 'draw_participant_drafts_league_ownership_fk',
    columns: [t.leagueId, t.eventId],
    foreignColumns: [drawLeagues.id, drawLeagues.eventId],
  }).onDelete('cascade'),
  revisionOwnership: foreignKey({
    name: 'draw_participant_drafts_revision_ownership_fk',
    columns: [t.eventId, t.acceptedRevisionId],
    foreignColumns: [drawAcceptedRevisions.eventId, drawAcceptedRevisions.id],
  }).onDelete('restrict'),
  leagueIdx: index('draw_participant_drafts_league_idx').on(t.leagueId),
  versionValid: check('draw_participant_drafts_version_valid', sql`${t.version} > 0`),
  picksObject: check(
    'draw_participant_drafts_picks_object',
    sql`jsonb_typeof(${t.picks}) = 'object'`,
  ),
}));

export const drawSubmissions = pgTable('draw_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  participantId: uuid('participant_id').notNull(),
  leagueId: uuid('league_id').notNull(),
  eventId: uuid('event_id').notNull(),
  acceptedRevisionId: uuid('accepted_revision_id').notNull(),
  version: integer('version').notNull(),
  contractVersion: text('contract_version').notNull(),
  checksum: text('checksum').notNull(),
  picks: jsonb('picks').notNull(),
  validatedAt: timestamp('validated_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  participantLeagueIdUnique: unique('draw_submissions_participant_league_id_unique')
    .on(t.participantId, t.leagueId, t.id),
  participantVersionUnique: unique('draw_submissions_participant_version_unique')
    .on(t.participantId, t.version),
  participantOwnership: foreignKey({
    name: 'draw_submissions_participant_ownership_fk',
    columns: [t.participantId, t.leagueId],
    foreignColumns: [drawParticipants.id, drawParticipants.leagueId],
  }).onDelete('cascade'),
  leagueOwnership: foreignKey({
    name: 'draw_submissions_league_ownership_fk',
    columns: [t.leagueId, t.eventId],
    foreignColumns: [drawLeagues.id, drawLeagues.eventId],
  }).onDelete('cascade'),
  revisionOwnership: foreignKey({
    name: 'draw_submissions_revision_ownership_fk',
    columns: [t.eventId, t.acceptedRevisionId],
    foreignColumns: [drawAcceptedRevisions.eventId, drawAcceptedRevisions.id],
  }).onDelete('restrict'),
  participantCreatedIdx: index('draw_submissions_participant_created_idx')
    .on(t.participantId, t.createdAt),
  versionValid: check('draw_submissions_version_valid', sql`${t.version} > 0`),
  checksumValid: check('draw_submissions_checksum_valid', sql`length(${t.checksum}) = 64`),
  picksObject: check('draw_submissions_picks_object', sql`jsonb_typeof(${t.picks}) = 'object'`),
}));

export const drawActiveSubmissions = pgTable('draw_active_submissions', {
  participantId: uuid('participant_id').primaryKey(),
  leagueId: uuid('league_id').notNull(),
  submissionId: uuid('submission_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  submissionOwnership: foreignKey({
    name: 'draw_active_submissions_submission_ownership_fk',
    columns: [t.participantId, t.leagueId, t.submissionId],
    foreignColumns: [
      drawSubmissions.participantId,
      drawSubmissions.leagueId,
      drawSubmissions.id,
    ],
  }).onDelete('cascade'),
  submissionUnique: unique('draw_active_submissions_submission_unique').on(t.submissionId),
}));

export const drawRecapFacts = pgTable('draw_recap_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueId: uuid('league_id').notNull(),
  eventId: uuid('event_id').notNull(),
  round: integer('round').notNull(),
  acceptedRevisionId: uuid('accepted_revision_id').notNull(),
  facts: jsonb('facts').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  identityUnique: unique('draw_recap_facts_identity_unique')
    .on(t.leagueId, t.round, t.acceptedRevisionId),
  leagueOwnership: foreignKey({
    name: 'draw_recap_facts_league_ownership_fk',
    columns: [t.leagueId, t.eventId],
    foreignColumns: [drawLeagues.id, drawLeagues.eventId],
  }).onDelete('cascade'),
  revisionOwnership: foreignKey({
    name: 'draw_recap_facts_revision_ownership_fk',
    columns: [t.eventId, t.acceptedRevisionId],
    foreignColumns: [drawAcceptedRevisions.eventId, drawAcceptedRevisions.id],
  }).onDelete('restrict'),
  lookupIdx: index('draw_recap_facts_lookup_idx')
    .on(t.leagueId, t.round, t.acceptedRevisionId),
  roundValid: check('draw_recap_facts_round_valid', sql`${t.round} between 1 and 7`),
}));

export const drawEmailOutbox = pgTable('draw_email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueId: uuid('league_id').notNull().references(() => drawLeagues.id, { onDelete: 'cascade' }),
  participantId: uuid('participant_id'),
  kind: text('kind').notNull(),
  recipientEmail: text('recipient_email'),
  recipientHash: text('recipient_hash').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  participantOwnership: foreignKey({
    name: 'draw_email_outbox_participant_ownership_fk',
    columns: [t.participantId, t.leagueId],
    foreignColumns: [drawParticipants.id, drawParticipants.leagueId],
  }).onDelete('cascade'),
  pendingIdx: index('draw_email_outbox_pending_idx').on(t.status, t.availableAt),
  leagueIdx: index('draw_email_outbox_league_idx').on(t.leagueId),
  recipientIdx: index('draw_email_outbox_recipient_idx').on(t.recipientHash, t.createdAt),
  participantRecipientUnique: unique('draw_email_outbox_participant_recipient_unique')
    .on(t.participantId, t.recipientHash),
  kindValid: check('draw_email_outbox_kind_valid', sql`${t.kind} = 'return_link'`),
  statusValid: check(
    'draw_email_outbox_status_valid',
    sql`${t.status} in ('pending', 'sending', 'sent', 'failed')`,
  ),
  attemptsValid: check('draw_email_outbox_attempts_valid', sql`${t.attempts} >= 0`),
  recipientHashValid: check('draw_email_outbox_recipient_hash_valid', sql`length(${t.recipientHash}) = 64`),
}));

export const drawEngagementEvents = pgTable('draw_engagement_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueId: uuid('league_id').notNull(),
  participantId: uuid('participant_id').notNull(),
  kind: text('kind').notNull(),
  round: integer('round').notNull().default(0),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  metricUnique: unique('draw_engagement_events_metric_unique')
    .on(t.participantId, t.kind, t.round),
  participantOwnership: foreignKey({
    name: 'draw_engagement_events_participant_ownership_fk',
    columns: [t.participantId, t.leagueId],
    foreignColumns: [drawParticipants.id, drawParticipants.leagueId],
  }).onDelete('cascade'),
  leagueKindIdx: index('draw_engagement_events_league_kind_idx').on(t.leagueId, t.kind, t.firstAt),
  kindValid: check(
    'draw_engagement_events_kind_valid',
    sql`${t.kind} in ('submission', 'qualifying_return', 'recap_view', 'recap_export')`,
  ),
  roundValid: check('draw_engagement_events_round_valid', sql`${t.round} between 0 and 7`),
}));

export const drawAbuseLimits = pgTable('draw_abuse_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeKind: text('scope_kind').notNull(),
  scopeHash: text('scope_hash').notNull(),
  eventId: uuid('event_id').references(() => drawEvents.id, { onDelete: 'set null' }),
  leagueId: uuid('league_id').references(() => drawLeagues.id, { onDelete: 'set null' }),
  scopeOwnerDeletedAt: timestamp('scope_owner_deleted_at', { withTimezone: true }),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeWindowUnique: unique('draw_abuse_limits_scope_window_unique')
    .on(t.scopeKind, t.scopeHash, t.windowStartedAt),
  eventScopeIdx: index('draw_abuse_limits_event_scope_idx')
    .on(t.eventId, t.scopeKind, t.windowStartedAt),
  leagueScopeIdx: index('draw_abuse_limits_league_scope_idx')
    .on(t.leagueId, t.scopeKind, t.windowStartedAt),
  cleanupIdx: index('draw_abuse_limits_cleanup_idx').on(t.expiresAt),
  scopeKindValid: check(
    'draw_abuse_limits_scope_kind_valid',
    sql`${t.scopeKind} in ('ip', 'event', 'league', 'token', 'email')`,
  ),
  scopeIdentifiersValid: check(
    'draw_abuse_limits_scope_identifiers_valid',
    sql`(
      ${t.scopeKind} = 'event'
      and (
        (${t.eventId} is not null and ${t.leagueId} is null and ${t.scopeOwnerDeletedAt} is null)
        or (${t.eventId} is null and ${t.leagueId} is null and ${t.scopeOwnerDeletedAt} is not null)
      )
    ) or (
      ${t.scopeKind} = 'league'
      and (
        (${t.eventId} is null and ${t.leagueId} is not null and ${t.scopeOwnerDeletedAt} is null)
        or (${t.eventId} is null and ${t.leagueId} is null and ${t.scopeOwnerDeletedAt} is not null)
      )
    ) or (
      ${t.scopeKind} in ('ip', 'token', 'email')
      and ${t.eventId} is null
      and ${t.leagueId} is null
      and ${t.scopeOwnerDeletedAt} is null
    )`,
  ),
  scopeHashValid: check('draw_abuse_limits_scope_hash_valid', sql`length(${t.scopeHash}) = 64`),
  attemptCountValid: check('draw_abuse_limits_attempt_count_valid', sql`${t.attemptCount} >= 0`),
  expiryValid: check('draw_abuse_limits_expiry_valid', sql`${t.expiresAt} > ${t.windowStartedAt}`),
}));

export type DrawEvent = typeof drawEvents.$inferSelect;
export type DrawEventOperationsAudit = typeof drawEventOperationsAudit.$inferSelect;
export type DrawAcceptedRevision = typeof drawAcceptedRevisions.$inferSelect;
export type DrawEventHead = typeof drawEventHeads.$inferSelect;
export type DrawLeague = typeof drawLeagues.$inferSelect;
export type DrawParticipant = typeof drawParticipants.$inferSelect;
export type DrawParticipantDraft = typeof drawParticipantDrafts.$inferSelect;
export type DrawSubmission = typeof drawSubmissions.$inferSelect;
export type DrawActiveSubmission = typeof drawActiveSubmissions.$inferSelect;
export type DrawRecapFact = typeof drawRecapFacts.$inferSelect;
export type DrawEmailOutboxRow = typeof drawEmailOutbox.$inferSelect;
export type DrawEngagementEvent = typeof drawEngagementEvents.$inferSelect;
export type DrawAbuseLimit = typeof drawAbuseLimits.$inferSelect;
