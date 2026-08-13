// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLeagueAccess, type LeagueAccessState } from '../data/league-api';
import { createLeaguePreviewDraw } from '../data/league-preview';
import { LeagueShell } from './LeagueShell';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('league-aware shell', () => {
  it('renders invitation context, exact lock time, freshness, and quiet Rallo signature', () => {
    render(<LeagueShell state={{
      kind: 'invitation',
      checkedAt: '2026-08-11T23:00:00.000Z',
      invitation: {
        leagueId: 'league-1',
        leagueName: 'Centre Court friends',
        event: { slug: 'us-open-2026-men', kind: 'mens_singles' },
        seatsRemaining: 14,
        lockAt: '2026-08-24T15:00:00.000Z',
      },
    }} />);
    expect(screen.getByRole('heading', { name: 'Centre Court friends' })).toBeTruthy();
    expect(screen.getByText(/Picks stay hidden until/)).toBeTruthy();
    expect(screen.getByText(/Aug 24, 2026/)).toBeTruthy();
    expect(screen.getByText(/Checked/)).toBeTruthy();
    expect(screen.getByText('The Draw')).toBeTruthy();
    expect(screen.queryByText(/account/i)).toBeNull();
    const lockTime = screen.getByText(/Aug 24, 2026/);
    expect(lockTime.tagName).toBe('TIME');
    expect(lockTime.getAttribute('datetime')).toBe('2026-08-24T15:00:00.000Z');
    expect(lockTime.textContent?.endsWith('.')).toBe(false);
    expect(lockTime.parentElement?.textContent?.endsWith('.')).toBe(true);
  });

  it('renders participant access as confirmed without adding prediction mechanics', () => {
    render(<LeagueShell state={{
      kind: 'participant',
      checkedAt: '2026-08-11T23:00:00.000Z',
      league: {
        league: {
          id: 'league-1',
          name: 'Centre Court friends',
          eventSlug: 'french-open:2026-women',
          eventKind: 'womens_singles',
          lockAt: '2026-08-24T15:00:00.000Z',
          revealed: false,
        },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
        projection: null,
      },
    }} />);
    expect(screen.getByText("Women's singles")).toBeTruthy();
    expect(screen.getByText(/Your place is confirmed/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['invalid-access', 'This private link is no longer valid'],
    ['source-delay', 'The tournament draw is still being verified'],
    ['network-failure', 'The league could not be reached'],
  ] as const)('renders %s without success-shaped league content', (kind, message) => {
    render(<LeagueShell state={{ kind }} />);
    expect(screen.getByRole('heading', { name: message })).toBeTruthy();
    expect(screen.queryByText(/Picks stay hidden/)).toBeNull();
    if (kind === 'invalid-access') {
      expect(screen.queryByText(/Your private link has not changed/)).toBeNull();
    }
    expect(screen.getByText('The Draw')).toBeTruthy();
  });

  it.each([
    [401, 'revoked'],
    [403, 'forbidden'],
  ])('renders revoked/forbidden HTTP %s access as invalid, not a connection failure', async (status, error) => {
    const state = await loadLeagueAccess(
      { kind: 'participant', token: 'secret' },
      async () => new Response(JSON.stringify({ error }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<LeagueShell state={state} />);

    expect(screen.getByRole('heading', { name: 'This private link is no longer valid' })).toBeTruthy();
    expect(screen.queryByText(/Your private link has not changed/)).toBeNull();
  });

  it.each([
    { kind: 'loading' },
    { kind: 'invalid-access' },
    { kind: 'source-delay' },
    { kind: 'network-failure' },
    {
      kind: 'invitation',
      checkedAt: '2026-08-11T23:00:00.000Z',
      invitation: {
        leagueId: 'league-1',
        leagueName: 'Centre Court friends',
        event: { slug: 'us-open-2026-men', kind: 'mens_singles' },
        seatsRemaining: 14,
        lockAt: '2026-08-24T15:00:00.000Z',
      },
    },
    {
      kind: 'participant',
      checkedAt: '2026-08-11T23:00:00.000Z',
      league: {
        league: {
          id: 'league-1',
          name: 'Centre Court friends',
          eventSlug: 'french-open:2026-women',
          eventKind: 'womens_singles',
          lockAt: '2026-08-24T15:00:00.000Z',
          revealed: false,
        },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
        projection: null,
      },
    },
  ] satisfies LeagueAccessState[])('releases and removes the boot veil for $kind capability state', (state) => {
    vi.useFakeTimers();
    const boot = document.createElement('div');
    boot.id = 'boot';
    document.body.append(boot);

    render(<LeagueShell state={state} />);

    expect(boot.classList.contains('is-gone')).toBe(true);
    expect(boot.isConnected).toBe(true);
    vi.advanceTimersByTime(700);
    expect(boot.isConnected).toBe(false);
  });

  it('refreshes on visibility return and switches to the server lock state without revealing a draft', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/draw/draft') {
        return new Response(JSON.stringify({
          version: 1,
          picks: { r1m1: 'p1' },
          acceptedRevisionId: 'rev-1',
          acceptedRevisionChecksum: 'sum-1',
          affectedMatchIds: [],
          locked: false,
          draw: {
            id: 'draw-1',
            tournament: 'Wimbledon',
            year: 2026,
            event: "Men's Singles",
            surface: 'Grass',
            venue: 'Wimbledon',
            city: 'London',
            bestOf: 5,
            source: { wikipedia: 'x', url: 'x' },
            players: {
              p1: { id: 'p1', name: 'Player 1', short: 'P1', country: null, seed: '1' },
              p2: { id: 'p2', name: 'Player 2', short: 'P2', country: null, seed: null },
            },
            rounds: [{ round: 1, name: 'Final', matches: [{ id: 'r1m1', round: 1, position: 0, sides: [{ player: 'p1', seed: '1', sets: [] }, { player: 'p2', seed: null, sets: [] }], winner: null }] }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: true },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
        projection: {
          canonical: {
            revisionId: 'rev-2', sourceRevisionId: '102', checksum: 'b'.repeat(64),
            fetchedAt: '2026-08-24T15:01:00.000Z', acceptedAt: '2026-08-24T15:02:00.000Z',
            sourceUrl: 'https://en.wikipedia.org/wiki/fixture', corrected: false,
            freshness: { state: 'current', lastAttemptAt: null, lastSuccessfulAt: null, delayReason: null },
          },
          movementAvailable: false,
          standings: [],
          participants: [{ id: 'participant-1', seat: 1, displayName: 'Andrey', removed: false, submitted: false }],
          recap: { state: 'none' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const initialState = {
      kind: 'participant' as const,
      checkedAt: '2026-08-11T23:00:00.000Z',
      league: {
        league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles' as const, lockAt: '2026-08-24T15:00:00.000Z', revealed: false },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: true, version: 1, pickCount: 1 }, submission: { active: false, complete: false } },
        projection: null,
      },
    };
    const capability = { kind: 'participant' as const, token: 'return-secret' };
    const { rerender } = render(<LeagueShell
      capability={capability}
      state={initialState}
    />);
    await screen.findByText('Build the path to the title');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByRole('heading', { name: 'Friends' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'No submitted brackets' })).toBeTruthy();
    expect(screen.queryByText('Player 1')).toBeNull();
    rerender(<LeagueShell capability={{ ...capability }} state={structuredClone(initialState)} />);
    expect(screen.getByRole('heading', { name: 'No submitted brackets' })).toBeTruthy();
    expect(screen.queryByText('Build the path to the title')).toBeNull();
    fetcher.mockRestore();
  });

  it('shows a full-league refusal from the authoritative join response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'league_full' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));
    render(<LeagueShell
      capability={{ kind: 'invitation', token: 'invite-secret' }}
      state={{
        kind: 'invitation',
        checkedAt: '2026-08-11T23:00:00.000Z',
        invitation: {
          leagueId: 'league-1',
          leagueName: 'Friends',
          event: { slug: 'wimbledon:2026-men', kind: 'mens_singles' },
          seatsRemaining: 1,
          lockAt: '2026-08-24T15:00:00.000Z',
        },
      }}
    />);
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join the bracket' }));
    expect(await screen.findByText('This league filled before your place could be created.')).toBeTruthy();
    fetcher.mockRestore();
  });

  it('shows an honest "already locked" refusal instead of a misleading network error when creating a league for a draw past its lock time', async () => {
    // Regression: a historical/closed draw can still report `state: 'ready'` from the
    // availability check (it has a canonical revision) even though its lockAt has already
    // passed. The server correctly refuses league creation with a distinct `locked` error,
    // but the create-flow used to let that fall through LeagueEntry's generic catch-all
    // ("Check your connection and try again."), which reads as a network failure rather
    // than the true, non-retriable "this draw already locked" outcome.
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'locked', details: { lockAt: '2026-08-24T15:00:00.000Z' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));
    render(<LeagueShell state={{ kind: 'create', eventSlug: 'us-open-2026-men', eventName: 'US Open' }} />);
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Friday Night Draw' } });
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private league' }));
    expect(await screen.findByText('This draw has already locked and can no longer accept new leagues.')).toBeTruthy();
    expect(screen.queryByText('Your place could not be created. Check your connection and try again.')).toBeNull();
    fetcher.mockRestore();
  });

  it('shows an honest "no longer available" refusal instead of a misleading network error when a draw is retired mid-creation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'not_found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ));
    render(<LeagueShell state={{ kind: 'create', eventSlug: 'us-open-2026-men', eventName: 'US Open' }} />);
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Friday Night Draw' } });
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private league' }));
    expect(await screen.findByText('This draw is no longer available for new leagues.')).toBeTruthy();
    expect(screen.queryByText('Your place could not be created. Check your connection and try again.')).toBeNull();
    fetcher.mockRestore();
  });

  it('moves straight to an explicit loading-participant transition on Start picking, never back to the create form', async () => {
    // Regression: the links -> picking handoff used to clear `links` before loadParticipant
    // resolved, letting React fall through to state.kind ('create') and briefly re-render
    // the create form while the participant fetch was still in flight.
    let resolveLeague!: (response: Response) => void;
    const leaguePending = new Promise<Response>((resolve) => { resolveLeague = resolve; });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
        window.location.origin,
      ).pathname;
      if (init?.method === 'POST' && path.endsWith('/api/draw/leagues')) {
        return new Response(JSON.stringify({
          leagueId: 'league-1',
          participantId: 'participant-1',
          eventKind: 'mens_singles',
          invitationLink: 'https://the-draw.replit.app/#invite=abc',
          returnLink: 'https://the-draw.replit.app/#return=xyz',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path.endsWith('/api/draw/league')) return leaguePending;
      throw new Error(`unexpected fetch: ${path}`);
    });

    render(<LeagueShell state={{ kind: 'create', eventSlug: 'us-open-2026-men', eventName: 'US Open' }} />);
    fireEvent.change(screen.getByLabelText('League name'), { target: { value: 'Friday Night Draw' } });
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private league' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start picking' }));

    expect(await screen.findByRole('heading', { name: 'Loading your bracket' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create private league' })).toBeNull();
    expect(screen.queryByLabelText('League name')).toBeNull();

    resolveLeague(new Response(JSON.stringify({
      league: {
        id: 'league-1', name: 'Friday Night Draw', eventSlug: 'us-open-2026-men',
        eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: true,
      },
      participantId: 'participant-1',
      participantCount: 1,
      viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
      projection: {
        canonical: {
          revisionId: 'rev-1', sourceRevisionId: '101', checksum: 'a'.repeat(64),
          fetchedAt: '2026-08-24T15:01:00.000Z', acceptedAt: '2026-08-24T15:02:00.000Z',
          sourceUrl: 'https://en.wikipedia.org/wiki/fixture', corrected: false,
          freshness: { state: 'current', lastAttemptAt: null, lastSuccessfulAt: null, delayReason: null },
        },
        movementAvailable: false,
        standings: [],
        participants: [],
        recap: { state: 'none' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Loading your bracket' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Create private league' })).toBeNull();
    fetcher.mockRestore();
  });

  it('recovers to revealed standings when draft loading crosses the lock boundary', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'locked' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: true },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: true, version: 1, pickCount: 1 }, submission: { active: false, complete: false } },
        projection: {
          canonical: {
            revisionId: 'rev-2', sourceRevisionId: '102', checksum: 'b'.repeat(64),
            fetchedAt: '2026-08-24T15:01:00.000Z', acceptedAt: '2026-08-24T15:02:00.000Z',
            sourceUrl: 'https://en.wikipedia.org/wiki/fixture', corrected: false,
            freshness: { state: 'current', lastAttemptAt: null, lastSuccessfulAt: null, delayReason: null },
          },
          movementAvailable: false,
          standings: [],
          participants: [],
          recap: { state: 'none' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<LeagueShell
      capability={{ kind: 'participant', token: 'return-secret' }}
      state={{
        kind: 'participant',
        checkedAt: '2026-08-11T23:00:00.000Z',
        league: {
          league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: false },
          participantId: 'participant-1',
          participantCount: 1,
          viewer: { draft: { exists: true, version: 1, pickCount: 1 }, submission: { active: false, complete: false } },
          projection: null,
        },
      }}
    />);
    expect(await screen.findByRole('heading', { name: 'No submitted brackets' })).toBeTruthy();
    expect(screen.queryByText('Your picks could not be loaded')).toBeNull();
    fetcher.mockRestore();
  });

  it('picks up a same-revision draft edit made in another tab on refresh', async () => {
    // Regression: refresh only reloaded the draft when acceptedRevisionId changed or
    // affectedMatchIds was non-empty — a same-revision edit saved from another tab (no
    // source movement) was silently dropped because neither condition fired.
    const draw = createLeaguePreviewDraw('us-open-2026-men');
    const draftWithPlayerName = (playerName: string, version: number) => ({
      version,
      picks: {},
      acceptedRevisionId: 'revision-1',
      acceptedRevisionChecksum: 'checksum-1',
      affectedMatchIds: [],
      locked: false,
      draw: {
        ...draw,
        players: {
          ...draw.players,
          'preview-player-1': { ...draw.players['preview-player-1']!, name: playerName },
        },
      },
    });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(draftWithPlayerName('Player A', 1)), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        league: { id: 'league-1', name: 'Friends', eventSlug: 'us-open-2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: false },
        participantId: 'participant-1',
        participantCount: 1,
        viewer: { draft: { exists: true, version: 2, pickCount: 0 }, submission: { active: false, complete: false } },
        projection: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(draftWithPlayerName('Player B', 2)), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

    render(<LeagueShell
      capability={{ kind: 'participant', token: 'return-secret' }}
      state={{
        kind: 'participant',
        checkedAt: '2026-08-11T23:00:00.000Z',
        league: {
          league: { id: 'league-1', name: 'Friends', eventSlug: 'us-open-2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: false },
          participantId: 'participant-1',
          participantCount: 1,
          viewer: { draft: { exists: true, version: 1, pickCount: 0 }, submission: { active: false, complete: false } },
          projection: null,
        },
      }}
    />);
    expect(await screen.findByText('Player A')).toBeTruthy();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('Player B')).toBeTruthy();
    expect(screen.queryByText('Player A')).toBeNull();
    fetcher.mockRestore();
  });

  it('polls the league every 60 seconds while the tab is visible, and stops on unmount', async () => {
    vi.useFakeTimers();
    const leagueResponse = () => new Response(JSON.stringify({
      league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: true },
      participantId: 'participant-1',
      participantCount: 1,
      viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
      projection: {
        canonical: {
          revisionId: 'rev-2', sourceRevisionId: '102', checksum: 'b'.repeat(64),
          fetchedAt: '2026-08-24T15:01:00.000Z', acceptedAt: '2026-08-24T15:02:00.000Z',
          sourceUrl: 'https://en.wikipedia.org/wiki/fixture', corrected: false,
          freshness: { state: 'current', lastAttemptAt: null, lastSuccessfulAt: null, delayReason: null },
        },
        movementAvailable: false,
        standings: [],
        participants: [],
        recap: { state: 'none' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => leagueResponse());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    const { unmount } = render(<LeagueShell
      capability={{ kind: 'participant', token: 'return-secret' }}
      state={{
        kind: 'participant',
        checkedAt: '2026-08-11T23:00:00.000Z',
        league: {
          league: { id: 'league-1', name: 'Friends', eventSlug: 'wimbledon:2026-men', eventKind: 'mens_singles', lockAt: '2026-08-24T15:00:00.000Z', revealed: true },
          participantId: 'participant-1',
          participantCount: 1,
          viewer: { draft: { exists: false, version: 0, pickCount: 0 }, submission: { active: false, complete: false } },
          projection: null,
        },
      }}
    />);
    // With `revealed: true` already known from the initial capability response, mounting
    // does not itself trigger a fetch — the shell only reaches out to the network on the
    // visibility-driven and interval-driven refresh, which is what this test targets.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    unmount();
    const callsAtUnmount = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetcher.mock.calls.length).toBe(callsAtUnmount);

    fetcher.mockRestore();
    vi.useRealTimers();
  });
});
