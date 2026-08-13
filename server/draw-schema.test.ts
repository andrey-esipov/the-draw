import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-schema');
type DrawDb = Parameters<Parameters<typeof withDb>[0]>[0];

const ids = {
  eventA: '10000000-0000-4000-8000-000000000001',
  eventB: '10000000-0000-4000-8000-000000000002',
  eventC: '10000000-0000-4000-8000-000000000003',
  revisionA1: '20000000-0000-4000-8000-000000000001',
  revisionA2: '20000000-0000-4000-8000-000000000002',
  revisionB1: '20000000-0000-4000-8000-000000000003',
  league: '30000000-0000-4000-8000-000000000001',
  participantA: '40000000-0000-4000-8000-000000000001',
  participantB: '40000000-0000-4000-8000-000000000002',
  submissionA: '50000000-0000-4000-8000-000000000001',
  submissionB: '50000000-0000-4000-8000-000000000002',
};

async function executeBatch(database: DrawDb, statements: string[]) {
  for (const statement of statements) await database.execute(sql.raw(statement));
}

async function queryRows<T>(database: DrawDb, statement: string): Promise<T[]> {
  const result = await database.execute(sql.raw(statement));
  return (result as unknown as { rows: T[] }).rows;
}

async function seedCanonical(database: DrawDb) {
  await executeBatch(database, [`
    INSERT INTO draw_events (
      id, slug, draw_id, tournament, tournament_year, event_kind, surface, venue, city, source_page,
      lock_at, completes_at
    ) VALUES
      ('${ids.eventA}', 'us-open-2026-men', 'us-open-2026-men', 'US Open', 2026, 'mens_singles', 'Hard', 'USTA', 'New York',
       'https://en.wikipedia.org/wiki/2026_US_Open_men_singles', '2026-08-24T15:00:00Z',
       '2026-09-13T23:00:00Z'),
      ('${ids.eventB}', 'us-open-2026-women', 'us-open-2026-women', 'US Open', 2026, 'womens_singles', 'Hard', 'USTA', 'New York',
       'https://en.wikipedia.org/wiki/2026_US_Open_women_singles', '2026-08-24T15:00:00Z',
       '2026-09-13T23:00:00Z')
  `, `
    INSERT INTO draw_accepted_revisions (
      id, event_id, source_revision_id, checksum, fetched_at, accepted_at, parser_version,
      payload, explicit_corrections, complete
    ) VALUES
      ('${ids.revisionA1}', '${ids.eventA}', '101', repeat('a', 64), '2026-08-11T10:00:00Z',
       '2026-08-11T10:01:00Z', 'u1', '{"draw":"a1"}', '[]', false),
      ('${ids.revisionA2}', '${ids.eventA}', '102', repeat('b', 64), '2026-08-11T11:00:00Z',
       '2026-08-11T11:01:00Z', 'u1', '{"draw":"a2"}', '[]', false),
      ('${ids.revisionB1}', '${ids.eventB}', '101', repeat('c', 64), '2026-08-11T10:00:00Z',
       '2026-08-11T10:02:00Z', 'u1', '{"draw":"b1"}', '[]', false)
  `, `
    INSERT INTO draw_event_heads (
      event_id, accepted_revision_id, revision_accepted_at, advanced_at
    ) VALUES (
      '${ids.eventA}', '${ids.revisionA1}', '2026-08-11T10:01:00Z', '2026-08-11T10:01:00Z'
    )
  `]);
}

async function seedLeague(database: DrawDb) {
  await seedCanonical(database);
  await executeBatch(database, [`
    INSERT INTO draw_leagues (
      id, event_id, name, invitation_generation, expires_at
    ) VALUES (
      '${ids.league}', '${ids.eventA}', 'Friends', 0, '2027-10-13T23:00:00Z'
    )
  `, `
    INSERT INTO draw_participants (
      id, league_id, seat, display_name, return_generation, is_creator
    ) VALUES
      ('${ids.participantA}', '${ids.league}', 1, 'Ada', 0, true),
      ('${ids.participantB}', '${ids.league}', 2, 'Grace', 0, false)
  `]);
}

describe('Draw persistence schema', () => {
  it('creates every U2 owner and stores no raw capability token column', async () => {
    await withDb(async (database) => {
      const rows = await queryRows<{ table_name: string; column_name: string }>(database, `
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'draw_events', 'draw_accepted_revisions', 'draw_event_heads', 'draw_leagues',
            'draw_participants', 'draw_participant_drafts', 'draw_submissions',
            'draw_active_submissions', 'draw_recap_facts', 'draw_email_outbox',
            'draw_engagement_events', 'draw_abuse_limits'
          )
        ORDER BY table_name, ordinal_position
      `);
      expect(new Set(rows.map((row) => row.table_name))).toEqual(new Set([
        'draw_events',
        'draw_accepted_revisions',
        'draw_event_heads',
        'draw_leagues',
        'draw_participants',
        'draw_participant_drafts',
        'draw_submissions',
        'draw_active_submissions',
        'draw_recap_facts',
        'draw_email_outbox',
        'draw_engagement_events',
        'draw_abuse_limits',
      ]));
      expect(rows.filter((row) => /(^|_)token($|_)/.test(row.column_name))).toEqual([]);
    });
  });

  it('rejects duplicate source identity and cross-event head ownership', async () => {
    await withDb(async (database) => {
      await seedCanonical(database);
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_accepted_revisions (
          event_id, source_revision_id, checksum, fetched_at, accepted_at, parser_version,
          payload, explicit_corrections, complete
        ) VALUES (
          '${ids.eventA}', '101', repeat('d', 64), now(), now(), 'u1', '{}', '[]', false
        )
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_event_heads (
          event_id, accepted_revision_id, revision_accepted_at, advanced_at
        ) VALUES (
          '${ids.eventB}', '${ids.revisionA2}', '2026-08-11T11:01:00Z', now()
        )
      `))).rejects.toThrow();
    });
  });

  it('keeps accepted revisions, submissions, and recap facts append-only', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      await executeBatch(database, [`
        INSERT INTO draw_submissions (
          id, participant_id, league_id, event_id, accepted_revision_id, version,
          contract_version, checksum, picks, validated_at
        ) VALUES (
          '${ids.submissionA}', '${ids.participantA}', '${ids.league}', '${ids.eventA}',
          '${ids.revisionA1}', 1, 'v1', repeat('d', 64), '{"r1m1":"p1"}', now()
        )
      `, `
        INSERT INTO draw_recap_facts (
          league_id, event_id, round, accepted_revision_id, facts
        ) VALUES (
          '${ids.league}', '${ids.eventA}', 1, '${ids.revisionA1}',
          '{"participantIds":["${ids.participantA}"]}'
        )
      `]);
      await expect(database.execute(sql.raw(`
        UPDATE draw_accepted_revisions SET parser_version = 'changed' WHERE id = '${ids.revisionA1}'
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        DELETE FROM draw_accepted_revisions WHERE id = '${ids.revisionA2}'
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        UPDATE draw_submissions SET picks = '{}' WHERE id = '${ids.submissionA}'
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        UPDATE draw_recap_facts SET facts = '{}' WHERE league_id = '${ids.league}'
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_recap_facts (
          league_id, event_id, round, accepted_revision_id, facts
        ) VALUES ('${ids.league}', '${ids.eventA}', 1, '${ids.revisionA1}', '{}')
      `))).rejects.toThrow();
    });
  });

  it('enforces bounded persistent seats and cascades league-owned data only', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_participants (league_id, seat, display_name, return_generation, is_creator)
        VALUES ('${ids.league}', 0, 'Invalid', 0, false)
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_participants (league_id, seat, display_name, return_generation, is_creator)
        VALUES ('${ids.league}', 33, 'Invalid', 0, false)
      `))).rejects.toThrow();
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_participants (league_id, seat, display_name, return_generation, is_creator)
        VALUES ('${ids.league}', 1, 'Duplicate', 0, false)
      `))).rejects.toThrow();

      await executeBatch(database, [`
        UPDATE draw_participants
        SET display_name = 'Removed player', removed_at = now(), return_generation = 1
        WHERE id = '${ids.participantA}'
      `, `
        INSERT INTO draw_recap_facts (league_id, event_id, round, accepted_revision_id, facts)
        VALUES ('${ids.league}', '${ids.eventA}', 1, '${ids.revisionA1}', '{}')
      `, `
        INSERT INTO draw_email_outbox (
          league_id, participant_id, kind, recipient_email, recipient_hash, status, available_at
        ) VALUES (
          '${ids.league}', '${ids.participantA}', 'return_link', 'masked@example.test',
          repeat('e', 64), 'pending', now()
        )
      `, `
        INSERT INTO draw_engagement_events (league_id, participant_id, kind, round)
        VALUES ('${ids.league}', '${ids.participantA}', 'qualifying_return', 1)
      `]);
      const participant = await queryRows<{ seat: number }>(database, `
        SELECT seat FROM draw_participants WHERE id = '${ids.participantA}'
      `);
      expect(participant).toEqual([{ seat: 1 }]);

      await database.execute(sql.raw(`DELETE FROM draw_leagues WHERE id = '${ids.league}'`));
      for (const table of [
        'draw_participants',
        'draw_recap_facts',
        'draw_email_outbox',
        'draw_engagement_events',
      ]) {
        const count = await queryRows<{ count: number }>(
          database,
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        expect(count).toEqual([{ count: 0 }]);
      }
      const revisionCount = await queryRows<{ count: number }>(database, `
        SELECT count(*)::int AS count FROM draw_accepted_revisions WHERE event_id = '${ids.eventA}'
      `);
      expect(revisionCount).toEqual([{ count: 2 }]);
    });
  });

  it('keeps mutable drafts while preserving submission history and active lineage', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      await executeBatch(database, [`
        INSERT INTO draw_participant_drafts (
          participant_id, league_id, event_id, accepted_revision_id, version, picks,
          invalidated_match_ids
        ) VALUES (
          '${ids.participantA}', '${ids.league}', '${ids.eventA}', '${ids.revisionA1}',
          1, '{"r1m1":"p1"}', '[]'
        )
      `, `
        UPDATE draw_participant_drafts
        SET version = 2, picks = '{"r1m1":"p2"}', updated_at = now()
        WHERE participant_id = '${ids.participantA}'
      `, `
        INSERT INTO draw_submissions (
          id, participant_id, league_id, event_id, accepted_revision_id, version,
          contract_version, checksum, picks, validated_at
        ) VALUES
          ('${ids.submissionA}', '${ids.participantA}', '${ids.league}', '${ids.eventA}',
           '${ids.revisionA1}', 1, 'v1', repeat('f', 64), '{"r1m1":"p1"}', now()),
          ('${ids.submissionB}', '${ids.participantA}', '${ids.league}', '${ids.eventA}',
           '${ids.revisionA2}', 2, 'v1', repeat('0', 64), '{"r1m1":"p2"}', now())
      `, `
        INSERT INTO draw_active_submissions (participant_id, league_id, submission_id)
        VALUES ('${ids.participantA}', '${ids.league}', '${ids.submissionA}')
      `, `
        UPDATE draw_active_submissions
        SET submission_id = '${ids.submissionB}', updated_at = now()
        WHERE participant_id = '${ids.participantA}'
      `]);
      const state = await queryRows(database, `
        SELECT d.version AS draft_version, d.picks AS draft_picks,
          a.submission_id, array_agg(s.picks ORDER BY s.version) AS history
        FROM draw_participant_drafts d
        JOIN draw_active_submissions a USING (participant_id)
        JOIN draw_submissions s USING (participant_id)
        GROUP BY d.version, d.picks, a.submission_id
      `);
      expect(state).toEqual([{
        draft_version: 2,
        draft_picks: { r1m1: 'p2' },
        submission_id: ids.submissionB,
        history: [{ r1m1: 'p1' }, { r1m1: 'p2' }],
      }]);
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_active_submissions (participant_id, league_id, submission_id)
        VALUES ('${ids.participantB}', '${ids.league}', '${ids.submissionB}')
      `))).rejects.toThrow();
    });
  });

  it('rejects non-object draft and submission picks at the database boundary', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      for (const picks of [`'[]'`, `'null'`, `'42'`, `'"p1"'`]) {
        await expect(database.execute(sql.raw(`
          INSERT INTO draw_participant_drafts (
            participant_id, league_id, event_id, accepted_revision_id, picks,
            invalidated_match_ids
          ) VALUES (
            '${ids.participantA}', '${ids.league}', '${ids.eventA}', '${ids.revisionA1}',
            ${picks}, '[]'
          )
        `))).rejects.toThrow();
        await expect(database.execute(sql.raw(`
          INSERT INTO draw_submissions (
            participant_id, league_id, event_id, accepted_revision_id, version,
            contract_version, checksum, picks, validated_at
          ) VALUES (
            '${ids.participantA}', '${ids.league}', '${ids.eventA}', '${ids.revisionA1}',
            1, 'v1', repeat('f', 64), ${picks}, now()
          )
        `))).rejects.toThrow();
      }
    });
  });

  it('deduplicates engagement independently of revision and anonymization', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      for (const kind of ['qualifying_return', 'recap_view', 'recap_export']) {
        await database.execute(sql.raw(`
          INSERT INTO draw_engagement_events (league_id, participant_id, kind, round)
          VALUES ('${ids.league}', '${ids.participantA}', '${kind}', 2)
        `));
        await expect(database.execute(sql.raw(`
          INSERT INTO draw_engagement_events (league_id, participant_id, kind, round)
          VALUES ('${ids.league}', '${ids.participantA}', '${kind}', 2)
        `))).rejects.toThrow();
      }
      await database.execute(sql.raw(`
        UPDATE draw_participants SET display_name = 'Removed player', removed_at = now()
        WHERE id = '${ids.participantA}'
      `));
      for (const kind of ['qualifying_return', 'recap_view', 'recap_export']) {
        await expect(database.execute(sql.raw(`
          INSERT INTO draw_engagement_events (league_id, participant_id, kind, round)
          VALUES ('${ids.league}', '${ids.participantA}', '${kind}', 2)
        `))).rejects.toThrow();
      }
    });
  });

  it('enforces abuse-limit scope shape and preserves durable history across owner deletion', async () => {
    await withDb(async (database) => {
      await seedLeague(database);
      await executeBatch(database, [`
        INSERT INTO draw_abuse_limits (
          scope_kind, scope_hash, event_id, window_started_at, attempt_count, expires_at
        ) VALUES (
          'event', repeat('1', 64), '${ids.eventA}',
          '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z'
        )
      `, `
        INSERT INTO draw_abuse_limits (
          scope_kind, scope_hash, league_id, window_started_at, attempt_count, expires_at
        ) VALUES (
          'league', repeat('2', 64), '${ids.league}',
          '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z'
        )
      `, `
        INSERT INTO draw_abuse_limits (
          scope_kind, scope_hash, window_started_at, attempt_count, expires_at
        ) VALUES
          ('ip', repeat('3', 64), '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z'),
          ('token', repeat('4', 64), '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z'),
          ('email', repeat('5', 64), '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z')
      `]);
      for (const invalidShape of [
        `'ip', repeat('6', 64), '${ids.eventA}', null`,
        `'token', repeat('7', 64), null, '${ids.league}'`,
        `'event', repeat('8', 64), null, '${ids.league}'`,
        `'league', repeat('9', 64), '${ids.eventA}', null`,
        `'event', repeat('b', 64), null, null`,
        `'league', repeat('c', 64), null, null`,
      ]) {
        await expect(database.execute(sql.raw(`
          INSERT INTO draw_abuse_limits (
            scope_kind, scope_hash, event_id, league_id, window_started_at, expires_at
          ) VALUES (
            ${invalidShape}, '2026-08-11T12:00:00Z', '2026-08-11T13:00:00Z'
          )
        `))).rejects.toThrow();
      }

      await database.execute(sql.raw(`DELETE FROM draw_leagues WHERE id = '${ids.league}'`));
      await executeBatch(database, [`
        INSERT INTO draw_events (
          id, slug, draw_id, tournament, tournament_year, event_kind, surface, venue, city, source_page,
          lock_at, completes_at
        ) VALUES (
          '${ids.eventC}', 'fixture-event', 'fixture-event', 'Fixture', 2026, 'mens_singles', 'Hard', 'Fixture', 'Fixture',
          'https://example.test/fixture', '2026-08-12T12:00:00Z', '2026-08-13T12:00:00Z'
        )
      `, `
        INSERT INTO draw_abuse_limits (
          scope_kind, scope_hash, event_id, window_started_at, attempt_count, expires_at
        ) VALUES (
          'event', repeat('a', 64), '${ids.eventC}',
          '2026-08-11T12:00:00Z', 1, '2026-08-11T13:00:00Z'
        )
      `, `
        DELETE FROM draw_events WHERE id = '${ids.eventC}'
      `]);
      const scopes = await queryRows<{
        scope_kind: string;
        scope_hash: string;
        event_id: string | null;
        league_id: string | null;
      }>(database, `
        SELECT scope_kind, scope_hash, event_id, league_id
        FROM draw_abuse_limits ORDER BY scope_kind
      `);
      expect(scopes.map((row) => row.scope_kind)).toEqual([
        'email',
        'event',
        'event',
        'ip',
        'league',
        'token',
      ]);
      expect(scopes.every((row) => row.scope_hash.length === 64)).toBe(true);
      expect(scopes.find((row) => row.scope_kind === 'league')?.league_id).toBeNull();
      expect(scopes.find((row) => row.scope_hash === '1'.repeat(64))?.event_id).toBe(ids.eventA);
      expect(scopes.find((row) => row.scope_hash === 'a'.repeat(64))?.event_id).toBeNull();
      await expect(database.execute(sql.raw(`
        INSERT INTO draw_abuse_limits (
          scope_kind, scope_hash, window_started_at, attempt_count, expires_at
        ) VALUES (
          'ip', repeat('3', 64), '2026-08-11T12:00:00Z', 2, '2026-08-11T13:00:00Z'
        )
      `))).rejects.toThrow();
    });
  });

  it('rolls back a head advance whose freshness does not belong to its revision', async () => {
    await withDb(async (database) => {
      await seedCanonical(database);
      await expect(database.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`
          UPDATE draw_event_heads
          SET accepted_revision_id = '${ids.revisionA2}',
              revision_accepted_at = '2026-08-11T10:01:00Z',
              advanced_at = '2026-08-11T11:02:00Z'
          WHERE event_id = '${ids.eventA}'
        `));
      })).rejects.toThrow();
      const head = await queryRows(database, `
        SELECT accepted_revision_id, revision_accepted_at
        FROM draw_event_heads WHERE event_id = '${ids.eventA}'
      `);
      expect(head).toEqual([{
        accepted_revision_id: ids.revisionA1,
        revision_accepted_at: '2026-08-11 10:01:00+00',
      }]);
    });
  });
});
