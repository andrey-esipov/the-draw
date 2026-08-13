import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { db } from './db.js';
import { drawEvents } from './schema.js';
import {
  certifyDrawEvent,
  configureDrawEvent,
  drawDeploymentInvariants,
  drawSourceHealth,
  drawSourceOperatorStatus,
  inspectDrawEvent,
  setDrawEventFlags,
} from './draw-operations.js';

let client: PGlite;
let database: typeof db;

const base = {
  slug: 'wimbledon-men',
  drawId: 'wimbledon-2026-men',
  tournament: 'Wimbledon',
  tournamentYear: 2026,
  eventKind: 'mens_singles' as const,
  surface: 'Grass' as const,
  venue: 'All England Lawn Tennis and Croquet Club',
  city: 'London',
  sourcePage: 'https://en.wikipedia.org/wiki/2026_Wimbledon_Championships_%E2%80%93_Men%27s_singles',
  lockAt: new Date('2026-08-10T10:00:00Z'),
  completesAt: new Date('2026-08-20T20:00:00Z'),
};

describe('Draw operations', () => {
  beforeAll(async () => {
    client = new PGlite();
    const pgliteDatabase = drizzlePglite(client, { schema: await import('./schema.js') });
    await migrate(pgliteDatabase, { migrationsFolder: './drizzle' });
    database = pgliteDatabase as unknown as typeof db;
  }, 60_000);

  beforeEach(async () => {
    await database.execute(sql`TRUNCATE TABLE draw_events CASCADE`);
  });

  afterAll(async () => {
    await client.close();
  });

  it('keeps creation and polling off through configure and records protected config changes', async () => {
    const configured = await configureDrawEvent(base, {
      database,
      actor: 'operator@example.com',
      reason: 'initial source qualification',
    });
    expect(configured).toMatchObject({ creationEnabled: false, pollingEnabled: false });

    await expect(configureDrawEvent({ ...base, lockAt: new Date('2026-08-09T10:00:00Z') }, {
      database,
      actor: '',
      reason: '',
    })).rejects.toThrow(/actor|reason/i);
    expect((await inspectDrawEvent(base.slug, database)).audit).toHaveLength(1);
  });

  it('certifies source polling without opening creation and exposes provenance', async () => {
    await configureDrawEvent(base, { database, actor: 'andrey', reason: 'qualified fixture' });
    await certifyDrawEvent(base.slug, {
      database,
      actor: 'andrey',
      reason: 'historical parity reviewed',
      pollingEnabled: true,
    });
    const inspected = await inspectDrawEvent(base.slug, database);
    expect(inspected.event).toMatchObject({ pollingEnabled: true, creationEnabled: false });
    expect(inspected.certification).toMatchObject({ actor: 'andrey' });
  });

  it('validates event configuration before persistence', async () => {
    await expect(configureDrawEvent({
      ...base,
      sourcePage: 'https://example.com/wiki/not-allowed',
    }, { database, actor: 'andrey', reason: 'invalid source' })).rejects.toThrow(/allowlisted/);
    await expect(configureDrawEvent({
      ...base,
      tournamentYear: 1999,
    }, { database, actor: 'andrey', reason: 'invalid year' })).rejects.toThrow(/tournamentYear/);
    await expect(configureDrawEvent({
      ...base,
      surface: 'Ice' as 'Grass',
    }, { database, actor: 'andrey', reason: 'invalid surface' })).rejects.toThrow(/surface/);
    await expect(configureDrawEvent({
      ...base,
      completesAt: base.lockAt,
    }, { database, actor: 'andrey', reason: 'invalid dates' })).rejects.toThrow(/completesAt/);
    expect(await database.select().from(drawEvents)).toHaveLength(0);
  });

  it('changes launch flags only for configured source identity and audits the switch', async () => {
    await expect(setDrawEventFlags(base.slug, {}, {
      database,
      actor: 'andrey',
      reason: 'invalid request',
    })).rejects.toThrow(/launch flag/);
    await database.execute(sql`
      INSERT INTO draw_events (
        slug, draw_id, tournament, tournament_year, event_kind, source_page,
        surface, venue, city, lock_at, completes_at
      ) VALUES (
        ${base.slug}, ${base.drawId}, ${base.tournament}, ${base.tournamentYear},
        ${base.eventKind}, ${base.sourcePage}, 'Unknown', 'Unconfigured', 'Unconfigured',
        ${base.lockAt}, ${base.completesAt}
      )
    `);
    await expect(setDrawEventFlags(base.slug, { creationEnabled: true }, {
      database,
      actor: 'andrey',
      reason: 'premature launch',
    })).rejects.toThrow(/source identity/);
    await configureDrawEvent(base, { database, actor: 'andrey', reason: 'qualified source' });
    await setDrawEventFlags(base.slug, { creationEnabled: true }, {
      database,
      actor: 'andrey',
      reason: 'pilot launch',
    });
    const inspected = await inspectDrawEvent(base.slug, database);
    expect(inspected.event.creationEnabled).toBe(true);
    expect(inspected.audit[0]).toMatchObject({ action: 'flags_changed', reason: 'pilot launch' });
  });

  it('distinguishes never-fetched, current, delayed, conflicting, and stale accepted freshness', async () => {
    await configureDrawEvent(base, { database, actor: 'andrey', reason: 'status fixture' });
    expect((await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'))).events[0].state)
      .toBe('never_fetched');

    await database.execute(sql`
      UPDATE draw_events SET
        last_successful_at = '2026-08-11T16:55:00Z',
        last_attempt_at = '2026-08-11T16:55:00Z'
      WHERE slug = ${base.slug}
    `);
    expect((await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'))).events[0].state)
      .toBe('current');

    await database.execute(sql`UPDATE draw_events SET delay_code = 'source_timeout' WHERE slug = ${base.slug}`);
    expect((await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'))).events[0].state)
      .toBe('delayed');

    await database.execute(sql`UPDATE draw_events SET delay_code = 'reconciliation_conflict' WHERE slug = ${base.slug}`);
    expect((await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'))).events[0].state)
      .toBe('conflicting');

    await database.execute(sql`
      UPDATE draw_events SET
        delay_code = NULL,
        last_successful_at = '2026-08-11T16:30:00Z'
      WHERE slug = ${base.slug}
    `);
    expect((await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'))).events[0].state)
      .toBe('stale');
  });

  it('keeps free-text source and projection diagnostics out of public health', async () => {
    await configureDrawEvent(base, { database, actor: 'andrey', reason: 'health fixture' });
    await database.execute(sql`
      UPDATE draw_events SET
        delay_code = 'source_parse_rejected',
        failure_code = 'private parser detail: unexpected bracket near player name',
        projection_failure_code = 'private projection detail: recap unavailable'
      WHERE slug = ${base.slug}
    `);

    const health = await drawSourceHealth(database, new Date('2026-08-11T17:00:00Z'));
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('private parser detail');
    expect(serialized).not.toContain('private projection detail');
    expect(serialized).not.toContain(base.sourcePage);
    expect(serialized).not.toContain('mediawiki-v1');
    expect(health.events[0]).not.toHaveProperty('boundedFailure');
    expect(health.events[0]).not.toHaveProperty('projectionFailureCode');
    expect(health.events[0]).not.toHaveProperty('sourcePage');

    const operatorStatus = await drawSourceOperatorStatus(
      database,
      new Date('2026-08-11T17:00:00Z'),
    );
    expect(operatorStatus.events[0]).toMatchObject({
      failureDetail: 'private parser detail: unexpected bracket near player name',
      projectionFailureDetail: 'private projection detail: recap unavailable',
      sourcePage: base.sourcePage,
    });
  });

  it('executes deployment invariants and exposes stable core-count baselines', async () => {
    await configureDrawEvent(base, { database, actor: 'andrey', reason: 'invariant fixture' });
    const report = await drawDeploymentInvariants(database);
    expect(report).toMatchObject({
      contractVersion: 1,
      ok: true,
      coreCounts: {
        drawEvents: 1,
        drawLeagues: 0,
        drawParticipants: 0,
      },
      violations: {
        invalidHeads: 0,
        invalidSeats: 0,
        duplicateSeats: 0,
        duplicateSubmissionVersions: 0,
        invalidActiveSubmissions: 0,
        orphans: 0,
        rawCapabilityColumns: 0,
        missingRequiredConstraints: 0,
        missingRequiredTriggers: 0,
      },
    });
  });

  it('fails deployment invariants when an append-only trigger is missing', async () => {
    await database.execute(sql`DROP TRIGGER draw_submissions_append_only ON draw_submissions`);
    const report = await drawDeploymentInvariants(database);
    expect(report.ok).toBe(false);
    expect(report.violations.missingRequiredTriggers).toBe(1);
    await database.execute(sql`
      CREATE TRIGGER draw_submissions_append_only
      BEFORE UPDATE OR DELETE ON draw_submissions
      FOR EACH ROW EXECUTE FUNCTION draw_reject_append_only_update()
    `);
  });
});
