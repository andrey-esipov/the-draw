import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalPostgres, type LocalPostgres } from '../scripts/lib/local-postgres';
import {
  DrawApiError,
  joinDrawLeague,
  queueDrawReturnEmail,
  removeDrawParticipant,
} from './draw-leagues';
import * as schema from './schema';
import {
  drawEmailOutbox,
  drawEngagementEvents,
  drawEvents,
  drawLeagues,
  drawParticipantDrafts,
  drawParticipants,
  drawSubmissions,
} from './schema';

let pg: LocalPostgres;
let adminClient: postgres.Sql;
let firstJoinClient: postgres.Sql;
let secondJoinClient: postgres.Sql;
let adminDb: ReturnType<typeof drizzlePg<typeof schema>>;
let firstJoinDb: ReturnType<typeof drizzlePg<typeof schema>>;
let secondJoinDb: ReturnType<typeof drizzlePg<typeof schema>>;

const now = new Date('2026-08-11T12:00:00.000Z');
const secret = 'draw-league-postgres-contention-secret';

beforeAll(async () => {
  pg = await startLocalPostgres({
    dataDir: join(process.cwd(), `.draw-league-postgres-${randomUUID()}`),
  });
  adminClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  firstJoinClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  secondJoinClient = postgres(pg.url, { max: 1, onnotice: () => {} });
  adminDb = drizzlePg(adminClient, { schema });
  firstJoinDb = drizzlePg(firstJoinClient, { schema });
  secondJoinDb = drizzlePg(secondJoinClient, { schema });
  await migrate(adminDb, { migrationsFolder: join(process.cwd(), 'drizzle') });
}, 300_000);

afterAll(async () => {
  await Promise.all([
    adminClient?.end({ timeout: 5 }),
    firstJoinClient?.end({ timeout: 5 }),
    secondJoinClient?.end({ timeout: 5 }),
  ]);
  await pg?.stop();
});

describe('draw league production-Postgres contention', () => {
  it('admits exactly one concurrent join at seat 31 without orphan state', async () => {
    const [event] = await adminDb.insert(drawEvents).values({
      slug: `contention-${randomUUID()}`,
      drawId: `contention-${randomUUID()}`,
      tournament: 'US Open',
      tournamentYear: 2026,
      eventKind: 'mens_singles',
      surface: 'Hard',
      venue: 'USTA',
      city: 'New York',
      sourcePage: `https://example.com/${randomUUID()}`,
      lockAt: new Date('2026-08-24T15:00:00.000Z'),
      completesAt: new Date('2026-09-13T23:00:00.000Z'),
      creationEnabled: true,
    }).returning();
    const [league] = await adminDb.insert(drawLeagues).values({
      eventId: event!.id,
      name: 'Contention proof',
      expiresAt: new Date('2027-10-13T23:00:00.000Z'),
    }).returning();
    await adminDb.insert(drawParticipants).values(Array.from({ length: 31 }, (_, index) => ({
      leagueId: league!.id,
      seat: index + 1,
      displayName: `Player ${index + 1}`,
      isCreator: index === 0,
    })));

    const [firstBackend] = await firstJoinClient<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [secondBackend] = await secondJoinClient<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(firstBackend!.pid).not.toBe(secondBackend!.pid);

    const invite = { leagueId: league!.id, generation: 0 };
    const attempts = await Promise.allSettled([
      joinDrawLeague(invite, {
        displayName: 'Seat 32 A',
        idempotencyKey: 'seat-32-attempt-a',
        ip: '198.51.100.32',
      }, { database: firstJoinDb, secret, now: () => now }),
      joinDrawLeague(invite, {
        displayName: 'Seat 32 B',
        idempotencyKey: 'seat-32-attempt-b',
        ip: '198.51.100.33',
      }, { database: secondJoinDb, secret, now: () => now }),
    ]);

    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ value: { seat: 32 } });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining<Partial<DrawApiError>>({ code: 'league_full', status: 409 }),
    });

    const [participantCount] = await adminDb.select({ value: count() }).from(drawParticipants)
      .where(eq(drawParticipants.leagueId, league!.id));
    expect(participantCount!.value).toBe(32);
    expect(await adminDb.select().from(drawParticipantDrafts)).toEqual([]);
    expect(await adminDb.select().from(drawSubmissions)).toEqual([]);
    expect(await adminDb.select().from(drawEmailOutbox)).toEqual([]);
    expect(await adminDb.select().from(drawEngagementEvents)).toEqual([]);
  });

  it('never retains a destination when return-email queueing races removal', async () => {
    const [event] = await adminDb.insert(drawEvents).values({
      slug: `removal-${randomUUID()}`,
      drawId: `removal-${randomUUID()}`,
      tournament: 'US Open',
      tournamentYear: 2026,
      eventKind: 'mens_singles',
      surface: 'Hard',
      venue: 'USTA',
      city: 'New York',
      sourcePage: `https://example.com/${randomUUID()}`,
      lockAt: new Date('2026-08-24T15:00:00.000Z'),
      completesAt: new Date('2026-09-13T23:00:00.000Z'),
      creationEnabled: true,
    }).returning();
    const [league] = await adminDb.insert(drawLeagues).values({
      eventId: event!.id,
      name: 'Removal contention proof',
      expiresAt: new Date('2027-10-13T23:00:00.000Z'),
    }).returning();
    const [participant] = await adminDb.insert(drawParticipants).values({
      leagueId: league!.id,
      seat: 1,
      displayName: 'Creator',
      isCreator: true,
    }).returning();
    const capability = {
      leagueId: league!.id,
      participantId: participant!.id,
      generation: 0,
    };

    await Promise.allSettled([
      queueDrawReturnEmail(capability, {
        email: 'removed@example.com',
        confirmed: true,
        ip: '198.51.100.41',
        enabled: true,
      }, { database: firstJoinDb, secret, now: () => now }),
      removeDrawParticipant(capability, { database: secondJoinDb, secret, now: () => now }),
    ]);

    const rows = await adminDb.select().from(drawEmailOutbox)
      .where(eq(drawEmailOutbox.leagueId, league!.id));
    expect(rows.every((row) => row.recipientEmail === null && row.participantId === null)).toBe(true);
  });
});
