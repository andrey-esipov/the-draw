import { describe, expect, it } from 'vitest';
import { createLeague, loadLeagueAccess, readLeagueDraft } from './league-api';

// Regression: ISSUE-003 — successful HTML fallback responses were accepted as league API data
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-08-13.md

describe('league API response validation', () => {
  it('reports a network failure when a successful response is not JSON', async () => {
    const result = await loadLeagueAccess(
      { kind: 'participant', token: 'secret' },
      async () => new Response('<!doctype html><title>The Draw</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    expect(result).toEqual({ kind: 'network-failure' });
  });

  it('rejects malformed JSON rather than returning a success-shaped payload', async () => {
    await expect(createLeague(
      'us-open:2026-men',
      'Friends',
      'Creator',
      async () => new Response('{', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )).rejects.toMatchObject({ code: 'invalid_response', status: 201 });
  });

  it('rejects valid JSON with the wrong endpoint shape', async () => {
    const access = await loadLeagueAccess(
      { kind: 'participant', token: 'secret' },
      async () => new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(access).toEqual({ kind: 'network-failure' });

    await expect(createLeague(
      'us-open:2026-men',
      'Friends',
      'Creator',
      async () => new Response('{}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )).rejects.toMatchObject({ code: 'invalid_response', status: 201 });
  });

  it('rejects malformed nested projections and draws', async () => {
    const malformedLeague = {
      league: {
        id: 'league-1',
        name: 'Friends',
        eventSlug: 'us-open-2026-men',
        eventKind: 'mens_singles',
        lockAt: '2026-08-20T00:00:00.000Z',
        revealed: true,
      },
      participantId: 'participant-1',
      participantCount: 1,
      viewer: {
        draft: { exists: true, version: 1, pickCount: 127 },
        submission: { active: true, complete: true },
      },
      projection: {},
    };
    const access = await loadLeagueAccess(
      { kind: 'participant', token: 'secret' },
      async () => new Response(JSON.stringify(malformedLeague), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(access).toEqual({ kind: 'network-failure' });

    await expect(readLeagueDraft(
      { kind: 'participant', token: 'secret' },
      async () => new Response(JSON.stringify({
        version: 1,
        picks: {},
        acceptedRevisionId: 'revision-1',
        acceptedRevisionChecksum: 'checksum-1',
        affectedMatchIds: [],
        locked: false,
        draw: { id: 'draw-1', players: {}, rounds: [{}] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });
});
