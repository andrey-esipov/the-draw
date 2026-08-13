// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DrawLeagueProjection, DrawLeagueStanding, DrawPathState } from '../../shared/draw/contracts';
import { LeagueStandings } from './LeagueStandings';

afterEach(cleanup);

const states: DrawPathState[] = ['alive', 'broken', 'unresolved', 'changed-opponent'];

function standing(participantId: string, seat: number, rank: number): DrawLeagueStanding {
  return {
    participantId,
    seat,
    displayName: participantId === 'you' ? 'Andrey' : '<script>Friend with a deliberately long name that must remain literal</script>',
    removed: false,
    rank,
    tied: true,
    score: 17,
    maxPossible: 81,
    movement: null,
    champion: { playerId: 'a', playerName: 'A. Player', state: participantId === 'you' ? 'alive' : 'broken' },
    correctByRound: [1, 0, 0, 1, 0, 0, 0],
    submission: { version: 1, checksum: 'a'.repeat(64), picks: { r1m1: 'a' } },
    path: states.map((state, index) => ({
      matchId: `r${index + 1}m1`,
      round: index + 1,
      roundName: `Round ${index + 1}`,
      points: 2 ** index,
      predictedWinnerId: 'a',
      predictedWinnerName: 'A. Player',
      predictedOpponentId: 'b',
      predictedOpponentName: 'B. Player',
      acceptedWinnerId: state === 'unresolved' ? null : state === 'broken' ? 'b' : 'a',
      acceptedWinnerName: state === 'unresolved' ? null : state === 'broken' ? 'B. Player' : 'A. Player',
      acceptedOpponentId: state === 'unresolved' ? null : state === 'changed-opponent' ? 'c' : 'b',
      acceptedOpponentName: state === 'unresolved' ? null : state === 'changed-opponent' ? 'C. Player' : 'B. Player',
      state,
    })),
  };
}

function projection(overrides: Partial<DrawLeagueProjection> = {}): DrawLeagueProjection {
  return {
    canonical: {
      revisionId: 'revision-2',
      sourceRevisionId: '202',
      checksum: 'b'.repeat(64),
      fetchedAt: '2026-08-24T15:01:00.000Z',
      acceptedAt: '2026-08-24T15:02:00.000Z',
      sourceUrl: 'https://en.wikipedia.org/wiki/fixture',
      corrected: true,
      freshness: {
        state: 'delayed',
        lastAttemptAt: '2026-08-24T15:03:00.000Z',
        lastSuccessfulAt: '2026-08-24T15:00:00.000Z',
        delayReason: 'source_maxlag',
      },
    },
    movementAvailable: false,
    standings: [standing('you', 1, 1), standing('friend', 2, 1)],
    participants: [
      { id: 'you', seat: 1, displayName: 'Andrey', removed: false, submitted: true },
      { id: 'friend', seat: 2, displayName: '<script>Friend with a deliberately long name that must remain literal</script>', removed: false, submitted: true },
      { id: 'removed', seat: 3, displayName: 'Removed player', removed: true, submitted: false },
    ],
    recap: { state: 'none' },
    ...overrides,
  };
}

describe('post-lock league standings', () => {
  it('shows tied competition ranks, You, provenance, delay/correction, and no invented movement', () => {
    render(<LeagueStandings leagueName="Friends" eventKind="mens_singles" viewerParticipantId="you" participantCount={3} projection={projection()} />);
    expect(screen.getAllByText('T1')).toHaveLength(2);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Correction replayed')).toBeTruthy();
    expect(screen.getByText(/Scores through/)).toBeTruthy();
    expect(screen.getByText(/not independently verified/)).toBeTruthy();
    expect(screen.getByText(/Movement unavailable/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Removed player')).toBeTruthy();
  });

  it('renders every path state with text and shape, and switches inspection through a 44px-native button', () => {
    render(<LeagueStandings leagueName="Friends" eventKind="womens_singles" viewerParticipantId="you" participantCount={3} projection={projection()} />);
    expect(screen.getByText(/^Unresolved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Round 1, 1 match/ }));
    expect(screen.getByText(/^Alive/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Round 2, 1 match/ }));
    expect(screen.getByText(/^Broken/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Round 4, 1 match/ }));
    expect(screen.getByText(/^Advanced, opponent changed/)).toBeTruthy();
    const friendButton = screen.getByRole('button', { name: /Friend with a deliberately long name/ });
    expect(friendButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(friendButton);
    expect(friendButton.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: /Friend with a deliberately long name/ })).toBeTruthy();
    expect(friendButton.tagName).toBe('BUTTON');
  });

  it('renders one actual round and defaults to the earliest unresolved or changed-opponent round', () => {
    const full = standing('you', 1, 1);
    full.path = Array.from({ length: 127 }, (_, index) => {
      const round = index < 64 ? 1 : index < 96 ? 2 : index < 112 ? 3 : index < 120 ? 4 : index < 124 ? 5 : index < 126 ? 6 : 7;
      return {
        ...full.path[0],
        matchId: `r${round}m${index + 1}`,
        round,
        roundName: `Round ${round}`,
        points: 2 ** (round - 1),
        state: index === 113 ? 'unresolved' as const : 'alive' as const,
      };
    });
    render(<LeagueStandings leagueName="Friends" eventKind="womens_singles" viewerParticipantId="you" participantCount={1} projection={projection({
      standings: [full],
      participants: [{ id: 'you', seat: 1, displayName: 'Andrey', removed: false, submitted: true }],
    })} />);
    expect(screen.getByRole('list', { name: 'Round 4 submitted picks' }).children).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: /Round 7, 1 match/ }));
    expect(screen.getByRole('list', { name: 'Round 7 submitted picks' }).children).toHaveLength(1);
  });

  it('defaults a fully resolved path to its final round', () => {
    const resolved = standing('you', 1, 1);
    resolved.path = resolved.path.map((step) => ({ ...step, state: 'alive' }));
    render(<LeagueStandings leagueName="Friends" eventKind="womens_singles" viewerParticipantId="you" participantCount={1} projection={projection({
      standings: [resolved],
      participants: [{ id: 'you', seat: 1, displayName: 'Andrey', removed: false, submitted: true }],
    })} />);
    expect(screen.getByRole('button', { name: /Round 4, 1 match/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('list', { name: 'Round 4 submitted picks' }).children).toHaveLength(1);
  });

  it('labels max possible as the total point ceiling', () => {
    render(<LeagueStandings leagueName="Friends" eventKind="mens_singles" viewerParticipantId="you" participantCount={3} projection={projection()} />);
    expect(screen.getByText('17 points · 81-point ceiling')).toBeTruthy();
    expect(screen.queryByText(/still possible/)).toBeNull();
  });

  it('keeps standings first and semantic on mobile-safe DOM, including absent viewer submission', () => {
    render(<LeagueStandings leagueName="Friends" eventKind="mens_singles" viewerParticipantId="absent" participantCount={3} projection={projection()} />);
    const table = screen.getByRole('table');
    const path = screen.getByRole('heading', { name: 'Andrey' });
    expect(table.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('explains the no-submission state without exposing a draft', () => {
    render(<LeagueStandings
      leagueName="Friends"
      eventKind="mens_singles"
      viewerParticipantId="you"
      participantCount={1}
      projection={projection({
        standings: [],
        participants: [{ id: 'you', seat: 1, displayName: 'Andrey', removed: false, submitted: false }],
      })}
    />);
    expect(screen.getByRole('heading', { name: 'No submitted brackets' })).toBeTruthy();
    expect(screen.getByText(/Incomplete drafts stayed private/)).toBeTruthy();
    expect(screen.queryByText(/r1m1/)).toBeNull();
  });
});
