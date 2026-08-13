import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { db } from './db.js';
import {
  createDrawIngestionWorker,
  pollDrawEvent,
  startDrawIngestionMaintenance,
  type DrawSourceFetch,
} from './draw-ingestion.js';
import {
  drawAcceptedRevisions,
  drawEventHeads,
  drawEvents,
} from './schema.js';

const sourcePage = 'https://en.wikipedia.org/wiki/2026_Wimbledon_Championships_%E2%80%93_Men%27s_singles';
const fixtures = resolve(process.cwd(), 'tools/fixtures/mediawiki');
const partial = readFileSync(resolve(fixtures, 'partial-mid-round.wiki'));
const complete = readFileSync(resolve(fixtures, 'complete-wimbledon-men.wiki'));
const corrected = readFileSync(resolve(fixtures, 'corrected-revision.wiki'));
const withdrawal = readFileSync(resolve(fixtures, 'pre-lock-withdrawal.wiki'));

let client: PGlite;
let database: typeof db;

function metadata(revisionId: string, comment = '') {
  return {
    query: {
      pages: [{
        pageid: 1,
        title: '2026 Wimbledon Championships – Men’s singles',
        revisions: [{ revid: Number(revisionId), timestamp: '2026-08-11T16:00:00Z', comment }],
      }],
    },
  };
}

function revision(revisionId: string, content: Buffer) {
  return {
    query: {
      pages: [{
        pageid: 1,
        title: '2026 Wimbledon Championships – Men’s singles',
        revisions: [{
          revid: Number(revisionId),
          timestamp: '2026-08-11T16:00:00Z',
          slots: { main: { content: content.toString('utf8') } },
        }],
      }],
    },
  };
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

function sourceFetch(revisionId: string, content: Buffer, comment = ''): DrawSourceFetch {
  return vi.fn(async (url) => {
    const target = new URL(String(url));
    return target.searchParams.has('revids')
      ? json(revision(revisionId, content))
      : json(metadata(revisionId, comment), {
        headers: {
          'content-type': 'application/json',
          etag: `"${revisionId}"`,
          'last-modified': 'Tue, 11 Aug 2026 16:00:00 GMT',
        },
      });
  });
}

async function event(overrides: Partial<typeof drawEvents.$inferInsert> = {}) {
  const [created] = await database.insert(drawEvents).values({
    slug: `wimbledon-men-${crypto.randomUUID()}`,
    drawId: 'wimbledon-2026-men',
    tournament: 'Wimbledon',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Grass',
    venue: 'All England Lawn Tennis and Croquet Club',
    city: 'London',
    sourcePage,
    lockAt: new Date('2026-08-10T10:00:00Z'),
    completesAt: new Date('2026-08-20T20:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    pollingEnabled: true,
    ...overrides,
  }).returning();
  return created;
}

const dependencies = (fetch: DrawSourceFetch, now = new Date('2026-08-11T17:00:00Z')) => ({
  database,
  fetch,
  lookup: vi.fn(async () => ['208.80.154.224']),
  now: () => now,
  userAgent: 'TheDraw/1.0 (source-operations@the-draw.replit.app)',
  deadlineMs: 5_000,
});

describe('Draw source ingestion', () => {
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

  it('accepts a changed safe revision and advances the same-event head atomically once', async () => {
    const configured = await event();
    const result = await pollDrawEvent(configured.id, dependencies(sourceFetch('101', partial)));
    expect(result).toMatchObject({ state: 'accepted', revisionId: '101' });

    const revisions = await database.select().from(drawAcceptedRevisions);
    const heads = await database.select().from(drawEventHeads);
    expect(revisions).toHaveLength(1);
    expect(heads).toHaveLength(1);
    expect(heads[0].acceptedRevisionId).toBe(revisions[0].id);
    expect((revisions[0].payload as { acceptedAt: string }).acceptedAt).toBeTruthy();
  });

  it('skips an unchanged revision ID while recording source freshness and conditional headers', async () => {
    const configured = await event();
    await pollDrawEvent(configured.id, dependencies(sourceFetch('101', partial)));
    const fetch = sourceFetch('101', partial);
    const result = await pollDrawEvent(configured.id, dependencies(fetch));

    expect(result.state).toBe('unchanged');
    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.get('user-agent')).toContain('TheDraw/');
    expect(headers.get('if-modified-since')).toBeTruthy();
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).searchParams.get('maxlag')).toBe('5');
    expect(await database.select().from(drawAcceptedRevisions)).toHaveLength(1);
  });

  it('records freshness when a new source revision parses to the same canonical draw', async () => {
    const configured = await event();
    await pollDrawEvent(
      configured.id,
      dependencies(sourceFetch('101', partial), new Date('2026-08-11T17:00:00Z')),
    );
    await database.update(drawEvents).set({
      delayCode: 'source_timeout',
      failureCode: 'prior failure',
    }).where(eq(drawEvents.id, configured.id));
    const refreshedAt = new Date('2026-08-11T17:05:00Z');
    const result = await pollDrawEvent(
      configured.id,
      dependencies(sourceFetch('102', partial), refreshedAt),
    );
    expect(result).toMatchObject({ state: 'unchanged', revisionId: '101' });
    const [status] = await database.select().from(drawEvents).where(eq(drawEvents.id, configured.id));
    expect(status).toMatchObject({
      lastAttemptAt: refreshedAt,
      lastSuccessfulAt: refreshedAt,
      delayCode: null,
      failureCode: null,
    });
    expect(await database.select().from(drawAcceptedRevisions)).toHaveLength(1);
  });

  it('preserves canonical state on timeout, 429, malformed source, and reconciliation conflict', async () => {
    const configured = await event();
    await pollDrawEvent(configured.id, dependencies(sourceFetch('101', complete)));
    const prior = (await database.select().from(drawEventHeads))[0];
    const failures: DrawSourceFetch[] = [
      vi.fn(() => new Promise<Response>(() => undefined)),
      vi.fn(async () => new Response('', { status: 429 })),
      vi.fn(async () => json({ query: { pages: [] } })),
      sourceFetch('102', partial),
    ];
    for (const fetch of failures) {
      await pollDrawEvent(configured.id, dependencies(fetch));
      expect((await database.select().from(drawEventHeads))[0]).toEqual(prior);
    }
    const [status] = await database.select().from(drawEvents).where(eq(drawEvents.id, configured.id));
    expect(status.delayCode).toBeTruthy();
    expect(status.failureCode?.length).toBeLessThanOrEqual(500);
  });

  it('recognizes MediaWiki maxlag responses and preserves the accepted head', async () => {
    const configured = await event();
    await pollDrawEvent(configured.id, dependencies(sourceFetch('101', complete)));
    const prior = (await database.select().from(drawEventHeads))[0];
    const responses = [
      json({ error: { code: 'maxlag', info: 'Waiting for replicas', lag: 8 } }),
      json(
        { error: { code: 'maxlag', info: 'Waiting for replicas', lag: 8 } },
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5' } },
      ),
    ];

    for (const response of responses) {
      const result = await pollDrawEvent(
        configured.id,
        dependencies(vi.fn(async () => response.clone())),
      );
      expect(result).toMatchObject({ state: 'delayed', delayCode: 'source_maxlag' });
      expect((await database.select().from(drawEventHeads))[0]).toEqual(prior);
    }
  });

  it('does not misclassify a generic 503 as MediaWiki maxlag', async () => {
    const configured = await event();
    const result = await pollDrawEvent(
      configured.id,
      dependencies(vi.fn(async () => json(
        { error: { code: 'readonly', info: 'Maintenance' } },
        { status: 503 },
      ))),
    );
    expect(result).toMatchObject({ state: 'delayed', delayCode: 'source_http_error' });
  });

  it('accepts a source-attributed correction once and retains both immutable revisions', async () => {
    const configured = await event();
    await pollDrawEvent(configured.id, dependencies(sourceFetch('100', complete)));
    const correctionFetch = sourceFetch('104', corrected, 'Correction to r1m2 result');
    const correctionResult = await pollDrawEvent(configured.id, dependencies(correctionFetch));
    expect(correctionResult)
      .toMatchObject({ state: 'accepted', classification: 'correction' });
    expect(await pollDrawEvent(configured.id, dependencies(correctionFetch)))
      .toMatchObject({ state: 'unchanged' });
    expect(await database.select().from(drawAcceptedRevisions)).toHaveLength(2);
  });

  it('rechecks the lock boundary inside acceptance after a slow source fetch', async () => {
    const configured = await event({ lockAt: new Date('2026-08-11T17:00:05Z') });
    await pollDrawEvent(
      configured.id,
      dependencies(sourceFetch('102', complete), new Date('2026-08-11T17:00:00Z')),
    );
    const prior = (await database.select().from(drawEventHeads))[0];
    const times = [
      new Date('2026-08-11T17:00:04Z'),
      new Date('2026-08-11T17:00:06Z'),
    ];
    const result = await pollDrawEvent(configured.id, {
      ...dependencies(sourceFetch('103', withdrawal)),
      now: () => times.shift() ?? new Date('2026-08-11T17:00:06Z'),
    });
    expect(result).toMatchObject({ state: 'delayed', delayCode: 'reconciliation_conflict' });
    expect((await database.select().from(drawEventHeads))[0]).toEqual(prior);
  });

  it('coalesces overlapping triggers into one polling pass', async () => {
    await event();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async (url: string | URL) => {
      await blocked;
      return new URL(String(url)).searchParams.has('revids')
        ? json(revision('101', partial))
        : json(metadata('101'));
    });
    const worker = createDrawIngestionWorker(dependencies(fetch));
    const first = worker.run();
    const second = worker.run();
    release();
    expect(second).toBe(first);
    await first;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not poll events outside their configured active window', async () => {
    await event({ createdAt: new Date('2026-08-12T00:00:00Z') });
    await event({
      drawId: 'wimbledon-2026-women',
      sourcePage: sourcePage.replace('Men%27s', 'Women%27s'),
      completesAt: new Date('2026-08-11T16:00:00Z'),
    });
    const fetch = sourceFetch('101', partial);
    await createDrawIngestionWorker(dependencies(fetch)).run();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('defers source polls until Retry-After expires', async () => {
    await event();
    let now = new Date('2026-08-11T17:00:00Z');
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': '120' } }))
      .mockImplementation(sourceFetch('101', partial));
    const worker = createDrawIngestionWorker({
      ...dependencies(fetch),
      now: () => now,
    });
    expect(await worker.run()).toMatchObject([{ state: 'delayed', retryAfterMs: 120_000 }]);
    now = new Date('2026-08-11T17:01:00Z');
    expect(await worker.run()).toMatchObject([{ state: 'skipped', delayCode: 'source_backoff' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = new Date('2026-08-11T17:02:01Z');
    expect(await worker.run()).toMatchObject([{ state: 'accepted' }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports maintenance failures instead of dropping rejected worker promises', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = {
      select: () => ({
        from: () => ({
          where: async () => { throw new Error('database unavailable'); },
        }),
      }),
    } as unknown as typeof db;
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    startDrawIngestionMaintenance({
      database,
      workerEnabled: true,
      setInterval: vi.fn(() => timer) as unknown as typeof setInterval,
    });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      '[draw-ingestion] pass_failed reason=source_worker_failed',
    ));
  });

  it.each([
    ['off-host redirect', async () => new Response('', { status: 302, headers: { location: 'https://evil.example/api' } })],
    ['redirect loop', async () => new Response('', { status: 302, headers: { location: 'https://en.wikipedia.org/w/api.php' } })],
    ['unexpected content', async () => new Response('no', { headers: { 'content-type': 'text/html' } })],
    ['oversized response', async () => new Response('x'.repeat(2_400_000), { headers: { 'content-type': 'application/json' } })],
    ['compressed bomb', async () => new Response('x'.repeat(2_200_000), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '100' } })],
    ['invalid encoding', async () => new Response(Uint8Array.from([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } })],
    ['deep nesting', async () => json(revision('102', Buffer.from('{{'.repeat(70) + '}}'.repeat(70))))],
  ])('fails closed for %s', async (_name, implementation) => {
    const configured = await event();
    const result = await pollDrawEvent(configured.id, dependencies(vi.fn(implementation)));
    expect(result.state).toBe('delayed');
    expect(await database.select().from(drawEventHeads)).toHaveLength(0);
  });

  it('fails DNS rebinding and private-network resolution before a source request', async () => {
    const configured = await event();
    const fetch = sourceFetch('101', partial);
    const lookup = vi.fn()
      .mockResolvedValueOnce(['208.80.154.224'])
      .mockResolvedValueOnce(['127.0.0.1']);
    const result = await pollDrawEvent(configured.id, { ...dependencies(fetch), lookup });
    expect(result.state).toBe('delayed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await database.select().from(drawEventHeads)).toHaveLength(0);
  });

  it('fails a parser deadline without changing the accepted head', async () => {
    const configured = await event();
    await pollDrawEvent(configured.id, dependencies(sourceFetch('101', partial)));
    const prior = (await database.select().from(drawEventHeads))[0];
    let milliseconds = Date.parse('2026-08-11T17:00:00Z');
    const result = await pollDrawEvent(configured.id, {
      ...dependencies(sourceFetch('102', complete)),
      monotonicNow: () => (milliseconds += 60),
      deadlineMs: 50,
    });
    expect(result.state).toBe('delayed');
    expect((await database.select().from(drawEventHeads))[0]).toEqual(prior);
  });

  it('commits canonical acceptance when projection fails and reports projection lag', async () => {
    const configured = await event();
    const result = await pollDrawEvent(configured.id, {
      ...dependencies(sourceFetch('101', partial)),
      projectAccepted: vi.fn(async () => { throw new Error('recap unavailable'); }),
    });
    expect(result).toMatchObject({ state: 'accepted', projectionLag: true });
    expect(await database.select().from(drawEventHeads)).toHaveLength(1);
  });
});
