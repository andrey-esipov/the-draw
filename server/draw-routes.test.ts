import express from 'express';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcceptedDrawRevision, Draw } from '../shared/draw/contracts.js';
import { mountDrawRoutes } from './draw-routes.js';
import {
  drawAcceptedRevisions,
  drawEngagementEvents,
  drawEventHeads,
  drawEventOperationsAudit,
  drawEvents,
} from './schema.js';
import { useTestDb as setupTestDb } from './test-pglite.js';

const servers: Server[] = [];
const { withDb } = setupTestDb('draw-routes');

async function request(app: express.Express, path: string, init: RequestInit = {}) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fixtureDraw(): Draw {
  const players = Object.fromEntries(Array.from({ length: 128 }, (_, index) => {
    const id = `p${index + 1}`;
    return [id, { id, name: id, short: id, country: null, seed: null }];
  }));
  return {
    id: 'us-open-men',
    tournament: 'US Open',
    year: 2026,
    event: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    bestOf: 5,
    source: { wikipedia: 'fixture', url: 'https://en.wikipedia.org/wiki/fixture' },
    players,
    rounds: [64, 32, 16, 8, 4, 2, 1].map((size, roundIndex) => ({
      round: roundIndex + 1,
      name: `Round ${roundIndex + 1}`,
      matches: Array.from({ length: size }, (_, position) => ({
        id: `r${roundIndex + 1}m${position + 1}`,
        round: roundIndex + 1,
        position,
        sides: roundIndex === 0
          ? [`p${position * 2 + 1}`, `p${position * 2 + 2}`]
              .map((player) => ({ player, seed: null, sets: [] }))
          : [],
        winner: null,
      })),
    })),
  };
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

function completedThrough(roundLimit: number): Draw {
  const draw = structuredClone(fixtureDraw());
  for (const round of draw.rounds) {
    if (round.round > roundLimit) break;
    for (const match of round.matches) {
      if (round.round > 1) {
        const previous = draw.rounds[round.round - 2]!;
        match.sides = [
          previous.matches[match.position * 2]!.winner!,
          previous.matches[match.position * 2 + 1]!.winner!,
        ].map((player) => ({ player, seed: null, sets: [] }));
      }
      match.winner = match.sides[0]!.player;
      match.terminal = 'completed';
    }
  }
  return draw;
}

async function seedApiEvent(database: Parameters<Parameters<typeof withDb>[0]>[0]) {
  const [event] = await database.insert(drawEvents).values({
    slug: 'us-open-2026-men',
    drawId: 'us-open-2026-men',
    tournament: 'US Open',
    tournamentYear: 2026,
    eventKind: 'mens_singles',
    surface: 'Hard',
    venue: 'USTA',
    city: 'New York',
    sourcePage: 'https://en.wikipedia.org/wiki/us-open-2026-men',
    lockAt: new Date('2026-08-24T15:00:00Z'),
    completesAt: new Date('2026-09-13T23:00:00Z'),
    creationEnabled: true,
  }).returning();
  await database.insert(drawEventOperationsAudit).values({
    eventId: event!.id,
    action: 'certified',
    actor: 'test',
    reason: 'qualified',
    configuration: {},
  });
  const payload: AcceptedDrawRevision = {
    revisionId: '101',
    checksum: 'a'.repeat(64),
    fetchedAt: '2026-08-11T10:00:00.000Z',
    acceptedAt: '2026-08-11T10:01:00.000Z',
    parserVersion: 'u1',
    explicitCorrections: [],
    complete: false,
    draw: fixtureDraw(),
  };
  const [revision] = await database.insert(drawAcceptedRevisions).values({
    eventId: event!.id,
    sourceRevisionId: payload.revisionId,
    checksum: payload.checksum,
    fetchedAt: new Date(payload.fetchedAt),
    acceptedAt: new Date(payload.acceptedAt),
    parserVersion: payload.parserVersion,
    payload,
    explicitCorrections: [],
    complete: false,
  }).returning();
  await database.insert(drawEventHeads).values({
    eventId: event!.id,
    acceptedRevisionId: revision!.id,
    revisionAcceptedAt: revision!.acceptedAt,
    advancedAt: revision!.acceptedAt,
  });
}

async function duplicateAuthorization(app: express.Express): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  return new Promise((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1', () => {
      socket.write([
        'GET /api/draw/league HTTP/1.1',
        `Host: 127.0.0.1:${address.port}`,
        'Authorization: Bearer one',
        'Authorization: Bearer two',
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    let response = '';
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

describe('Draw public route boundary', () => {
  it('mounts before Studio auth and generic API 404', async () => {
    const app = express();
    mountDrawRoutes(app, {
      database: {} as never,
      publicUrl: 'https://draw.example.test',
      secret: 'route-test-secret',
    });
    app.use('/api', (_req, res) => res.status(401).json({ error: 'studio_auth' }));
    const response = await request(app, '/api/draw/league');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain('Authorization');
    expect(await response.json()).toEqual({ error: 'not_found' });
    const recovery = await request(app, '/api/draw/recover');
    expect(recovery.status).toBe(404);
    expect(await recovery.json()).toEqual({ error: 'not_found' });
  });

  it('rejects cross-origin and oversized mutations before domain work', async () => {
    const app = express();
    mountDrawRoutes(app, {
      database: {} as never,
      publicUrl: 'https://draw.example.test',
      secret: 'route-test-secret',
    });
    const crossOrigin = await request(app, '/api/draw/leagues', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(404);
    expect(crossOrigin.headers.get('access-control-allow-credentials')).toBeNull();
    expect(crossOrigin.headers.get('access-control-allow-origin')).toBeNull();
    const crossOriginRead = await request(app, '/api/draw/invitation', {
      headers: {
        Origin: 'https://evil.example',
        Authorization: 'Bearer private-capability',
      },
    });
    expect(crossOriginRead.status).toBe(404);
    expect(crossOriginRead.headers.get('cache-control')).toBe('no-store');
    expect(crossOriginRead.headers.get('vary')).toContain('Authorization');
    expect(crossOriginRead.headers.get('access-control-allow-credentials')).toBeNull();
    const oversized = await request(app, '/api/draw/leagues', {
      method: 'POST',
      headers: { Origin: 'https://draw.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(20_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it('runs create, join, and draft recovery through public HTTP over migrated PGlite', () => withDb(async (database) => {
    await seedApiEvent(database);
    const app = express();
    mountDrawRoutes(app, {
      database,
      now: () => new Date('2026-08-24T14:59:59.999Z'),
      publicUrl: 'https://draw.example.test',
      secret: 'route-real-db-secret',
    });
    app.use('/api', (_req, res) => res.status(401).json({ error: 'studio_auth' }));
    const availability = await request(app, '/api/draw/events/us-open-2026-men');
    expect(availability.status).toBe(200);
    expect(await availability.json()).toMatchObject({
      state: 'ready',
      draw: { id: 'us-open-men' },
    });
    const creation = await request(app, '/api/draw/leagues', {
      method: 'POST',
      headers: {
        Origin: 'https://draw.example.test',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-create-request',
      },
      body: JSON.stringify({
        eventSlug: 'us-open-2026-men',
        leagueName: 'Friends',
        displayName: 'Creator',
      }),
    });
    expect(creation.status).toBe(201);
    const created = await creation.json() as { invitationLink: string; returnLink: string };
    expect(created.invitationLink).toContain('/#invite=');
    expect(created.returnLink).toContain('/#return=');
    expect(created.invitationLink).not.toBe(created.returnLink);
    expect(created.invitationLink).not.toContain('?');
    const inviteToken = new URL(created.invitationLink).hash.slice('#invite='.length);
    const joinedResponse = await request(app, '/api/draw/participants', {
      method: 'POST',
      headers: {
        Origin: 'https://draw.example.test',
        Authorization: `Bearer ${inviteToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-join-request',
      },
      body: JSON.stringify({ displayName: 'Ada' }),
    });
    expect(joinedResponse.status).toBe(201);
    const joined = await joinedResponse.json() as { returnLink: string };
    const returnToken = new URL(joined.returnLink).hash.slice('#return='.length);
    const saved = await request(app, '/api/draw/draft', {
      method: 'PUT',
      headers: {
        Origin: 'https://draw.example.test',
        Authorization: `Bearer ${returnToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 0, picks: { r1m1: 'p1' } }),
    });
    expect(saved.status).toBe(200);
    const restored = await request(app, '/api/draw/draft', {
      headers: { Authorization: 'Bearer ' + returnToken },
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ version: 1, picks: { r1m1: 'p1' } });
    const privateLeague = await request(app, '/api/draw/league', {
      headers: { Authorization: 'Bearer ' + returnToken },
    });
    expect(privateLeague.status).toBe(200);
    const privateBody = await privateLeague.json();
    expect(privateBody).toMatchObject({
      participantCount: 2,
      viewer: {
        draft: { exists: true, version: 1, pickCount: 1 },
        submission: { active: false, complete: false },
      },
      projection: null,
    });
    expect(privateBody).not.toHaveProperty('participants');
    expect(privateBody).not.toHaveProperty('submissions');
    expect(JSON.stringify(privateBody)).not.toContain('Creator');
    expect(JSON.stringify(privateBody)).not.toContain('"picks"');
    const bodyTransport = await request(app, '/api/draw/draft', {
      method: 'PUT',
      headers: {
        Origin: 'https://draw.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: returnToken, expectedVersion: 1, picks: {} }),
    });
    expect(bodyTransport.status).toBe(404);
    const queryTransport = await request(app, `/api/draw/draft?token=${encodeURIComponent(returnToken)}`);
    expect(queryTransport.status).toBe(404);
    const cookieTransport = await request(app, '/api/draw/draft', {
      headers: { Cookie: `draw=${returnToken}` },
    });
    expect(cookieTransport.status).toBe(404);
    expect(await duplicateAuthorization(app)).toBe(404);
  }));

  it('keeps authenticated reads and participant removal while league mutations are disabled', () => withDb(async (database) => {
    await seedApiEvent(database);
    const routeOptions = {
      database,
      now: () => new Date('2026-08-24T14:59:59.999Z'),
      publicUrl: 'https://draw.example.test',
      secret: 'route-disabled-mutations-secret',
    };
    const enabled = express();
    mountDrawRoutes(enabled, routeOptions);
    const creation = await request(enabled, '/api/draw/leagues', {
      method: 'POST',
      headers: {
        Origin: 'https://draw.example.test',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'disabled-boundary-setup',
      },
      body: JSON.stringify({
        eventSlug: 'us-open-2026-men',
        leagueName: 'Read-only friends',
        displayName: 'Creator',
      }),
    });
    expect(creation.status).toBe(201);
    const created = await creation.json() as { invitationLink: string; returnLink: string };
    const inviteToken = new URL(created.invitationLink).hash.slice('#invite='.length);
    const returnToken = new URL(created.returnLink).hash.slice('#return='.length);

    const disabled = express();
    mountDrawRoutes(disabled, { ...routeOptions, mutationsEnabled: false });
    const originHeaders = {
      Origin: 'https://draw.example.test',
      'Content-Type': 'application/json',
    };
    const participantHeaders = {
      ...originHeaders,
      Authorization: `Bearer ${returnToken}`,
    };
    const invitationHeaders = {
      ...originHeaders,
      Authorization: `Bearer ${inviteToken}`,
    };

    for (const [path, init] of [
      ['/api/draw/leagues', {
        method: 'POST',
        headers: { ...originHeaders, 'Idempotency-Key': 'disabled-create' },
        body: JSON.stringify({ eventSlug: 'us-open-2026-men', leagueName: 'Hidden', displayName: 'No one' }),
      }],
      ['/api/draw/participants', {
        method: 'POST',
        headers: { ...invitationHeaders, 'Idempotency-Key': 'disabled-join' },
        body: JSON.stringify({ displayName: 'Friend' }),
      }],
      ['/api/draw/draft', {
        method: 'PUT',
        headers: participantHeaders,
        body: JSON.stringify({ expectedVersion: 0, picks: { r1m1: 'p1' } }),
      }],
      ['/api/draw/submissions', {
        method: 'POST',
        headers: participantHeaders,
        body: JSON.stringify({ expectedDraftVersion: 0 }),
      }],
    ] as const) {
      const response = await request(disabled, path, init);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }

    for (const [path, headers] of [
      ['/api/draw/invitation', invitationHeaders],
      ['/api/draw/draft', participantHeaders],
      ['/api/draw/league', participantHeaders],
    ] as const) {
      const response = await request(disabled, path, { headers });
      expect(response.status).toBe(200);
    }

    const removed = await request(disabled, '/api/draw/participant', {
      method: 'DELETE',
      headers: participantHeaders,
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ removed: true });
  }));

  it('records a third-round return while the current recap is still updating', () => withDb(async (database) => {
    await seedApiEvent(database);
    let clock = new Date('2026-08-24T14:59:59.999Z');
    const app = express();
    mountDrawRoutes(app, {
      database,
      now: () => clock,
      publicUrl: 'https://draw.example.test',
      secret: 'route-analytics-secret',
    });
    const creation = await request(app, '/api/draw/leagues', {
      method: 'POST',
      headers: {
        Origin: 'https://draw.example.test',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'analytics-create-request',
      },
      body: JSON.stringify({
        eventSlug: 'us-open-2026-men',
        leagueName: 'Friends',
        displayName: 'Creator',
      }),
    });
    const created = await creation.json() as { returnLink: string };
    const token = new URL(created.returnLink).hash.slice('#return='.length);
    const picks = completePicks(fixtureDraw());
    const draft = await request(app, '/api/draw/draft', {
      method: 'PUT',
      headers: {
        Origin: 'https://draw.example.test',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 0, picks }),
    });
    expect(draft.status).toBe(200);
    const submission = await request(app, '/api/draw/submissions', {
      method: 'POST',
      headers: {
        Origin: 'https://draw.example.test',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedDraftVersion: 1 }),
    });
    expect(submission.status).toBe(201);

    const [event] = await database.select().from(drawEvents);
    const completedPayload: AcceptedDrawRevision = {
      revisionId: '102',
      checksum: 'b'.repeat(64),
      fetchedAt: '2026-09-01T10:00:00.000Z',
      acceptedAt: '2026-09-01T10:01:00.000Z',
      parserVersion: 'u1',
      explicitCorrections: [],
      complete: false,
      draw: completedThrough(3),
    };
    const [completedRevision] = await database.insert(drawAcceptedRevisions).values({
      eventId: event!.id,
      sourceRevisionId: completedPayload.revisionId,
      checksum: completedPayload.checksum,
      fetchedAt: new Date(completedPayload.fetchedAt),
      acceptedAt: new Date(completedPayload.acceptedAt),
      parserVersion: completedPayload.parserVersion,
      payload: completedPayload,
      explicitCorrections: [],
      complete: false,
    }).returning();
    await database.update(drawEventHeads).set({
      acceptedRevisionId: completedRevision!.id,
      revisionAcceptedAt: completedRevision!.acceptedAt,
      advancedAt: completedRevision!.acceptedAt,
    }).where(eq(drawEventHeads.eventId, event!.id));
    clock = new Date('2026-09-01T12:00:00Z');

    const updating = await request(app, '/api/draw/league', {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(updating.status).toBe(200);
    expect(await updating.json()).toMatchObject({
      projection: { recap: { state: 'updating' } },
    });
    expect((await database.select().from(drawEngagementEvents)).map(({ kind, round }) => ({ kind, round })))
      .toEqual(expect.arrayContaining([
        { kind: 'submission', round: 0 },
        { kind: 'qualifying_return', round: 3 },
      ]));
    expect((await database.select().from(drawEngagementEvents)).some(({ kind }) => kind === 'recap_view'))
      .toBe(false);

    const current = await request(app, '/api/draw/league', {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(await current.json()).toMatchObject({
      projection: { recap: { state: 'current', viewModel: { round: 3 } } },
    });
    const engagement = await database.select().from(drawEngagementEvents);
    expect(engagement.filter(({ kind }) => kind === 'qualifying_return')).toHaveLength(1);
    expect(engagement.filter(({ kind }) => kind === 'recap_view')).toHaveLength(1);
    expect(JSON.stringify(engagement)).not.toContain('Creator');
    expect(JSON.stringify(engagement)).not.toContain('picks');
    expect(JSON.stringify(engagement)).not.toContain(token);
  }));
});
