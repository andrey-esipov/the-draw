CREATE TABLE IF NOT EXISTS "draw_abuse_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_hash" text NOT NULL,
	"event_id" uuid,
	"league_id" uuid,
	"scope_owner_deleted_at" timestamp with time zone,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_abuse_limits_scope_window_unique" UNIQUE("scope_kind","scope_hash","window_started_at"),
	CONSTRAINT "draw_abuse_limits_scope_kind_valid" CHECK ("draw_abuse_limits"."scope_kind" in ('ip', 'event', 'league', 'token', 'email')),
	CONSTRAINT "draw_abuse_limits_scope_identifiers_valid" CHECK ((
      "draw_abuse_limits"."scope_kind" = 'event'
      and (
        ("draw_abuse_limits"."event_id" is not null and "draw_abuse_limits"."league_id" is null and "draw_abuse_limits"."scope_owner_deleted_at" is null)
        or ("draw_abuse_limits"."event_id" is null and "draw_abuse_limits"."league_id" is null and "draw_abuse_limits"."scope_owner_deleted_at" is not null)
      )
    ) or (
      "draw_abuse_limits"."scope_kind" = 'league'
      and (
        ("draw_abuse_limits"."event_id" is null and "draw_abuse_limits"."league_id" is not null and "draw_abuse_limits"."scope_owner_deleted_at" is null)
        or ("draw_abuse_limits"."event_id" is null and "draw_abuse_limits"."league_id" is null and "draw_abuse_limits"."scope_owner_deleted_at" is not null)
      )
    ) or (
      "draw_abuse_limits"."scope_kind" in ('ip', 'token', 'email')
      and "draw_abuse_limits"."event_id" is null
      and "draw_abuse_limits"."league_id" is null
      and "draw_abuse_limits"."scope_owner_deleted_at" is null
    )),
	CONSTRAINT "draw_abuse_limits_scope_hash_valid" CHECK (length("draw_abuse_limits"."scope_hash") = 64),
	CONSTRAINT "draw_abuse_limits_attempt_count_valid" CHECK ("draw_abuse_limits"."attempt_count" >= 0),
	CONSTRAINT "draw_abuse_limits_expiry_valid" CHECK ("draw_abuse_limits"."expires_at" > "draw_abuse_limits"."window_started_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_accepted_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"source_revision_id" text NOT NULL,
	"checksum" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"parser_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"explicit_corrections" jsonb NOT NULL,
	"complete" boolean NOT NULL,
	CONSTRAINT "draw_accepted_revisions_event_id_unique" UNIQUE("event_id","id"),
	CONSTRAINT "draw_accepted_revisions_event_id_accepted_unique" UNIQUE("event_id","id","accepted_at"),
	CONSTRAINT "draw_accepted_revisions_source_identity_unique" UNIQUE("event_id","source_revision_id"),
	CONSTRAINT "draw_accepted_revisions_checksum_valid" CHECK (length("draw_accepted_revisions"."checksum") = 64)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_active_submissions" (
	"participant_id" uuid PRIMARY KEY NOT NULL,
	"league_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_active_submissions_submission_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"participant_id" uuid,
	"kind" text NOT NULL,
	"recipient_email" text,
	"recipient_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_email_outbox_participant_recipient_unique" UNIQUE("participant_id","recipient_hash"),
	CONSTRAINT "draw_email_outbox_kind_valid" CHECK ("draw_email_outbox"."kind" = 'return_link'),
	CONSTRAINT "draw_email_outbox_status_valid" CHECK ("draw_email_outbox"."status" in ('pending', 'sending', 'sent', 'failed')),
	CONSTRAINT "draw_email_outbox_attempts_valid" CHECK ("draw_email_outbox"."attempts" >= 0),
	CONSTRAINT "draw_email_outbox_recipient_hash_valid" CHECK (length("draw_email_outbox"."recipient_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_engagement_events_metric_unique" UNIQUE("participant_id","kind","round"),
	CONSTRAINT "draw_engagement_events_kind_valid" CHECK ("draw_engagement_events"."kind" in ('submission', 'qualifying_return', 'recap_view', 'recap_export')),
	CONSTRAINT "draw_engagement_events_round_valid" CHECK ("draw_engagement_events"."round" between 0 and 7)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_event_heads" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"accepted_revision_id" uuid NOT NULL,
	"revision_accepted_at" timestamp with time zone NOT NULL,
	"advanced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_event_operations_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_event_operations_audit_action_valid" CHECK ("draw_event_operations_audit"."action" in ('configured', 'certified', 'flags_changed', 'source_status'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"draw_id" text NOT NULL,
	"tournament" text NOT NULL,
	"tournament_year" integer NOT NULL,
	"event_kind" text NOT NULL,
	"surface" text NOT NULL,
	"venue" text NOT NULL,
	"city" text NOT NULL,
	"source_page" text NOT NULL,
	"lock_at" timestamp with time zone NOT NULL,
	"completes_at" timestamp with time zone NOT NULL,
	"polling_enabled" boolean DEFAULT false NOT NULL,
	"creation_enabled" boolean DEFAULT false NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"delay_code" text,
	"failure_code" text,
	"projection_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "draw_events_draw_id_unique" UNIQUE("draw_id"),
	CONSTRAINT "draw_events_source_page_unique" UNIQUE("source_page"),
	CONSTRAINT "draw_events_event_kind_valid" CHECK ("draw_events"."event_kind" in ('mens_singles', 'womens_singles')),
	CONSTRAINT "draw_events_surface_valid" CHECK ("draw_events"."surface" in ('Hard', 'Clay', 'Grass', 'Unknown')),
	CONSTRAINT "draw_events_lifecycle_valid" CHECK ("draw_events"."completes_at" > "draw_events"."lock_at"),
	CONSTRAINT "draw_events_source_page_https" CHECK ("draw_events"."source_page" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"invitation_generation" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_leagues_id_event_unique" UNIQUE("id","event_id"),
	CONSTRAINT "draw_leagues_invitation_generation_valid" CHECK ("draw_leagues"."invitation_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_participant_drafts" (
	"participant_id" uuid PRIMARY KEY NOT NULL,
	"league_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"accepted_revision_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"picks" jsonb NOT NULL,
	"invalidated_match_ids" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_participant_drafts_version_valid" CHECK ("draw_participant_drafts"."version" > 0),
	CONSTRAINT "draw_participant_drafts_picks_object" CHECK (jsonb_typeof("draw_participant_drafts"."picks") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"seat" integer NOT NULL,
	"display_name" text NOT NULL,
	"return_generation" integer DEFAULT 0 NOT NULL,
	"is_creator" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_participants_id_league_unique" UNIQUE("id","league_id"),
	CONSTRAINT "draw_participants_league_seat_unique" UNIQUE("league_id","seat"),
	CONSTRAINT "draw_participants_seat_valid" CHECK ("draw_participants"."seat" between 1 and 32),
	CONSTRAINT "draw_participants_return_generation_valid" CHECK ("draw_participants"."return_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_recap_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"accepted_revision_id" uuid NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_recap_facts_identity_unique" UNIQUE("league_id","round","accepted_revision_id"),
	CONSTRAINT "draw_recap_facts_round_valid" CHECK ("draw_recap_facts"."round" between 1 and 7)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"league_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"accepted_revision_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"contract_version" text NOT NULL,
	"checksum" text NOT NULL,
	"picks" jsonb NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_submissions_participant_league_id_unique" UNIQUE("participant_id","league_id","id"),
	CONSTRAINT "draw_submissions_participant_version_unique" UNIQUE("participant_id","version"),
	CONSTRAINT "draw_submissions_version_valid" CHECK ("draw_submissions"."version" > 0),
	CONSTRAINT "draw_submissions_checksum_valid" CHECK (length("draw_submissions"."checksum") = 64),
	CONSTRAINT "draw_submissions_picks_object" CHECK (jsonb_typeof("draw_submissions"."picks") = 'object')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_abuse_limits" ADD CONSTRAINT "draw_abuse_limits_event_id_draw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."draw_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_abuse_limits" ADD CONSTRAINT "draw_abuse_limits_league_id_draw_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."draw_leagues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_accepted_revisions" ADD CONSTRAINT "draw_accepted_revisions_event_id_draw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."draw_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_active_submissions" ADD CONSTRAINT "draw_active_submissions_submission_ownership_fk" FOREIGN KEY ("participant_id","league_id","submission_id") REFERENCES "public"."draw_submissions"("participant_id","league_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_email_outbox" ADD CONSTRAINT "draw_email_outbox_league_id_draw_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."draw_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_email_outbox" ADD CONSTRAINT "draw_email_outbox_participant_ownership_fk" FOREIGN KEY ("participant_id","league_id") REFERENCES "public"."draw_participants"("id","league_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_engagement_events" ADD CONSTRAINT "draw_engagement_events_participant_ownership_fk" FOREIGN KEY ("participant_id","league_id") REFERENCES "public"."draw_participants"("id","league_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_event_heads" ADD CONSTRAINT "draw_event_heads_event_id_draw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."draw_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_event_heads" ADD CONSTRAINT "draw_event_heads_accepted_revision_ownership_fk" FOREIGN KEY ("event_id","accepted_revision_id","revision_accepted_at") REFERENCES "public"."draw_accepted_revisions"("event_id","id","accepted_at") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_event_operations_audit" ADD CONSTRAINT "draw_event_operations_audit_event_id_draw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."draw_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_leagues" ADD CONSTRAINT "draw_leagues_event_id_draw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."draw_events"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_participant_drafts" ADD CONSTRAINT "draw_participant_drafts_participant_ownership_fk" FOREIGN KEY ("participant_id","league_id") REFERENCES "public"."draw_participants"("id","league_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_participant_drafts" ADD CONSTRAINT "draw_participant_drafts_league_ownership_fk" FOREIGN KEY ("league_id","event_id") REFERENCES "public"."draw_leagues"("id","event_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_participant_drafts" ADD CONSTRAINT "draw_participant_drafts_revision_ownership_fk" FOREIGN KEY ("event_id","accepted_revision_id") REFERENCES "public"."draw_accepted_revisions"("event_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_participants" ADD CONSTRAINT "draw_participants_league_id_draw_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."draw_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_recap_facts" ADD CONSTRAINT "draw_recap_facts_league_ownership_fk" FOREIGN KEY ("league_id","event_id") REFERENCES "public"."draw_leagues"("id","event_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_recap_facts" ADD CONSTRAINT "draw_recap_facts_revision_ownership_fk" FOREIGN KEY ("event_id","accepted_revision_id") REFERENCES "public"."draw_accepted_revisions"("event_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_submissions" ADD CONSTRAINT "draw_submissions_participant_ownership_fk" FOREIGN KEY ("participant_id","league_id") REFERENCES "public"."draw_participants"("id","league_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_submissions" ADD CONSTRAINT "draw_submissions_league_ownership_fk" FOREIGN KEY ("league_id","event_id") REFERENCES "public"."draw_leagues"("id","event_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw_submissions" ADD CONSTRAINT "draw_submissions_revision_ownership_fk" FOREIGN KEY ("event_id","accepted_revision_id") REFERENCES "public"."draw_accepted_revisions"("event_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_abuse_limits_event_scope_idx" ON "draw_abuse_limits" USING btree ("event_id","scope_kind","window_started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_abuse_limits_league_scope_idx" ON "draw_abuse_limits" USING btree ("league_id","scope_kind","window_started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_abuse_limits_cleanup_idx" ON "draw_abuse_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_accepted_revisions_event_accepted_idx" ON "draw_accepted_revisions" USING btree ("event_id","accepted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_email_outbox_pending_idx" ON "draw_email_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_email_outbox_league_idx" ON "draw_email_outbox" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_email_outbox_recipient_idx" ON "draw_email_outbox" USING btree ("recipient_hash","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_engagement_events_league_kind_idx" ON "draw_engagement_events" USING btree ("league_id","kind","first_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_event_heads_accepted_revision_idx" ON "draw_event_heads" USING btree ("accepted_revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_event_operations_audit_event_created_idx" ON "draw_event_operations_audit" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_events_active_polling_idx" ON "draw_events" USING btree ("polling_enabled","last_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_events_cleanup_idx" ON "draw_events" USING btree ("completes_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_leagues_event_created_idx" ON "draw_leagues" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_leagues_expiry_idx" ON "draw_leagues" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_participant_drafts_league_idx" ON "draw_participant_drafts" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_participants_league_created_idx" ON "draw_participants" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_participants_access_idx" ON "draw_participants" USING btree ("id","return_generation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_recap_facts_lookup_idx" ON "draw_recap_facts" USING btree ("league_id","round","accepted_revision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draw_submissions_participant_created_idx" ON "draw_submissions" USING btree ("participant_id","created_at");--> statement-breakpoint

-- Drizzle db:push and generated snapshots do not install procedural trigger guarantees.
-- This file migration is authoritative for Draw append-only and owner-tombstone invariants.
CREATE OR REPLACE FUNCTION draw_reject_append_only_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TRIGGER draw_accepted_revisions_append_only
 BEFORE UPDATE OR DELETE ON draw_accepted_revisions
 FOR EACH ROW EXECUTE FUNCTION draw_reject_append_only_update();
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TRIGGER draw_submissions_append_only
 BEFORE UPDATE ON draw_submissions
 FOR EACH ROW EXECUTE FUNCTION draw_reject_append_only_update();
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TRIGGER draw_recap_facts_append_only
 BEFORE UPDATE ON draw_recap_facts
 FOR EACH ROW EXECUTE FUNCTION draw_reject_append_only_update();
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION draw_tombstone_event_abuse_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE draw_abuse_limits
  SET event_id = NULL, scope_owner_deleted_at = now()
  WHERE scope_kind = 'event' AND event_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION draw_tombstone_league_abuse_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE draw_abuse_limits
  SET league_id = NULL, scope_owner_deleted_at = now()
  WHERE scope_kind = 'league' AND league_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TRIGGER draw_events_tombstone_abuse_limits
 BEFORE DELETE ON draw_events
 FOR EACH ROW EXECUTE FUNCTION draw_tombstone_event_abuse_limits();
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TRIGGER draw_leagues_tombstone_abuse_limits
 BEFORE DELETE ON draw_leagues
 FOR EACH ROW EXECUTE FUNCTION draw_tombstone_league_abuse_limits();
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
