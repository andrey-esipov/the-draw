// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createLeaguePreviewDraw } from '../data/league-preview';
import type { LeagueAccessState } from '../data/league-api';
import { LeagueShell } from './LeagueShell';

// Regression: ISSUE-009 — a stale draft response could cross participant capabilities
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-08-13.md

afterEach(cleanup);

function participantState(id: string): LeagueAccessState {
  return {
    kind: 'participant',
    checkedAt: '2026-08-13T00:00:00.000Z',
    league: {
      league: {
        id: 'league-1',
        name: 'Friday Night Draw',
        eventSlug: 'us-open-2026-men',
        eventKind: 'mens_singles',
        lockAt: '2026-08-20T00:00:00.000Z',
        revealed: false,
      },
      participantId: id,
      participantCount: 2,
      viewer: {
        draft: { exists: false, version: 0, pickCount: 0 },
        submission: { active: false, complete: false },
      },
      projection: null,
    },
  };
}

function draftResponse(playerName: string): Response {
  const draw = createLeaguePreviewDraw('us-open-2026-men');
  draw.players['preview-player-1']!.name = playerName;
  return new Response(JSON.stringify({
    version: 0,
    picks: {},
    acceptedRevisionId: `revision-${playerName}`,
    acceptedRevisionChecksum: `checksum-${playerName}`,
    affectedMatchIds: [],
    locked: false,
    draw,
  }), { headers: { 'Content-Type': 'application/json' } });
}

function leagueResponse(participantId: string): Response {
  const state = participantState(participantId);
  return new Response(
    JSON.stringify(state.kind === 'participant' ? state.league : null),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

describe('participant capability isolation', () => {
  it('discards a stale draft response after switching return capabilities', async () => {
    let resolveFirst!: (response: Response) => void;
    let markFirstStarted!: () => void;
    const firstDraft = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const fetcher: typeof fetch = async (_input, init) => {
      const token = new Headers(init?.headers).get('Authorization');
      if (token === 'Bearer participant-a') {
        markFirstStarted();
        return firstDraft;
      }
      return draftResponse('Player B');
    };
    const { rerender } = render(
      <LeagueShell
        state={participantState('participant-a')}
        capability={{ kind: 'participant', token: 'participant-a' }}
        previewFetch={fetcher}
      />,
    );
    await firstStarted;

    rerender(
      <LeagueShell
        state={participantState('participant-b')}
        capability={{ kind: 'participant', token: 'participant-b' }}
        previewFetch={fetcher}
      />,
    );
    expect(await screen.findByText('Player B')).toBeTruthy();

    resolveFirst(draftResponse('Player A'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Player A')).toBeNull();
    expect(screen.getByText('Player B')).toBeTruthy();
  });

  it('discards a stale visibility refresh after switching return capabilities', async () => {
    let resolveRefresh!: (response: Response) => void;
    let markRefreshStarted!: () => void;
    const staleRefresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url, window.location.origin).pathname;
      const token = new Headers(init?.headers).get('Authorization');
      if (path.endsWith('/league') && token === 'Bearer participant-a') {
        markRefreshStarted();
        return staleRefresh;
      }
      return draftResponse(token === 'Bearer participant-a' ? 'Player A' : 'Player B');
    };
    const { rerender } = render(
      <LeagueShell
        state={participantState('participant-a')}
        capability={{ kind: 'participant', token: 'participant-a' }}
        previewFetch={fetcher}
      />,
    );
    expect(await screen.findByText('Player A')).toBeTruthy();

    document.dispatchEvent(new Event('visibilitychange'));
    await refreshStarted;
    rerender(
      <LeagueShell
        state={participantState('participant-b')}
        capability={{ kind: 'participant', token: 'participant-b' }}
        previewFetch={fetcher}
      />,
    );
    expect(await screen.findByText('Player B')).toBeTruthy();

    resolveRefresh(leagueResponse('participant-a'));
    await waitFor(() => expect(screen.queryByText('Player A')).toBeNull());
    expect(screen.getByText('Player B')).toBeTruthy();
  });

  it('discards a failed locked recovery after switching return capabilities', async () => {
    let rejectRecovery!: (error: Error) => void;
    let markRecoveryStarted!: () => void;
    const staleRecovery = new Promise<Response>((_resolve, reject) => { rejectRecovery = reject; });
    const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url, window.location.origin).pathname;
      const token = new Headers(init?.headers).get('Authorization');
      if (token === 'Bearer participant-a' && path.endsWith('/draft')) {
        return new Response(JSON.stringify({ error: 'locked' }), {
          status: 423,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (token === 'Bearer participant-a' && path.endsWith('/league')) {
        markRecoveryStarted();
        return staleRecovery;
      }
      return draftResponse('Player B');
    };
    const { rerender } = render(
      <LeagueShell
        state={participantState('participant-a')}
        capability={{ kind: 'participant', token: 'participant-a' }}
        previewFetch={fetcher}
      />,
    );
    await recoveryStarted;

    rerender(
      <LeagueShell
        state={participantState('participant-b')}
        capability={{ kind: 'participant', token: 'participant-b' }}
        previewFetch={fetcher}
      />,
    );
    expect(await screen.findByText('Player B')).toBeTruthy();

    rejectRecovery(new Error('offline'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your picks could not be loaded' })).toBeNull());
    expect(screen.getByText('Player B')).toBeTruthy();
  });
});
