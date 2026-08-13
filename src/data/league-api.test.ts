import { describe, expect, it, vi } from 'vitest';
import {
  createLeague,
  joinLeague,
  loadLeagueAccess,
  parseCapabilityFragment,
  saveLeagueDraft,
} from './league-api';

describe('private league capability bootstrap', () => {
  it('accepts exactly one invitation or return capability and rejects ambiguity', () => {
    expect(parseCapabilityFragment('#invite=invite-token')).toEqual({
      kind: 'capability',
      capability: { kind: 'invitation', token: 'invite-token' },
    });
    expect(parseCapabilityFragment('#return=return-token')).toEqual({
      kind: 'capability',
      capability: { kind: 'participant', token: 'return-token' },
    });
    for (const fragment of [
      '#invite=a&return=b',
      '#invite=a&invite=b',
      '#return=a&return=b',
      '#invite=',
      '#invite=a&extra=b',
    ]) {
      expect(parseCapabilityFragment(fragment)).toEqual({ kind: 'invalid' });
    }
    expect(parseCapabilityFragment('')).toEqual({ kind: 'none' });
  });

  it('keeps the capability in memory and sends one header with no credentials, referrer, body, or persistence', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const history = vi.spyOn(window.history, 'replaceState');
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect([...headers.entries()]).toEqual([['authorization', 'Bearer secret-return']]);
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({
        league: {
          id: 'league-1',
          name: 'Centre Court friends',
          eventSlug: 'us-open-2026-men',
          eventKind: 'mens_singles',
          lockAt: '2026-08-24T15:00:00.000Z',
          revealed: false,
        },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
        projection: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json', Date: 'Tue, 11 Aug 2026 23:00:00 GMT' } });
    });

    const result = await loadLeagueAccess(
      { kind: 'participant', token: 'secret-return' },
      fetcher,
      () => new Date('2026-08-11T23:00:01.000Z'),
    );
    expect(result).toMatchObject({ kind: 'participant', checkedAt: '2026-08-11T23:00:00.000Z' });
    expect(storage).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });

  it.each([
    [401, { error: 'revoked' }, 'invalid-access'],
    [403, { error: 'forbidden' }, 'invalid-access'],
    [404, { error: 'not_found' }, 'invalid-access'],
    [503, { error: 'source_unavailable' }, 'source-delay'],
    [503, { error: 'unavailable' }, 'network-failure'],
  ] as const)('maps HTTP %s to a distinct %s state', async (status, body, expected) => {
    const result = await loadLeagueAccess(
      { kind: 'invitation', token: 'secret' },
      async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(result.kind).toBe(expected);
  });

  it('keeps network failure separate from access and source failures', async () => {
    const result = await loadLeagueAccess(
      { kind: 'participant', token: 'secret' },
      async () => { throw new TypeError('offline'); },
    );
    expect(result).toEqual({ kind: 'network-failure' });
  });

  it('aborts a stalled request and reports a network failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = loadLeagueAccess({ kind: 'participant', token: 'secret' }, fetcher);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ kind: 'network-failure' });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('creates and joins with distinct links while moving only the return capability into page memory', async () => {
    const createFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        eventSlug: 'us-open:2026-men',
        leagueName: 'Friends',
        displayName: 'Creator',
      });
      return new Response(JSON.stringify({
        leagueId: 'league-1',
        participantId: 'creator-1',
        eventKind: 'mens_singles',
        invitationLink: 'https://example.test/draw/#invite=invite-secret',
        returnLink: 'https://example.test/draw/#return=creator-secret',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    const created = await createLeague('us-open:2026-men', 'Friends', 'Creator', createFetch);
    expect(created.invitationLink).not.toBe(created.returnLink);
    expect(created.capability).toEqual({ kind: 'participant', token: 'creator-secret' });

    const joinFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer invite-secret');
      expect(String(init?.body)).not.toContain('invite-secret');
      return new Response(JSON.stringify({
        participantId: 'friend-1',
        seat: 2,
        returnLink: 'https://example.test/draw/#return=friend-secret',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    const joined = await joinLeague({ kind: 'invitation', token: 'invite-secret' }, 'Friend', joinFetch);
    expect(joined.capability).toEqual({ kind: 'participant', token: 'friend-secret' });
  });

  it('saves drafts with lineage version in the body and capability only in one header', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ['authorization', 'Bearer return-secret'],
        ['content-type', 'application/json'],
      ]);
      expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 4, picks: { r1m1: 'p1' } });
      expect(String(init?.body)).not.toContain('return-secret');
      return new Response(JSON.stringify({
        version: 5,
        picks: { r1m1: 'p1' },
        acceptedRevisionId: 'revision-2',
        acceptedRevisionChecksum: 'checksum-2',
        affectedMatchIds: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const saved = await saveLeagueDraft(
      { kind: 'participant', token: 'return-secret' },
      4,
      { r1m1: 'p1' },
      fetcher,
    );
    expect(saved.version).toBe(5);
  });
});
