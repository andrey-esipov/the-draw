import type { SlamId } from './types';
import type { LeagueAccessState } from './league-api';
import { SLAM_ORDER, SLAM_ORDER_WOMEN } from '../ui/theme';

export function leagueSlam(state: LeagueAccessState): SlamId | null {
  const descriptor = state.kind === 'create'
    ? { slug: state.eventSlug, kind: state.eventSlug.endsWith('-women') ? 'womens_singles' : 'mens_singles' }
    : state.kind === 'invitation'
      ? state.invitation.event
      : state.kind === 'participant'
        ? { slug: state.league.league.eventSlug, kind: state.league.league.eventKind }
        : null;
  if (!descriptor) return null;
  const tournament = descriptor.slug.includes(':')
    ? descriptor.slug.split(':', 1)[0]
    : descriptor.slug.replace(/-\d{4}-(men|women)$/, '');
  const tour = descriptor.kind === 'womens_singles' ? 'women' : 'men';
  const candidate = `${tournament}-${tour}`;
  return [...SLAM_ORDER, ...SLAM_ORDER_WOMEN].find((id) => id === candidate) ?? null;
}
