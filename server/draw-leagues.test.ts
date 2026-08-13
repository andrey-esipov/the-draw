import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import {
  createDrawLeague,
  DRAW_LEAGUE_PROJECTION_MAX_QUERIES,
  DRAW_SUBMISSION_CONTRACT_VERSION,
  type DrawDatabase,
  inspectDrawInvitation,
  joinDrawLeague,
  queueDrawReturnEmail,
  readDrawDraft,
  readDrawEventAvailability,
  readDrawLeague,
  removeDrawParticipant,
  saveDrawDraft,
  submitDrawBracket,
} from './draw-leagues.js';
import { processNextDrawEmail } from './draw-email-outbox.js';
import * as drawProjections from './draw-projections.js';
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
import { useTestDb as setupTestDb } from './test-pglite.js';

const { withDb } = setupTestDb('draw-leagues');
const secret = 'draw-leagues-test-secret';
const beforeLock = new Date('2026-08-24T14:59:59.999Z');
const atLock = new Date('2026-08-24T15:00:00.000Z');

function fixtureDraw(kind: 'mens_singles' | 'womens_singles', replacement = false): Draw {
  const players = Object.fromEntries(Array.from({ length: 129 }, (_, index) => {
    const id = `p${index + 1}`;
    return [id, { id, name: id, short: id, country: null, seed: null }];
  }));
  const rounds = [64, 32, 16, 8, 4, 2, 1].map((size, roundIndex) => ({
    round: roundIndex + 1,
    name: `Round ${roundIndex + 1}`,
    matches: Array.from({ length: size }, (_, position) => ({
      id: `r${roundIndex + 1}m${position + 1}`,
      round: roundIndex + 1,
      position,
      sides: roundIndex === 0
        ? [
            replacement && position === 0 ? 'p129' : `p${position * 2 + 1}`,
            `p${position * 2 + 2}`,
          ].map((player) => ({ player, seed: null, sets: [] }))
        : [],
      winner: null,
    })),
  }));
  return {
    id: `us-open-2026-${kind}`,
    tournament: 'US Open',
    year: 2026,
    event: kind,
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    bestOf: kind === 'mens_singles' ? 5 : 3,
    source: { wikipedia: kind, url: `https://en.wikipedia.org/wiki/${kind}` },
    players,
    rounds,
  };
}

function revision(draw: Draw, sourceRevisionId: string, checksumCharacter: string): AcceptedDrawRevision {
  return {
    revisionId: sourceRevisionId,
    checksum: checksumCharacter.repeat(64),
    fetchedAt: '2026-08-11T10:00:00.000Z',
    acceptedAt: '2026-08-11T10:01:00.000Z',
    parserVersion: 'u1',
    explicitCorrections: [],
    complete: false,
    draw,
  };
}

async function seedEvent(
  database: Parameters<Parameters<typeof withDb>[0]>[0],
  kind: 'mens_singles' | 'womens_singles' = 'mens_singles',
  creationEnabled = true,
) {
  const slug = kind === 'mens_singles' ? 'us-open-2026-men' : 'us-open-2026-women';
  const [event] = await database.insert(drawEvents).values({
    slug,
    drawId: slug,
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: kind,
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: `https://en.wikipedia.org/wiki/${slug}`,
    lockAt: atLock,
    completesAt: new Date('2026-09-13T23:00:00Z'),
    creationEnabled,
  }).returning();
  await database.insert(drawEventOperationsAudit).values({
    eventId: event!.id,
    action: 'certified',
    actor: 'test-operator',
    reason: 'qualified fixture',
    configuration: {},
  });
  const accepted = revision(fixtureDraw(kind), '101', kind === 'mens_singles' ? 'a' : 'b');
  const [stored] = await database.insert(drawAcceptedRevisions).values({
    eventId: event!.id,
    sourceRevisionId: accepted.revisionId,
    checksum: accepted.checksum,
    fetchedAt: new Date(accepted.fetchedAt),
    acceptedAt: new Date(accepted.acceptedAt),
    parserVersion: accepted.parserVersion,
    payload: accepted,
    explicitCorrections: [],
    complete: false,
  }).returning();
  await database.insert(drawEventHeads).values({
    eventId: event!.id,
    acceptedRevisionId: stored!.id,
    revisionAcceptedAt: stored!.acceptedAt,
    advancedAt: stored!.acceptedAt,
  });
  return { event: event!, revision: stored!, slug };
}

async function seedAwaitingEvent(database: Parameters<Parameters<typeof withDb>[0]>[0]) {
  const slug = 'us-open-2026-men';
  const [event] = await database.insert(drawEvents).values({
    slug,
    drawId: slug,
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: `https://en.wikipedia.org/wiki/${slug}`,
    lockAt: atLock,
    completesAt: new Date('2026-09-13T23:00:00Z'),
    creationEnabled: true,
  }).returning();
  await database.insert(drawEventOperationsAudit).values({
    eventId: event!.id,
    action: 'certified',
    actor: 'test-operator',
    reason: 'qualified fixture awaiting its published draw',
    configuration: {},
  });
  return { event: event!, slug };
}

async function createdLeague(
  database: Parameters<Parameters<typeof withDb>[0]>[0],
  kind: 'mens_singles' | 'womens_singles' = 'mens_singles',
) {
  const seeded = await seedEvent(database, kind);
  const created = await createDrawLeague({
    eventSlug: seeded.slug,
    leagueName: 'Friends',
    displayName: 'Creator',
    idempotencyKey: 'create-request-1',
    ip: '192.0.2.1',
  }, { database, secret, now: () => beforeLock });
  return { ...seeded, ...created };
}

function completePicks(draw: Draw): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const round of draw.rounds) {
    for (const match of round.matches) {
      picks[match.id] = round.round === 1
        ? match.sides[0]!.player
        : picks[`r${round.round - 1}m${match.position * 2 + 1}`]!;
    }
  }
  return picks;
}

describe('Draw league capability service over migrated PGlite', () => {
  it('atomically creates separate event leagues and idempotently returns creator ownership', () => withDb(async (database) => {
    const men = await createdLeague(database);
    const retry = await createDrawLeague({
      eventSlug: men.slug,
      leagueName: 'Friends',
      displayName: 'Creator',
      idempotencyKey: 'create-request-1',
      ip: '192.0.2.1',
    }, { database, secret, now: () => beforeLock });
    const womenEvent = await seedEvent(database, 'womens_singles');
    const women = await createDrawLeague({
      eventSlug: womenEvent.slug,
      leagueName: 'Friends',
      displayName: 'Creator',
      idempotencyKey: 'create-request-1',
      ip: '192.0.2.1',
    }, { database, secret, now: () => beforeLock });
    expect(retry.league.id).toBe(men.league.id);
    expect(women.league.id).not.toBe(men.league.id);
    expect(women.event.eventKind).toBe('womens_singles');
    expect(await database.select().from(drawLeagues)).toHaveLength(2);
    expect(await database.select().from(drawParticipants)).toHaveLength(2);
  }));

  it('keeps creation default-off', () => withDb(async (database) => {
    const event = await seedEvent(database, 'mens_singles', false);
    await expect(createDrawLeague({
      eventSlug: event.slug,
      leagueName: 'Closed',
      displayName: 'Creator',
      idempotencyKey: 'closed-request',
      ip: '192.0.2.2',
    }, { database, secret, now: () => beforeLock })).rejects.toMatchObject({ status: 404 });
    expect(await database.select().from(drawLeagues)).toEqual([]);
  }));

  it('creates a certified upcoming league before its draw is announced and withholds picks', () => withDb(async (database) => {
    const seeded = await seedAwaitingEvent(database);
    expect(await readDrawEventAvailability(seeded.slug, { database })).toEqual({ state: 'awaiting' });

    const created = await createDrawLeague({
      eventSlug: seeded.slug,
      leagueName: 'Waiting room',
      displayName: 'Creator',
      idempotencyKey: 'pre-draw-request',
      ip: '192.0.2.22',
    }, { database, secret, now: () => beforeLock });

    await expect(readDrawDraft({
      leagueId: created.league.id,
      participantId: created.participant.id,
      generation: 0,
    }, { database, secret, now: () => beforeLock })).rejects.toMatchObject({
      code: 'source_unavailable',
      status: 503,
    });
  }));

  it('joins without email, restores a partial draft, and reports revision conflicts explicitly', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const invite = { leagueId: state.league.id, generation: 0 };
    const participant = await joinDrawLeague(invite, {
      displayName: 'Ada',
      idempotencyKey: 'join-request-ada',
      ip: '192.0.2.3',
    }, { database, secret, now: () => beforeLock });
    const capability = { leagueId: state.league.id, participantId: participant.id, generation: 0 };
    const saved = await saveDrawDraft(capability, {
      expectedVersion: 0,
      picks: { r1m1: 'p1' },
    }, { database, secret, now: () => beforeLock });
    expect((await readDrawDraft(capability, { database, secret, now: () => beforeLock })).picks)
      .toEqual({ r1m1: 'p1' });
    await expect(saveDrawDraft(capability, {
      expectedVersion: 0,
      picks: { r1m1: 'p2' },
    }, { database, secret, now: () => beforeLock })).rejects.toMatchObject({
      code: 'draft_conflict',
      details: { currentVersion: saved.version, currentPicks: { r1m1: 'p1' } },
    });
    await database.update(drawLeagues).set({ invitationGeneration: 1 })
      .where(eq(drawLeagues.id, state.league.id));
    await expect(joinDrawLeague(invite, {
      displayName: 'Ada',
      idempotencyKey: 'join-request-ada',
      ip: '192.0.2.3',
    }, { database, secret, now: () => beforeLock })).rejects.toMatchObject({ status: 404 });
  }));

  it('serializes a burst at seat 31, admits one, and creates no orphan state', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const invite = { leagueId: state.league.id, generation: 0 };
    for (let index = 2; index <= 31; index += 1) {
      await joinDrawLeague(invite, {
        displayName: `Player ${index}`,
        idempotencyKey: `join-request-${index}`,
        ip: `192.0.2.${index}`,
      }, { database, secret, now: () => beforeLock });
    }
    const burst = await Promise.allSettled([32, 33].map((index) => joinDrawLeague(invite, {
      displayName: `Player ${index}`,
      idempotencyKey: `join-request-${index}`,
      ip: `198.51.100.${index}`,
    }, { database, secret, now: () => beforeLock })));
    expect(burst.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await database.select().from(drawParticipants)).toHaveLength(32);
    expect(await database.select().from(drawParticipantDrafts)).toEqual([]);
    expect(await database.select().from(drawSubmissions)).toEqual([]);
    expect(await database.select().from(drawEmailOutbox)).toEqual([]);
  }), 30_000);

  it('maps only named participant-seat capacity constraints to the non-disclosing refusal', async () => {
    const input = {
      displayName: 'Ada',
      idempotencyKey: 'join-capacity-mapping',
      ip: '192.0.2.32',
    };
    const capability = { leagueId: '00000000-0000-4000-8000-000000000001', generation: 0 };
    for (const violation of [
      { code: '23505', constraint: 'draw_participants_league_seat_unique' },
      { code: '23514', constraint: 'draw_participants_seat_valid' },
    ]) {
      const database = {
        transaction: async () => {
          throw Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('constraint'), violation) });
        },
      } as unknown as DrawDatabase;
      await expect(joinDrawLeague(capability, input, { database, secret }))
        .rejects.toMatchObject({ code: 'league_full', status: 409 });
    }

    const unrelated = Object.assign(new Error('database unavailable'), {
      code: '08006',
      constraint: 'draw_participants_league_seat_unique',
    });
    const database = {
      transaction: async () => { throw unrelated; },
    } as unknown as DrawDatabase;
    await expect(joinDrawLeague(capability, input, { database, secret })).rejects.toBe(unrelated);
  });

  it('commits one instant before lock and rejects at lock using transaction time', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    await expect(saveDrawDraft(capability, {
      expectedVersion: 0,
      picks: { r1m1: 'p1' },
    }, { database, secret, now: () => beforeLock })).resolves.toMatchObject({ version: 1 });
    await expect(saveDrawDraft(capability, {
      expectedVersion: 1,
      picks: { r1m1: 'p2' },
    }, { database, secret, now: () => atLock })).rejects.toMatchObject({ code: 'locked' });
    expect((await readDrawDraft(capability, { database, secret, now: () => beforeLock })).picks)
      .toEqual({ r1m1: 'p1' });
    await expect(readDrawDraft(capability, { database, secret, now: () => atLock }))
      .rejects.toMatchObject({ code: 'locked' });
  }));

  it('rejects 126 picks and preserves immutable resubmission history plus active pointer', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const draw = fixtureDraw('mens_singles');
    const complete = completePicks(draw);
    const incomplete = { ...complete };
    delete incomplete.r7m1;
    await saveDrawDraft(capability, { expectedVersion: 0, picks: incomplete }, {
      database, secret, now: () => beforeLock,
    });
    await expect(submitDrawBracket(capability, { expectedDraftVersion: 1 }, {
      database, secret, now: () => beforeLock,
    })).rejects.toMatchObject({ code: 'incomplete_bracket' });
    await saveDrawDraft(capability, { expectedVersion: 1, picks: complete }, {
      database, secret, now: () => beforeLock,
    });
    const first = await submitDrawBracket(capability, { expectedDraftVersion: 2 }, {
      database, secret, now: () => beforeLock,
    });
    await expect(submitDrawBracket(capability, { expectedDraftVersion: 2 }, {
      database, secret, now: () => beforeLock,
    })).resolves.toEqual(first);
    const changed = { ...complete, r1m1: 'p2', r2m1: 'p2', r3m1: 'p2', r4m1: 'p2', r5m1: 'p2', r6m1: 'p2', r7m1: 'p2' };
    await saveDrawDraft(capability, { expectedVersion: 2, picks: changed }, {
      database, secret, now: () => beforeLock,
    });
    const second = await submitDrawBracket(capability, { expectedDraftVersion: 3 }, {
      database, secret, now: () => beforeLock,
    });
    const history = await database.select().from(drawSubmissions);
    expect(history).toHaveLength(2);
    expect(history[0]!.picks).toEqual(complete);
    expect(second.version).toBe(2);
    expect((await database.select().from(drawActiveSubmissions))[0]!.submissionId).toBe(second.submissionId);
    expect(first.submissionId).not.toBe(second.submissionId);
  }));

  it('durably bounds participant submissions within an hourly window', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const complete = completePicks(fixtureDraw('mens_singles'));
    const changed = { ...complete, r1m1: 'p2', r2m1: 'p2', r3m1: 'p2', r4m1: 'p2', r5m1: 'p2', r6m1: 'p2', r7m1: 'p2' };
    await saveDrawDraft(capability, {
      expectedVersion: 0,
      picks: complete,
    }, { database, secret, now: () => beforeLock });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (attempt > 0) {
        await saveDrawDraft(capability, {
          expectedVersion: attempt,
          picks: attempt % 2 === 0 ? complete : changed,
        }, { database, secret, now: () => beforeLock });
      }
      await submitDrawBracket(capability, { expectedDraftVersion: attempt + 1 }, {
        database, secret, now: () => beforeLock,
      });
    }
    await saveDrawDraft(capability, {
      expectedVersion: 60,
      picks: complete,
    }, { database, secret, now: () => beforeLock });
    await expect(submitDrawBracket(capability, { expectedDraftVersion: 61 }, {
      database, secret, now: () => beforeLock,
    })).rejects.toMatchObject({ code: 'throttled' });
    expect(await database.select().from(drawSubmissions)).toHaveLength(60);
  }));

  it('invalidates only changed branches and blocks stale-revision submission', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const picks = completePicks(fixtureDraw('mens_singles'));
    await saveDrawDraft(capability, { expectedVersion: 0, picks }, {
      database, secret, now: () => beforeLock,
    });
    const next = revision(fixtureDraw('mens_singles', true), '102', 'c');
    const [stored] = await database.insert(drawAcceptedRevisions).values({
      eventId: state.event.id,
      sourceRevisionId: next.revisionId,
      checksum: next.checksum,
      fetchedAt: new Date(next.fetchedAt),
      acceptedAt: new Date('2026-08-12T10:01:00Z'),
      parserVersion: next.parserVersion,
      payload: { ...next, acceptedAt: '2026-08-12T10:01:00.000Z' },
      explicitCorrections: [],
      complete: false,
    }).returning();
    await database.update(drawEventHeads).set({
      acceptedRevisionId: stored!.id,
      revisionAcceptedAt: stored!.acceptedAt,
      advancedAt: stored!.acceptedAt,
    }).where(eq(drawEventHeads.eventId, state.event.id));
    const draft = await readDrawDraft(capability, { database, secret, now: () => beforeLock });
    expect(draft.affectedMatchIds).toEqual(['r1m1', 'r2m1', 'r3m1', 'r4m1', 'r5m1', 'r6m1', 'r7m1']);
    await expect(submitDrawBracket(capability, { expectedDraftVersion: 1 }, {
      database, secret, now: () => beforeLock,
    })).rejects.toMatchObject({
      code: 'revision_conflict',
      details: { affectedMatchIds: draft.affectedMatchIds },
    });
  }));

  it('keeps competitors private pre-lock and reveals only active complete submissions post-lock', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const joined = await joinDrawLeague({ leagueId: state.league.id, generation: 0 }, {
      displayName: 'Ada',
      idempotencyKey: 'join-private-ada',
      ip: '192.0.2.40',
    }, { database, secret, now: () => beforeLock });
    const creator = { leagueId: state.league.id, participantId: state.participant.id, generation: 0 };
    const other = { leagueId: state.league.id, participantId: joined.id, generation: 0 };
    await saveDrawDraft(creator, { expectedVersion: 0, picks: completePicks(fixtureDraw('mens_singles')) }, {
      database, secret, now: () => beforeLock,
    });
    await submitDrawBracket(creator, { expectedDraftVersion: 1 }, { database, secret, now: () => beforeLock });
    await saveDrawDraft(other, { expectedVersion: 0, picks: { r1m1: 'p1' } }, {
      database, secret, now: () => beforeLock,
    });
    const privateProjection = await readDrawLeague(other, { database, secret, now: () => beforeLock });
    expect(privateProjection).toMatchObject({
      participantCount: 2,
      viewer: {
        draft: { exists: true, version: 1, pickCount: 1 },
        submission: { active: false, complete: false },
      },
      projection: null,
    });
    expect(privateProjection).not.toHaveProperty('participants');
    expect(privateProjection).not.toHaveProperty('submissions');
    let queryCount = 0;
    const boundedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'select') {
          return (...args: Parameters<typeof database.select>) => {
            queryCount += 1;
            return database.select(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const revealed = await readDrawLeague(other, { database: boundedDatabase, secret, now: () => atLock });
    expect(queryCount).toBeLessThanOrEqual(DRAW_LEAGUE_PROJECTION_MAX_QUERIES);
    expect(revealed.projection?.standings).toHaveLength(1);
    expect(revealed.projection?.standings[0]!.participantId).toBe(state.participant.id);
    expect(revealed.projection?.participants.find((participant) => participant.id === joined.id)?.submitted).toBe(false);
    await database.update(drawEvents).set({
      delayCode: 'source_maxlag',
      lastAttemptAt: new Date('2026-08-24T15:03:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-24T15:00:00.000Z'),
    }).where(eq(drawEvents.id, state.event.id));
    const delayed = await readDrawLeague(other, { database, secret, now: () => atLock });
    expect(delayed.projection?.canonical.freshness).toEqual({
      state: 'delayed',
      lastAttemptAt: '2026-08-24T15:03:00.000Z',
      lastSuccessfulAt: '2026-08-24T15:00:00.000Z',
      delayReason: 'source_maxlag',
    });
    await database.update(drawEvents).set({
      delayCode: null,
      lastAttemptAt: new Date('2026-08-24T15:03:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-24T14:40:00.000Z'),
    }).where(eq(drawEvents.id, state.event.id));
    const stale = await readDrawLeague(other, { database, secret, now: () => atLock });
    expect(stale.projection?.canonical.freshness).toMatchObject({
      state: 'stale',
      lastSuccessfulAt: '2026-08-24T14:40:00.000Z',
      delayReason: null,
    });
    const [invalidSubmission] = await database.insert(drawSubmissions).values({
      participantId: state.participant.id,
      leagueId: state.league.id,
      eventId: state.event.id,
      acceptedRevisionId: state.revision.id,
      version: 2,
      contractVersion: DRAW_SUBMISSION_CONTRACT_VERSION,
      checksum: 'f'.repeat(64),
      picks: {},
      validatedAt: new Date('2026-08-24T14:59:59.999Z'),
      createdAt: new Date('2026-08-24T14:59:59.999Z'),
    }).returning();
    await database.update(drawActiveSubmissions).set({ submissionId: invalidSubmission!.id })
      .where(eq(drawActiveSubmissions.participantId, state.participant.id));
    await database.update(drawParticipants).set({ removedAt: new Date('2026-08-24T15:04:00.000Z') })
      .where(eq(drawParticipants.id, state.participant.id));
    const defended = await readDrawLeague(other, { database, secret, now: () => atLock });
    expect(defended.projection?.standings).toEqual([]);
    expect(defended.projection?.participants.find((participant) => participant.id === state.participant.id)).toMatchObject({
      displayName: 'Removed player',
      removed: true,
      submitted: false,
    });
  }));

  it('surfaces a distinct unavailable recap state instead of a fake updating state on projection failure', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const other = { leagueId: state.league.id, participantId: state.participant.id, generation: 0 };
    const spy = vi.spyOn(drawProjections, 'readAndAdvanceDrawRecap').mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const revealed = await readDrawLeague(other, { database, secret, now: () => atLock });
    expect(revealed.projection?.recap).toMatchObject({ state: 'unavailable', acceptedRevisionId: state.revision.id });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('projection_failed'), expect.any(Error));
    spy.mockRestore();
    errorSpy.mockRestore();
    const recovered = await readDrawLeague(other, { database, secret, now: () => atLock });
    expect(recovered.projection?.recap.state).not.toBe('unavailable');
  }));

  it('makes email states explicit, deduplicates, and preserves the participant capability', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    expect(await queueDrawReturnEmail(capability, {
      email: 'Creator@Example.com',
      confirmed: true,
      ip: '192.0.2.50',
      enabled: false,
    }, { database, secret, now: () => beforeLock })).toEqual({ state: 'unavailable' });
    expect(await queueDrawReturnEmail(capability, {
      email: 'Creator@Example.com',
      confirmed: false,
      ip: '192.0.2.50',
      enabled: true,
    }, { database, secret, now: () => beforeLock })).toEqual({ state: 'unconfirmed' });
    const queued = await queueDrawReturnEmail(capability, {
      email: ' Creator@Example.com ',
      confirmed: true,
      ip: '192.0.2.50',
      enabled: true,
    }, { database, secret, now: () => beforeLock });
    expect(queued).toEqual({ state: 'queued' });
    expect(await queueDrawReturnEmail(capability, {
      email: 'creator@example.com',
      confirmed: true,
      ip: '192.0.2.50',
      enabled: true,
    }, { database, secret, now: () => beforeLock })).toEqual({ state: 'queued' });
    expect(await database.select().from(drawEmailOutbox)).toHaveLength(1);
    for (const local of ['two', 'three']) {
      await expect(queueDrawReturnEmail(capability, {
        email: `${local}@example.com`,
        confirmed: true,
        ip: '192.0.2.50',
        enabled: true,
      }, { database, secret, now: () => beforeLock })).resolves.toMatchObject({ state: 'queued' });
    }
    await expect(queueDrawReturnEmail(capability, {
      email: 'four@example.com',
      confirmed: true,
      ip: '192.0.2.50',
      enabled: true,
    }, { database, secret, now: () => beforeLock })).resolves.toEqual({ state: 'throttled' });
    const [queuedRow] = await database.select().from(drawEmailOutbox);
    await database.update(drawEmailOutbox).set({ status: 'failed' })
      .where(eq(drawEmailOutbox.id, queuedRow!.id));
    await expect(queueDrawReturnEmail(capability, {
      email: 'creator@example.com',
      confirmed: true,
      ip: '192.0.2.50',
      enabled: true,
    }, { database, secret, now: () => beforeLock })).resolves.toEqual({ state: 'throttled' });
    expect(await readDrawLeague(capability, { database, secret, now: () => beforeLock })).toMatchObject({
      participantId: state.participant.id,
    });
  }));

  it('enqueues one destination under concurrent and repeated email requests without response disclosure', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const request = () => queueDrawReturnEmail(capability, {
      email: 'private@example.test',
      confirmed: true,
      ip: '192.0.2.71',
      enabled: true,
    }, { database, secret, now: () => beforeLock });
    const responses = await Promise.all([request(), request()]);
    expect(responses).toEqual([{ state: 'queued' }, { state: 'queued' }]);
    expect(await request()).toEqual({ state: 'queued' });
    expect(await database.select().from(drawEmailOutbox)).toHaveLength(1);
    expect(JSON.stringify(responses)).not.toContain('private@example.test');
  }));

  it('atomically requeues one terminal destination and delivers it without disclosure', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const request = () => queueDrawReturnEmail(capability, {
      email: 'private@example.test',
      confirmed: true,
      ip: '192.0.2.72',
      enabled: true,
    }, { database, secret, now: () => beforeLock });
    await request();
    await database.update(drawEmailOutbox).set({
      status: 'failed',
      attempts: 5,
      lastErrorCode: 'delivery_failed',
    });
    const responses = await Promise.all([request(), request(), request()]);
    expect(responses).toEqual([
      { state: 'queued' },
      { state: 'queued' },
      { state: 'queued' },
    ]);
    const rows = await database.select().from(drawEmailOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastErrorCode: null,
      recipientEmail: 'private@example.test',
    });
    const send = vi.fn(async () => undefined);
    expect(await processNextDrawEmail({
      database,
      now: beforeLock,
      secret,
      publicUrl: 'https://draw.example.test',
      send,
    })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(responses)).not.toContain('private@example.test');
  }));

  it('enforces logical expiry across every invitation and participant capability operation', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    const expiry = state.league.expiresAt;
    const dependencies = { database, secret, now: () => expiry };
    await expect(inspectDrawInvitation(capability, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(readDrawDraft(capability, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(readDrawLeague(capability, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(saveDrawDraft(capability, {
      expectedVersion: 0,
      picks: {},
    }, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(submitDrawBracket(capability, {
      expectedDraftVersion: 1,
    }, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(queueDrawReturnEmail(capability, {
      email: 'private@example.test',
      confirmed: true,
      ip: '192.0.2.70',
      enabled: true,
    }, dependencies)).rejects.toMatchObject({ status: 404 });
    await expect(removeDrawParticipant(capability, dependencies)).rejects.toMatchObject({ status: 404 });
    expect(await database.select().from(drawLeagues)).toHaveLength(1);
  }));

  it('anonymizes queued identity, preserves seat and submission, bumps generation, and denies expiry', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const capability = {
      leagueId: state.league.id,
      participantId: state.participant.id,
      generation: 0,
    };
    await saveDrawDraft(capability, { expectedVersion: 0, picks: completePicks(fixtureDraw('mens_singles')) }, {
      database, secret, now: () => beforeLock,
    });
    await submitDrawBracket(capability, { expectedDraftVersion: 1 }, { database, secret, now: () => beforeLock });
    await queueDrawReturnEmail(capability, {
      email: 'creator@example.com',
      confirmed: true,
      ip: '192.0.2.60',
      enabled: true,
    }, { database, secret, now: () => beforeLock });
    await removeDrawParticipant(capability, { database, secret, now: () => beforeLock });
    const [participant] = await database.select().from(drawParticipants);
    const [outbox] = await database.select().from(drawEmailOutbox);
    expect(participant).toMatchObject({
      seat: 1,
      displayName: 'Removed player',
      returnGeneration: 1,
    });
    expect(outbox).toMatchObject({
      participantId: null,
      recipientEmail: null,
      status: 'failed',
      lastErrorCode: 'participant_removed',
    });
    expect(await database.select().from(drawSubmissions)).toHaveLength(1);
    await expect(readDrawLeague(capability, { database, secret, now: () => beforeLock }))
      .rejects.toMatchObject({ status: 404 });
    const expiry = new Date('2027-10-13T23:00:00Z');
    await expect(inspectDrawInvitation({ leagueId: state.league.id, generation: 0 }, {
      database, secret, now: () => expiry,
    })).rejects.toMatchObject({ status: 404 });
  }));

  it('never persists raw bearer-shaped material or offers participant discovery through invitation access', () => withDb(async (database) => {
    const state = await createdLeague(database);
    const invitation = await inspectDrawInvitation({ leagueId: state.league.id, generation: 0 }, {
      database, secret, now: () => beforeLock,
    });
    expect(invitation).not.toHaveProperty('participants');
    expect(invitation).not.toHaveProperty('draft');
    const raw = JSON.stringify({
      leagues: await database.execute(sql`SELECT * FROM draw_leagues`),
      participants: await database.execute(sql`SELECT * FROM draw_participants`),
    });
    expect(raw).not.toContain('eyJ');
    expect(Object.keys(invitation)).toEqual([
      'leagueId', 'leagueName', 'event', 'seatsRemaining', 'lockAt',
    ]);
  }));
});
