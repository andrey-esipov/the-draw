import { describe, expect, it, vi } from 'vitest';
import {
  drawEmailHealth,
  processDrawEmailPass,
  processNextDrawEmail,
  startDrawEmailDelivery,
} from './draw-email-outbox.js';
import { drawEmailOutbox, drawEvents, drawLeagues, drawParticipants } from './schema.js';
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-email-outbox');
const now = new Date('2026-08-20T12:00:00Z');

async function seedQueued(database: Parameters<Parameters<typeof withDb>[0]>[0]) {
  const [event] = await database.insert(drawEvents).values({
    slug: 'us-open-email',
    drawId: 'us-open-email',
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: 'https://en.wikipedia.org/wiki/us-open-email',
    lockAt: new Date('2026-08-24T15:00:00Z'),
    completesAt: new Date('2026-09-13T23:00:00Z'),
  }).returning();
  const [league] = await database.insert(drawLeagues).values({
    eventId: event!.id,
    name: 'Friends',
    expiresAt: new Date('2027-10-13T23:00:00Z'),
  }).returning();
  const [participant] = await database.insert(drawParticipants).values({
    leagueId: league!.id,
    seat: 1,
    displayName: 'Ada',
  }).returning();
  await database.insert(drawEmailOutbox).values({
    leagueId: league!.id,
    participantId: participant!.id,
    kind: 'return_link',
    recipientEmail: 'ada@example.com',
    recipientHash: 'a'.repeat(64),
    status: 'pending',
    availableAt: now,
  });
  return { league: league!, participant: participant! };
}

describe('Draw transactional email outbox', () => {
  it('claims once and sends only the minimum destination plus fragment return link', () => withDb(async (database) => {
    await seedQueued(database);
    const send = vi.fn(async (_input: { to: string; returnLink: string; idempotencyKey: string }) => undefined);
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('sent');
    expect(send).toHaveBeenCalledWith({
      to: 'ada@example.com',
      returnLink: expect.stringMatching(/^https:\/\/draw\.example\.test\/#return=/),
      idempotencyKey: expect.any(String),
    });
    const sentArgument = send.mock.calls[0]![0];
    expect(sentArgument.returnLink).not.toContain('?');
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('empty');
  }));

  it('records bounded provider failure codes and retries without logging bearer material', () => withDb(async (database) => {
    await seedQueued(database);
    const attemptedKeys: string[] = [];
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send: async ({ idempotencyKey }) => {
        attemptedKeys.push(idempotencyKey);
        throw new Error('provider included raw secret that must not persist');
      },
    })).toBe('retry');
    const [row] = await database.select().from(drawEmailOutbox);
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'delivery_failed',
    });
    expect(JSON.stringify(row)).not.toContain('provider included');
    expect(JSON.stringify(row)).not.toContain('/#return=');
    await database.update(drawEmailOutbox).set({ availableAt: now });
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send: async ({ idempotencyKey }) => { attemptedKeys.push(idempotencyKey); },
    })).toBe('sent');
    expect(attemptedKeys).toEqual([row!.id, row!.id]);
  }));

  it('uses compare-and-set so concurrent drains deliver one message', () => withDb(async (database) => {
    await seedQueued(database);
    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const beforeClaim = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier?.();
      await barrier;
    };
    const send = vi.fn(async () => undefined);
    const input = {
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
      beforeClaim,
    };
    expect(await Promise.all([
      processNextDrawEmail(input),
      processNextDrawEmail(input),
    ])).toEqual(expect.arrayContaining(['sent', 'empty']));
    expect(send).toHaveBeenCalledTimes(1);
  }));

  it('fails closed if removal wins before delivery', () => withDb(async (database) => {
    const state = await seedQueued(database);
    await database.update(drawParticipants).set({
      displayName: 'Removed player',
      removedAt: now,
      returnGeneration: 1,
    });
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send: vi.fn(async () => undefined),
    })).toBe('failed');
    expect((await database.select().from(drawEmailOutbox))[0]).toMatchObject({
      status: 'failed',
      lastErrorCode: 'participant_unavailable',
    });
    expect(state.participant.seat).toBe(1);
  }));

  it('requires the canary, bounds each drain pass, and exposes retry backlog without blocking reads', () => withDb(async (database) => {
    await seedQueued(database);
    expect(startDrawEmailDelivery({
      database,
      workerEnabled: true,
      canaryProven: false,
      send: vi.fn(async () => undefined),
    })).toBeNull();
    expect(await processDrawEmailPass({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      limit: 1,
      send: async () => { throw new Error('private provider response'); },
    })).toEqual({ processed: 1, sent: 0, retries: 1, failed: 0 });
    expect(await drawEmailHealth(
      database,
      new Date(now.getTime() + 16 * 60_000),
      true,
      true,
      true,
    )).toMatchObject({
      state: 'unhealthy',
      backlog: 1,
      retries: 1,
      terminalFailures: 0,
    });
    expect(await drawEmailHealth(database, now, false, false)).toMatchObject({
      state: 'disabled',
      enabled: false,
      backlog: 1,
    });
  }));

  it('surfaces terminal provider failure with a bounded reason code', () => withDb(async (database) => {
    await seedQueued(database);
    await database.update(drawEmailOutbox).set({ attempts: 4 });
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send: async () => { throw new Error('provider response with private detail'); },
    })).toBe('failed');
    expect((await database.select().from(drawEmailOutbox))[0]).toMatchObject({
      status: 'failed',
      attempts: 5,
      lastErrorCode: 'delivery_failed',
    });
    expect(await drawEmailHealth(database, now, true, true, true)).toMatchObject({
      state: 'unhealthy',
      terminalFailures: 1,
    });
  }));

  it('counts a stale reclaim failure as one delivery attempt and stops at five', () => withDb(async (database) => {
    await seedQueued(database);
    await database.update(drawEmailOutbox).set({
      status: 'sending',
      attempts: 4,
      claimedAt: new Date(now.getTime() - 6 * 60_000),
    });
    const send = vi.fn(async () => { throw new Error('provider failure'); });
    expect(await processNextDrawEmail({
      database,
      now,
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await database.select().from(drawEmailOutbox))[0]).toMatchObject({
      status: 'failed',
      attempts: 5,
      lastErrorCode: 'delivery_failed',
    });
    expect(await processNextDrawEmail({
      database,
      now: new Date(now.getTime() + 6 * 60_000),
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('empty');
    expect(send).toHaveBeenCalledTimes(1);
  }));

  it('never sends a delayed link after the league expires', () => withDb(async (database) => {
    await seedQueued(database);
    const send = vi.fn(async () => undefined);
    expect(await processNextDrawEmail({
      database,
      now: new Date('2027-10-13T23:00:00Z'),
      secret: 'draw-email-secret',
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect((await database.select().from(drawEmailOutbox))[0]).toMatchObject({
      lastErrorCode: 'participant_unavailable',
    });
  }));
});
