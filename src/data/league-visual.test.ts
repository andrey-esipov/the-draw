import { describe, expect, it } from 'vitest';
import { leagueSlam } from './league-visual';

describe('private league visual identity', () => {
  it('derives a non-default women’s tournament from invitation-safe access data', () => {
    expect(leagueSlam({
      kind: 'invitation',
      checkedAt: '2026-08-12T00:00:00.000Z',
      invitation: {
        leagueId: 'league-1',
        leagueName: 'Paris friends',
        event: { slug: 'french-open:2026-women', kind: 'womens_singles' },
        seatsRemaining: 10,
        lockAt: '2026-08-24T15:00:00.000Z',
      },
    })).toBe('french-open-women');
  });

  it('derives the tournament from the canonical event slug', () => {
    expect(leagueSlam({
      kind: 'create',
      eventSlug: 'us-open-2026-men',
      eventName: "US Open men's",
    })).toBe('us-open-men');
  });

  it('returns no tournament while capability access has not identified one', () => {
    expect(leagueSlam({ kind: 'loading' })).toBeNull();
    expect(leagueSlam({ kind: 'invalid-access' })).toBeNull();
  });
});
