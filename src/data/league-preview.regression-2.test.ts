import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeague, joinLeague, loadLeagueAccess, readLeagueDraft, saveLeagueDraft, submitLeagueBracket } from './league-api';
import { createLeaguePreviewDraw, createLeaguePreviewFetch } from './league-preview';

// Regression: ISSUE-002 — local simulation could not reach picks, submission, or live standings
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-08-13.md

describe('complete local league preview lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/?slam=us-open-men&league-preview=1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
  });

  it('persists 127 picks, submits, and reveals a three-friend live clubhouse', async () => {
    const draw = createLeaguePreviewDraw('us-open-2026-men');
    const open = createLeaguePreviewFetch(draw, 'us-open-2026-men', 'open');
    const created = await createLeague('us-open-2026-men', 'Friday Night Draw', 'Andrey', open, 'create');
    const picks = Object.fromEntries(draw.rounds.flatMap((round) => round.matches.map((match) => [
      match.id,
      round.round === 1 ? match.sides[0]!.player : 'preview-player-1',
    ])));

    const saved = await saveLeagueDraft(created.capability, 0, picks, open);
    expect(Object.keys(saved.picks)).toHaveLength(127);
    await submitLeagueBracket(created.capability, saved.version, open);

    const live = await loadLeagueAccess(
      created.capability,
      createLeaguePreviewFetch(draw, 'us-open-2026-men', 'live'),
    );
    expect(live.kind).toBe('participant');
    if (live.kind === 'participant') {
      expect(live.league.league.revealed).toBe(true);
      expect(live.league.participantCount).toBe(3);
      expect(live.league.projection?.standings).toHaveLength(3);
      expect(live.league.projection?.movementAvailable).toBe(true);
      expect(live.league.projection?.recap.state).toBe('current');
    }
  });

  it('keeps the awaiting-draw state explicit', async () => {
    const awaiting = createLeaguePreviewFetch(null, 'us-open-2026-men', 'awaiting');
    const created = await createLeague('us-open-2026-men', 'Opening Night', 'Andrey', awaiting, 'create');
    const access = await loadLeagueAccess(created.capability, awaiting);
    expect(access.kind).toBe('participant');
  });

  it('keeps each friend draft private before lock', async () => {
    const draw = createLeaguePreviewDraw('us-open-2026-men');
    const fetcher = createLeaguePreviewFetch(draw, 'us-open-2026-men', 'open');
    const created = await createLeague('us-open-2026-men', 'Friday Night Draw', 'Andrey', fetcher, 'create');
    const invitation = {
      kind: 'invitation' as const,
      token: new URL(created.invitationLink).hash.slice('#invite='.length),
    };
    const joined = await joinLeague(invitation, 'Mina', fetcher, 'join');

    await saveLeagueDraft(created.capability, 0, { r1m1: 'preview-player-1' }, fetcher);
    await saveLeagueDraft(joined.capability, 0, { r1m1: 'preview-player-2' }, fetcher);

    expect((await readLeagueDraft(created.capability, fetcher)).picks).toEqual({ r1m1: 'preview-player-1' });
    expect((await readLeagueDraft(joined.capability, fetcher)).picks).toEqual({ r1m1: 'preview-player-2' });
  });

  it('merges mutations from concurrent preview tabs without dropping a joined friend', async () => {
    const draw = createLeaguePreviewDraw('us-open-2026-men');
    const organizerTab = createLeaguePreviewFetch(draw, 'us-open-2026-men', 'open');
    const friendTab = createLeaguePreviewFetch(draw, 'us-open-2026-men', 'open');
    await createLeague('us-open-2026-men', 'Friday Night Draw', 'Andrey', organizerTab, 'create');
    const joined = await joinLeague(
      { kind: 'invitation', token: 'local-preview-invitation' },
      'Mina',
      friendTab,
      'join',
    );

    await saveLeagueDraft(
      { kind: 'participant', token: 'local-preview-participant' },
      0,
      { r1m1: 'preview-player-1' },
      organizerTab,
    );

    const friendAccess = await loadLeagueAccess(joined.capability, friendTab);
    expect(friendAccess).toMatchObject({
      kind: 'participant',
      league: { participantId: 'local-preview-friend-2' },
    });
  });
});
