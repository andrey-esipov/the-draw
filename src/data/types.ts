// SlamId is a separate, closed union used for menu navigation, theming, and
// per-slam asset routing (title vessels, court renders). It is NOT the type
// of Draw.id: a league draw's id is a year-qualified event id (e.g.
// "us-open-2026-men"), not one of these 8 canonical slam slugs. Draw and its
// nested types are re-exported wholesale from the shared draw contract so the
// frontend's wire format always matches what the backend (draw ingestion,
// league projections) actually serializes.
export type SlamId =
  | 'australian-open-men'
  | 'australian-open-women'
  | 'french-open-men'
  | 'french-open-women'
  | 'wimbledon-men'
  | 'wimbledon-women'
  | 'us-open-men'
  | 'us-open-women';

export type {
  Draw,
  Match,
  MatchTerminality,
  Player,
  Round,
  SetScore,
  Side,
  Surface,
} from '../../shared/draw/contracts';
