import type { Draw, DrawInvitationAccess, DrawParticipantAccess } from '../../shared/draw/contracts';

export type LeagueCapability =
  | { kind: 'invitation'; token: string }
  | { kind: 'participant'; token: string };

export type CapabilityBootstrap =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'capability'; capability: LeagueCapability };

export type LeagueAccessState =
  | { kind: 'create'; eventSlug: string; eventName: string }
  | { kind: 'loading' }
  | { kind: 'invitation'; invitation: DrawInvitationAccess; checkedAt: string }
  | { kind: 'participant'; league: DrawParticipantAccess; checkedAt: string }
  | { kind: 'invalid-access' }
  | { kind: 'source-delay' }
  | { kind: 'network-failure' };

export interface DrawDraftAccess {
  version: number;
  picks: Record<string, string>;
  acceptedRevisionId: string;
  acceptedRevisionChecksum: string;
  affectedMatchIds: string[];
  locked: boolean;
  draw: Draw;
}

export interface LeagueCreated {
  leagueId: string;
  participantId: string;
  eventKind: 'mens_singles' | 'womens_singles';
  invitationLink: string;
  returnLink: string;
  capability: LeagueCapability & { kind: 'participant' };
}

export class LeagueApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(code);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

export function parseCapabilityFragment(fragment: string): CapabilityBootstrap {
  if (!fragment || fragment === '#') return { kind: 'none' };
  let entries: Array<[string, string]>;
  try {
    entries = [...new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment).entries()];
  } catch {
    return { kind: 'invalid' };
  }
  if (entries.length !== 1) return { kind: 'invalid' };
  const [key, token] = entries[0]!;
  if (!token || (key !== 'invite' && key !== 'return')) return { kind: 'invalid' };
  return {
    kind: 'capability',
    capability: {
      kind: key === 'invite' ? 'invitation' : 'participant',
      token,
    },
  };
}

function checkedAt(response: Response, now: () => Date): string {
  const serverDate = response.headers.get('Date');
  const parsed = serverDate ? new Date(serverDate) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now().toISOString();
}

function participantCapability(link: string): LeagueCapability & { kind: 'participant' } {
  const parsed = parseCapabilityFragment(new URL(link).hash);
  if (parsed.kind !== 'capability' || parsed.capability.kind !== 'participant') {
    throw new LeagueApiError('invalid_return_link', 502);
  }
  return parsed.capability;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key] !== '';
}

function numberField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number' && Number.isFinite(value[key]);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function stringRecord(value: unknown): value is Record<string, string> {
  const candidate = record(value);
  return Boolean(candidate && Object.values(candidate).every((entry) => typeof entry === 'string'));
}

function validDraw(value: unknown): value is Draw {
  const candidate = record(value);
  const source = record(candidate?.source);
  const players = record(candidate?.players);
  return Boolean(
    candidate
    && stringField(candidate, 'id')
    && stringField(candidate, 'tournament')
    && numberField(candidate, 'year')
    && stringField(candidate, 'event')
    && ['Hard', 'Clay', 'Grass'].includes(String(candidate.surface))
    && stringField(candidate, 'venue')
    && stringField(candidate, 'city')
    && (candidate.bestOf === 3 || candidate.bestOf === 5)
    && source
    && stringField(source, 'wikipedia')
    && stringField(source, 'url')
    && players
    && Object.values(players).every((entry) => {
      const player = record(entry);
      return Boolean(
        player
        && stringField(player, 'id')
        && stringField(player, 'name')
        && stringField(player, 'short')
        && nullableString(player.country)
        && nullableString(player.seed),
      );
    })
    && Array.isArray(candidate.rounds)
    && candidate.rounds.every((entry) => {
      const round = record(entry);
      return Boolean(
        round
        && numberField(round, 'round')
        && stringField(round, 'name')
        && Array.isArray(round.matches)
        && round.matches.every((matchEntry) => {
          const match = record(matchEntry);
          return Boolean(
            match
            && stringField(match, 'id')
            && numberField(match, 'round')
            && numberField(match, 'position')
            && nullableString(match.winner)
            && Array.isArray(match.sides)
            && match.sides.every((sideEntry) => {
              const side = record(sideEntry);
              return Boolean(
                side
                && stringField(side, 'player')
                && nullableString(side.seed)
                && Array.isArray(side.sets)
                && side.sets.every((setEntry) => {
                  const set = record(setEntry);
                  return Boolean(
                    set
                    && numberField(set, 'games')
                    && (set.tiebreak === null || numberField(set, 'tiebreak'))
                    && typeof set.won === 'boolean'
                    && (set.retired === undefined || typeof set.retired === 'boolean'),
                  );
                }),
              );
            })
            && (
              match.terminal === undefined
              || ['completed', 'retirement', 'walkover', 'incomplete'].includes(String(match.terminal))
            ),
          );
        }),
      );
    }),
  );
}

function validPathStep(value: unknown): boolean {
  const step = record(value);
  return Boolean(
    step
    && stringField(step, 'matchId')
    && numberField(step, 'round')
    && stringField(step, 'roundName')
    && numberField(step, 'points')
    && stringField(step, 'predictedWinnerId')
    && stringField(step, 'predictedWinnerName')
    && nullableString(step.predictedOpponentId)
    && nullableString(step.predictedOpponentName)
    && nullableString(step.acceptedWinnerId)
    && nullableString(step.acceptedWinnerName)
    && nullableString(step.acceptedOpponentId)
    && nullableString(step.acceptedOpponentName)
    && ['alive', 'broken', 'unresolved', 'changed-opponent'].includes(String(step.state)),
  );
}

function validStanding(value: unknown): boolean {
  const standing = record(value);
  const champion = record(standing?.champion);
  const submission = record(standing?.submission);
  return Boolean(
    standing
    && champion
    && submission
    && stringField(standing, 'participantId')
    && numberField(standing, 'seat')
    && stringField(standing, 'displayName')
    && typeof standing.removed === 'boolean'
    && numberField(standing, 'rank')
    && typeof standing.tied === 'boolean'
    && numberField(standing, 'score')
    && numberField(standing, 'maxPossible')
    && (standing.movement === null || numberField(standing, 'movement'))
    && stringField(champion, 'playerId')
    && stringField(champion, 'playerName')
    && ['alive', 'broken', 'unresolved'].includes(String(champion.state))
    && Array.isArray(standing.correctByRound)
    && standing.correctByRound.every((entry) => typeof entry === 'number')
    && numberField(submission, 'version')
    && stringField(submission, 'checksum')
    && stringRecord(submission.picks)
    && Array.isArray(standing.path)
    && standing.path.every(validPathStep),
  );
}

function validRecap(value: unknown): boolean {
  const recap = record(value);
  if (!recap || !['none', 'updating', 'current'].includes(String(recap.state))) return false;
  if (recap.state === 'none') return true;
  if (!stringField(recap, 'acceptedRevisionId')) return false;
  if (recap.state === 'updating') return true;
  const view = record(recap.viewModel);
  const validMovement = (entry: unknown) => {
    const movement = record(entry);
    return Boolean(
      movement
      && stringField(movement, 'participantId')
      && stringField(movement, 'displayName')
      && numberField(movement, 'previousRank')
      && numberField(movement, 'rank')
      && numberField(movement, 'score')
      && numberField(movement, 'movement'),
    );
  };
  const validCall = (entry: unknown) => {
    const call = record(entry);
    return Boolean(
      call
      && stringField(call, 'participantId')
      && stringField(call, 'displayName')
      && stringField(call, 'playerId')
      && stringField(call, 'playerName')
      && stringField(call, 'matchId')
      && numberField(call, 'pickCount')
      && numberField(call, 'submittedCount'),
    );
  };
  const validMiss = (entry: unknown) => {
    const miss = record(entry);
    return Boolean(
      miss
      && stringField(miss, 'participantId')
      && stringField(miss, 'displayName')
      && stringField(miss, 'playerId')
      && stringField(miss, 'playerName')
      && stringField(miss, 'matchId')
      && numberField(miss, 'lostFuturePoints'),
    );
  };
  const validChampion = (entry: unknown) => {
    const champion = record(entry);
    return Boolean(
      champion
      && stringField(champion, 'participantId')
      && stringField(champion, 'displayName')
      && stringField(champion, 'playerId')
      && stringField(champion, 'playerName'),
    );
  };
  return Boolean(
    view
    && stringField(view, 'leagueName')
    && stringField(view, 'eventLabel')
    && numberField(view, 'round')
    && stringField(view, 'roundLabel')
    && stringField(view, 'headline')
    && stringField(view, 'acceptedRevisionId')
    && stringField(view, 'sourceRevisionId')
    && stringField(view, 'acceptedAt')
    && ['current', 'delayed', 'conflicting', 'stale'].includes(String(view.sourceFreshness))
    && ['not_needed', 'replayed'].includes(String(view.correctionReplay))
    && nullableString(view.delayReason)
    && Array.isArray(view.movements)
    && view.movements.every(validMovement)
    && Array.isArray(view.survivingChampions)
    && view.survivingChampions.every(validChampion)
    && (view.rarestCorrectCall === null || validCall(view.rarestCorrectCall))
    && (view.highestImpactMiss === null || validMiss(view.highestImpactMiss)),
  );
}

function validProjection(value: unknown): boolean {
  const projection = record(value);
  const canonical = record(projection?.canonical);
  const freshness = record(canonical?.freshness);
  return Boolean(
    projection
    && canonical
    && freshness
    && stringField(canonical, 'revisionId')
    && stringField(canonical, 'sourceRevisionId')
    && stringField(canonical, 'checksum')
    && stringField(canonical, 'fetchedAt')
    && stringField(canonical, 'acceptedAt')
    && stringField(canonical, 'sourceUrl')
    && typeof canonical.corrected === 'boolean'
    && ['current', 'delayed', 'conflicting', 'stale'].includes(String(freshness.state))
    && nullableString(freshness.lastAttemptAt)
    && nullableString(freshness.lastSuccessfulAt)
    && nullableString(freshness.delayReason)
    && typeof projection.movementAvailable === 'boolean'
    && Array.isArray(projection.standings)
    && projection.standings.every(validStanding)
    && Array.isArray(projection.participants)
    && projection.participants.every((entry) => {
      const participant = record(entry);
      return Boolean(
        participant
        && stringField(participant, 'id')
        && numberField(participant, 'seat')
        && stringField(participant, 'displayName')
        && typeof participant.removed === 'boolean'
        && typeof participant.submitted === 'boolean',
      );
    })
    && validRecap(projection.recap),
  );
}

function validParticipantAccess(value: unknown): value is DrawParticipantAccess {
  const candidate = record(value);
  const league = record(candidate?.league);
  const viewer = record(candidate?.viewer);
  const draft = record(viewer?.draft);
  const submission = record(viewer?.submission);
  return Boolean(
    candidate
    && league
    && viewer
    && draft
    && submission
    && stringField(league, 'id')
    && stringField(league, 'name')
    && stringField(league, 'eventSlug')
    && (league.eventKind === 'mens_singles' || league.eventKind === 'womens_singles')
    && stringField(league, 'lockAt')
    && typeof league.revealed === 'boolean'
    && stringField(candidate, 'participantId')
    && numberField(candidate, 'participantCount')
    && typeof draft.exists === 'boolean'
    && numberField(draft, 'version')
    && numberField(draft, 'pickCount')
    && typeof submission.active === 'boolean'
    && typeof submission.complete === 'boolean'
    && (candidate.projection === null || validProjection(candidate.projection)),
  );
}

function validInvitationAccess(value: unknown): value is DrawInvitationAccess {
  const candidate = record(value);
  const event = record(candidate?.event);
  return Boolean(
    candidate
    && event
    && stringField(candidate, 'leagueId')
    && stringField(candidate, 'leagueName')
    && stringField(event, 'slug')
    && (event.kind === 'mens_singles' || event.kind === 'womens_singles')
    && numberField(candidate, 'seatsRemaining')
    && stringField(candidate, 'lockAt'),
  );
}

function validDraft(value: unknown, includeDraw: boolean): boolean {
  const candidate = record(value);
  return Boolean(
    candidate
    && typeof candidate.version === 'number'
    && stringRecord(candidate.picks)
    && stringField(candidate, 'acceptedRevisionId')
    && stringField(candidate, 'acceptedRevisionChecksum')
    && Array.isArray(candidate.affectedMatchIds)
    && candidate.affectedMatchIds.every((entry) => typeof entry === 'string')
    && (!includeDraw || (typeof candidate.locked === 'boolean' && validDraw(candidate.draw))),
  );
}

function validSubmission(value: unknown): value is { submissionId: string; version: number; checksum: string; active: true } {
  const candidate = record(value);
  return Boolean(
    candidate
    && stringField(candidate, 'submissionId')
    && typeof candidate.version === 'number'
    && stringField(candidate, 'checksum')
    && candidate.active === true,
  );
}

function requirePayload<T>(payload: unknown, valid: (value: unknown) => boolean, status: number): T {
  if (!valid(payload)) throw new LeagueApiError('invalid_response', status);
  return payload as T;
}

async function request<T>(
  endpoint: string,
  options: {
    capability?: LeagueCapability;
    method?: 'GET' | 'POST' | 'PUT';
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<{ payload: T; response: Response }> {
  const fetcher = options.fetcher ?? fetch;
  const headers = new Headers();
  if (options.capability) headers.set('Authorization', `Bearer ${options.capability.token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let response: Response;
  const controller = new AbortController();
  let timeout: number | ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      fetcher(endpoint, {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('request_timeout'));
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new LeagueApiError('network_failure', 0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const contentType = response.headers.get('Content-Type') ?? '';
  const isJson = /(^|[;/\s])(?:application\/)?(?:[\w.-]+\+)?json(?:[;\s]|$)/i.test(contentType);
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const body = payload && typeof payload === 'object' ? payload as { error?: unknown; details?: unknown } : {};
    throw new LeagueApiError(
      typeof body.error === 'string' ? body.error : 'network_failure',
      response.status,
      body.details && typeof body.details === 'object' ? body.details as Record<string, unknown> : undefined,
    );
  }
  if (!isJson || payload === null) {
    throw new LeagueApiError('invalid_response', response.status);
  }
  return { payload: payload as T, response };
}

export function requestKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export async function createLeague(
  eventSlug: string,
  leagueName: string,
  displayName: string,
  fetcher: typeof fetch = fetch,
  idempotencyKey: string = requestKey(),
): Promise<LeagueCreated> {
  const result = await request<unknown>('/api/draw/leagues', {
    method: 'POST',
    body: { eventSlug, leagueName, displayName },
    idempotencyKey,
    fetcher,
  });
  const payload = requirePayload<Omit<LeagueCreated, 'capability'>>(
    result.payload,
    (value) => {
      const candidate = record(value);
      return Boolean(
        candidate
        && stringField(candidate, 'leagueId')
        && stringField(candidate, 'participantId')
        && (candidate.eventKind === 'mens_singles' || candidate.eventKind === 'womens_singles')
        && stringField(candidate, 'invitationLink')
        && stringField(candidate, 'returnLink'),
      );
    },
    result.response.status,
  );
  return { ...payload, capability: participantCapability(payload.returnLink) };
}

export async function joinLeague(
  capability: LeagueCapability & { kind: 'invitation' },
  displayName: string,
  fetcher: typeof fetch = fetch,
  idempotencyKey: string = requestKey(),
): Promise<{ participantId: string; seat: number; returnLink: string; capability: LeagueCapability & { kind: 'participant' } }> {
  const result = await request<unknown>('/api/draw/participants', {
    capability,
    method: 'POST',
    body: { displayName },
    idempotencyKey,
    fetcher,
  });
  const payload = requirePayload<{ participantId: string; seat: number; returnLink: string }>(
    result.payload,
    (value) => {
      const candidate = record(value);
      return Boolean(
        candidate
        && stringField(candidate, 'participantId')
        && typeof candidate.seat === 'number'
        && stringField(candidate, 'returnLink'),
      );
    },
    result.response.status,
  );
  return { ...payload, capability: participantCapability(payload.returnLink) };
}

export async function readLeagueDraft(
  capability: LeagueCapability & { kind: 'participant' },
  fetcher: typeof fetch = fetch,
): Promise<DrawDraftAccess> {
  const result = await request<unknown>('/api/draw/draft', { capability, fetcher });
  return requirePayload<DrawDraftAccess>(result.payload, (value) => validDraft(value, true), result.response.status);
}

export async function saveLeagueDraft(
  capability: LeagueCapability & { kind: 'participant' },
  expectedVersion: number,
  picks: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<Omit<DrawDraftAccess, 'locked' | 'draw'>> {
  const result = await request<unknown>('/api/draw/draft', {
    capability, method: 'PUT', body: { expectedVersion, picks }, fetcher,
  });
  return requirePayload<Omit<DrawDraftAccess, 'locked' | 'draw'>>(
    result.payload,
    (value) => validDraft(value, false),
    result.response.status,
  );
}

export async function submitLeagueBracket(
  capability: LeagueCapability & { kind: 'participant' },
  expectedDraftVersion: number,
  fetcher: typeof fetch = fetch,
): Promise<{ submissionId: string; version: number; checksum: string; active: true }> {
  const result = await request<unknown>('/api/draw/submissions', {
    capability, method: 'POST', body: { expectedDraftVersion }, fetcher,
  });
  return requirePayload(result.payload, validSubmission, result.response.status);
}

export async function refreshLeague(
  capability: LeagueCapability & { kind: 'participant' },
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ league: DrawParticipantAccess; checkedAt: string }> {
  const result = await request<unknown>('/api/draw/league', { capability, fetcher });
  return {
    league: requirePayload<DrawParticipantAccess>(result.payload, validParticipantAccess, result.response.status),
    checkedAt: checkedAt(result.response, now),
  };
}

export async function emailLeagueReturnLink(
  capability: LeagueCapability & { kind: 'participant' },
  email: string,
  fetcher: typeof fetch = fetch,
): Promise<{ delivery: { state: 'queued' | 'unavailable' | 'failed' | 'unconfirmed' | 'throttled' }; returnLink: string }> {
  const result = await request<unknown>(
    '/api/draw/email',
    { capability, method: 'POST', body: { email, confirmed: true }, fetcher },
  );
  return requirePayload(
    result.payload,
    (value) => {
      const candidate = record(value);
      const delivery = record(candidate?.delivery);
      return Boolean(
        candidate
        && delivery
        && ['queued', 'unavailable', 'failed', 'unconfirmed', 'throttled'].includes(String(delivery.state))
        && stringField(candidate, 'returnLink'),
      );
    },
    result.response.status,
  );
}

export async function loadLeagueAccess(
  capability: LeagueCapability,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<LeagueAccessState> {
  const endpoint = capability.kind === 'invitation' ? '/api/draw/invitation' : '/api/draw/league';
  try {
    const { payload, response } = await request<unknown>(
      endpoint,
      { capability, fetcher },
    );
    return capability.kind === 'invitation'
      ? {
          kind: 'invitation',
          invitation: requirePayload<DrawInvitationAccess>(payload, validInvitationAccess, response.status),
          checkedAt: checkedAt(response, now),
        }
      : {
          kind: 'participant',
          league: requirePayload<DrawParticipantAccess>(payload, validParticipantAccess, response.status),
          checkedAt: checkedAt(response, now),
        };
  } catch (error) {
    if (error instanceof LeagueApiError) {
      if ([401, 403, 404].includes(error.status)) return { kind: 'invalid-access' };
      if (error.status === 503 && error.code === 'source_unavailable') return { kind: 'source-delay' };
    }
    return { kind: 'network-failure' };
  }
}
