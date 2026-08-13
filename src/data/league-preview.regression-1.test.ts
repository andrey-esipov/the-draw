import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeague, joinLeague, loadLeagueAccess } from './league-api';
import { createLeaguePreviewFetch } from './league-preview';

// Regression: ISSUE-001 — generated invitation and return links crashed on a fresh load
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-08-13.md

describe('persistent local league preview capabilities', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/?slam=us-open-men&league-preview=1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
  });

  it('preserves preview parameters and restores organizer access with a new transport', async () => {
    const created = await createLeague(
      'us-open-2026-men',
      'Friday Night Draw',
      'Andrey',
      createLeaguePreviewFetch(null, 'us-open-2026-men'),
      'create-key',
    );

    expect(created.returnLink).toContain('?slam=us-open-men&league-preview=1#return=');
    expect(created.invitationLink).toContain('?slam=us-open-men&league-preview=1#invite=');

    const restored = await loadLeagueAccess(
      created.capability,
      createLeaguePreviewFetch(null, 'us-open-2026-men'),
    );
    expect(restored.kind).toBe('participant');
    if (restored.kind === 'participant') {
      expect(restored.league.league.name).toBe('Friday Night Draw');
      expect(restored.league.participantId).toBe('local-preview-organizer');
    }
  });

  it('opens the invitation and persists a joined friend return capability', async () => {
    const fetcher = createLeaguePreviewFetch(null, 'us-open-2026-men');
    const created = await createLeague(
      'us-open-2026-men',
      'Friday Night Draw',
      'Andrey',
      fetcher,
      'create-key',
    );
    const invitation = { kind: 'invitation' as const, token: new URL(created.invitationLink).hash.slice('#invite='.length) };

    const opened = await loadLeagueAccess(invitation, createLeaguePreviewFetch(null, 'us-open-2026-men'));
    expect(opened.kind).toBe('invitation');

    const joined = await joinLeague(
      invitation,
      'Mina',
      createLeaguePreviewFetch(null, 'us-open-2026-men'),
      'join-key',
    );
    const restored = await loadLeagueAccess(
      joined.capability,
      createLeaguePreviewFetch(null, 'us-open-2026-men'),
    );
    expect(restored.kind).toBe('participant');
    if (restored.kind === 'participant') {
      expect(restored.league.participantCount).toBe(2);
      expect(restored.league.participantId).toBe('local-preview-friend-2');
    }
  });
});
