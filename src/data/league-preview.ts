import type {
  Draw,
  DrawLeagueProjection,
  DrawLeagueStanding,
  DrawParticipantAccess,
  DrawPathState,
} from '../../shared/draw/contracts';

export type LeaguePreviewMode = 'auto' | 'awaiting' | 'open' | 'live';

interface PreviewParticipant {
  id: string;
  displayName: string;
  token: string;
  seat: number;
  version: number;
  picks: Record<string, string>;
  submitted: boolean;
}

interface PreviewState {
  created: boolean;
  leagueName: string;
  eventSlug: string;
  participants: PreviewParticipant[];
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      Date: new Date().toUTCString(),
    },
  });
}

function initialState(initialEventSlug: string): PreviewState {
  return {
    created: false,
    leagueName: 'Centre Court friends',
    eventSlug: initialEventSlug,
    participants: [{
      id: 'local-preview-organizer',
      displayName: 'Organizer',
      token: 'local-preview-participant',
      seat: 1,
      version: 0,
      picks: {},
      submitted: false,
    }],
  };
}

function readState(storageKey: string, initialEventSlug: string): PreviewState {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return initialState(initialEventSlug);
    const parsed = JSON.parse(saved) as PreviewState & {
      version?: number;
      picks?: Record<string, string>;
      submitted?: boolean;
    };
    if (!parsed || !Array.isArray(parsed.participants)) return initialState(initialEventSlug);
    return {
      created: parsed.created,
      leagueName: parsed.leagueName,
      eventSlug: parsed.eventSlug,
      participants: parsed.participants.map((participant, index) => ({
        ...participant,
        version: participant.version ?? (index === 0 ? parsed.version ?? 0 : 0),
        picks: participant.picks ?? (index === 0 ? parsed.picks ?? {} : {}),
        submitted: participant.submitted ?? (index === 0 ? parsed.submitted ?? false : false),
      })),
    };
  } catch {
    return initialState(initialEventSlug);
  }
}

function capabilityToken(init?: RequestInit): string | null {
  const authorization = new Headers(init?.headers).get('Authorization');
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function createLeaguePreviewDraw(eventSlug: string): Draw {
  const women = eventSlug.endsWith('-women');
  const players = Object.fromEntries(Array.from({ length: 128 }, (_, index) => {
    const id = `preview-player-${index + 1}`;
    return [id, {
      id,
      name: `Preview Player ${index + 1}`,
      short: `P${index + 1}`,
      country: null,
      seed: index < 32 ? String(index + 1) : null,
    }];
  }));
  const roundNames = ['', 'First round', 'Second round', 'Third round', 'Fourth round', 'Quarterfinals', 'Semifinals', 'Final'];
  return {
    id: eventSlug.replace(/-2026-(men|women)$/, '-$1'),
    tournament: 'US Open',
    year: 2026,
    event: women ? "Women's Singles" : "Men's Singles",
    surface: 'Hard',
    venue: 'USTA Billie Jean King National Tennis Center',
    city: 'New York',
    bestOf: women ? 3 : 5,
    source: { wikipedia: 'Local preview fixture', url: 'https://www.usopen.org/' },
    players,
    rounds: Array.from({ length: 7 }, (_, roundIndex) => {
      const round = roundIndex + 1;
      return {
        round,
        name: roundNames[round]!,
        matches: Array.from({ length: 64 / (2 ** roundIndex) }, (_, position) => ({
          id: `r${round}m${position + 1}`,
          round,
          position,
          sides: round === 1
            ? [
                { player: `preview-player-${position * 2 + 1}`, seed: position * 2 < 32 ? String(position * 2 + 1) : null, sets: [] },
                { player: `preview-player-${position * 2 + 2}`, seed: position * 2 + 1 < 32 ? String(position * 2 + 2) : null, sets: [] },
              ]
            : [],
          winner: null,
        })),
      };
    }),
  };
}

function completePicks(draw: Draw, variant: number): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const round of draw.rounds) {
    for (const match of round.matches) {
      const candidates = round.round === 1
        ? match.sides.map((side) => side.player)
        : [
            picks[`r${round.round - 1}m${match.position * 2 + 1}`],
            picks[`r${round.round - 1}m${match.position * 2 + 2}`],
          ].filter((playerId): playerId is string => Boolean(playerId));
      picks[match.id] = candidates[(match.position + round.round + variant) % candidates.length]!;
    }
  }
  return picks;
}

function previewParticipants(state: PreviewState): PreviewParticipant[] {
  const participants = [...state.participants];
  for (const [displayName, seat] of [['Mina', 2], ['Theo', 3]] as const) {
    if (participants.some((participant) => participant.seat === seat)) continue;
    participants.push({
      id: `local-preview-friend-${seat}`,
      displayName,
      token: `local-preview-friend-token-${seat}`,
      seat,
      version: 1,
      picks: {},
      submitted: true,
    });
  }
  return participants.sort((a, b) => a.seat - b.seat);
}

function previewProjection(draw: Draw, state: PreviewState): DrawLeagueProjection {
  const participants = previewParticipants(state);
  const accepted = completePicks(draw, 0);
  const scores = [67, 61, 48];
  const standings: DrawLeagueStanding[] = participants.map((participant, index) => {
    const picks = Object.keys(participant.picks).length === 127
      ? participant.picks
      : completePicks(draw, participant.seat);
    const path = draw.rounds.flatMap((round) => round.matches.map((match) => {
      const predictedWinnerId = picks[match.id]!;
      const acceptedWinnerId = round.round <= 4 ? accepted[match.id]! : null;
      const stateName: DrawPathState = acceptedWinnerId === null
        ? (match.position === 0 && round.round === 5 ? 'changed-opponent' : 'unresolved')
        : acceptedWinnerId === predictedWinnerId
          ? 'alive'
          : 'broken';
      return {
        matchId: match.id,
        round: round.round,
        roundName: round.name,
        points: 2 ** (round.round - 1),
        predictedWinnerId,
        predictedWinnerName: draw.players[predictedWinnerId]!.name,
        predictedOpponentId: null,
        predictedOpponentName: null,
        acceptedWinnerId,
        acceptedWinnerName: acceptedWinnerId ? draw.players[acceptedWinnerId]!.name : null,
        acceptedOpponentId: null,
        acceptedOpponentName: null,
        state: stateName,
      };
    }));
    const championId = picks.r7m1!;
    return {
      participantId: participant.id,
      seat: participant.seat,
      displayName: participant.displayName,
      removed: false,
      rank: index + 1,
      tied: false,
      score: scores[index] ?? 42,
      maxPossible: (scores[index] ?? 42) + 64 - index * 7,
      movement: [1, -1, 0][index] ?? 0,
      unscorable: false,
      champion: {
        playerId: championId,
        playerName: draw.players[championId]!.name,
        state: index === 1 ? 'broken' : 'alive',
      },
      correctByRound: [32 - index * 3, 15 - index, 7 - index, 3, 0, 0, 0],
      submission: {
        version: 1,
        checksum: `local-preview-${participant.seat}`,
        picks,
      },
      path,
    };
  });
  const acceptedAt = '2026-09-01T22:15:00.000Z';
  return {
    canonical: {
      revisionId: 'local-preview-live-r4',
      sourceRevisionId: 'preview-r4',
      checksum: 'localpreviewchecksum1234567890',
      fetchedAt: acceptedAt,
      acceptedAt,
      sourceUrl: 'https://www.usopen.org/',
      corrected: false,
      freshness: {
        state: 'current',
        lastAttemptAt: acceptedAt,
        lastSuccessfulAt: acceptedAt,
        delayReason: null,
      },
    },
    movementAvailable: true,
    standings,
    participants: participants.map((participant) => ({
      id: participant.id,
      seat: participant.seat,
      displayName: participant.displayName,
      removed: false,
      submitted: true,
    })),
    recap: {
      state: 'current',
      acceptedRevisionId: 'local-preview-live-r4',
      viewModel: {
        leagueName: state.leagueName,
        eventLabel: `US Open 2026 · ${eventKindLabel(state.eventSlug)}`,
        round: 4,
        roundLabel: 'Fourth round',
        headline: 'The fourth round moved the clubhouse',
        acceptedRevisionId: 'local-preview-live-r4',
        sourceRevisionId: 'preview-r4',
        acceptedAt,
        sourceFreshness: 'current',
        correctionReplay: 'not_needed',
        delayReason: null,
        movements: standings.filter((standing) => standing.movement !== 0).map((standing) => ({
          participantId: standing.participantId,
          displayName: standing.displayName,
          previousRank: standing.rank + (standing.movement ?? 0),
          rank: standing.rank,
          score: standing.score,
          movement: standing.movement ?? 0,
        })),
        rarestCorrectCall: {
          participantId: standings[0]!.participantId,
          displayName: standings[0]!.displayName,
          playerId: accepted.r4m1!,
          playerName: draw.players[accepted.r4m1!]!.name,
          matchId: 'r4m1',
          pickCount: 1,
          submittedCount: standings.length,
        },
        highestImpactMiss: {
          participantId: standings[1]!.participantId,
          displayName: standings[1]!.displayName,
          playerId: standings[1]!.submission.picks.r4m1!,
          playerName: draw.players[standings[1]!.submission.picks.r4m1!]!.name,
          matchId: 'r4m1',
          lostFuturePoints: 48,
        },
        survivingChampions: standings
          .filter((standing) => standing.champion.state === 'alive')
          .map((standing) => ({
            participantId: standing.participantId,
            displayName: standing.displayName,
            playerId: standing.champion.playerId,
            playerName: standing.champion.playerName,
          })),
      },
    },
  };
}

function eventKindLabel(eventSlug: string): string {
  return eventSlug.endsWith('-women') ? "Women's singles" : "Men's singles";
}

export function createLeaguePreviewFetch(
  draw: Draw | null,
  initialEventSlug: string,
  mode: LeaguePreviewMode = draw ? 'open' : 'awaiting',
): typeof fetch {
  const storageKey = `rallo-draw-league-preview:${initialEventSlug}`;
  let state = readState(storageKey, initialEventSlug);
  const participantToken = 'local-preview-participant';
  const invitationToken = 'local-preview-invitation';
  const eventKind = initialEventSlug.endsWith('-women') ? 'womens_singles' : 'mens_singles';
  const save = () => window.localStorage.setItem(storageKey, JSON.stringify(state));
  const participantFor = (token: string | null) => state.participants.find((participant) => participant.token === token);

  const participantAccess = (participant: PreviewParticipant): DrawParticipantAccess => ({
    league: {
      id: 'local-preview-league',
      name: state.leagueName,
      eventSlug: state.eventSlug,
      eventKind,
      lockAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revealed: mode === 'live',
    },
    participantId: participant.id,
    participantCount: mode === 'live' ? previewParticipants(state).length : state.participants.length,
    viewer: {
      draft: { exists: participant.version > 0, version: participant.version, pickCount: Object.keys(participant.picks).length },
      submission: { active: participant.submitted, complete: participant.submitted },
    },
    projection: mode === 'live' && draw ? previewProjection(draw, state) : null,
  });

  const fetcher: typeof fetch = async (input, init) => {
    state = readState(storageKey, initialEventSlug);
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url, window.location.origin).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const token = capabilityToken(init);
    const baseUrl = new URL(window.location.href);
    baseUrl.hash = '';
    const link = (fragment: string) => {
      const url = new URL(baseUrl);
      url.hash = fragment;
      return url.toString();
    };

    if (path.endsWith('/leagues') && method === 'POST') {
      state = {
        ...state,
        created: true,
        leagueName: typeof body.leagueName === 'string' ? body.leagueName : state.leagueName,
        eventSlug: typeof body.eventSlug === 'string' ? body.eventSlug : state.eventSlug,
        participants: state.participants.map((participant) => participant.seat === 1
          ? {
              ...participant,
              displayName: typeof body.displayName === 'string' ? body.displayName : participant.displayName,
            }
          : participant),
      };
      save();
      return json({
        leagueId: 'local-preview-league',
        participantId: 'local-preview-organizer',
        eventKind,
        invitationLink: link(`invite=${invitationToken}`),
        returnLink: link(`return=${participantToken}`),
      });
    }
    if (path.endsWith('/invitation') && method === 'GET') {
      if (!state.created || token !== invitationToken) return json({ error: 'not_found' }, 404);
      return json({
        leagueId: 'local-preview-league',
        leagueName: state.leagueName,
        event: { slug: state.eventSlug, kind: eventKind },
        seatsRemaining: Math.max(0, 16 - state.participants.length),
        lockAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    if (path.endsWith('/participants') && method === 'POST') {
      if (!state.created || token !== invitationToken) return json({ error: 'not_found' }, 404);
      const seat = state.participants.length + 1;
      const participant = {
        id: `local-preview-friend-${seat}`,
        displayName: typeof body.displayName === 'string' ? body.displayName : `Friend ${seat}`,
        token: `local-preview-friend-token-${seat}`,
        seat,
        version: 0,
        picks: {},
        submitted: false,
      };
      state = { ...state, participants: [...state.participants, participant] };
      save();
      return json({
        participantId: participant.id,
        seat,
        returnLink: link(`return=${participant.token}`),
      });
    }
    if (path.endsWith('/league') && method === 'GET') {
      const participant = participantFor(token);
      if (!state.created || !participant) return json({ error: 'not_found' }, 404);
      return json(participantAccess(participant));
    }
    if (path.endsWith('/draft') && method === 'GET') {
      const participant = participantFor(token);
      if (!participant) return json({ error: 'not_found' }, 404);
      if (!draw) return json({ error: 'source_unavailable' }, 503);
      return json({
        version: participant.version,
        picks: participant.picks,
        acceptedRevisionId: 'local-preview-revision',
        acceptedRevisionChecksum: 'local-preview-checksum',
        affectedMatchIds: [],
        locked: false,
        draw,
      });
    }
    if (path.endsWith('/draft') && method === 'PUT') {
      const participant = participantFor(token);
      if (!participant) return json({ error: 'not_found' }, 404);
      const nextPicks = body.picks && typeof body.picks === 'object'
        ? body.picks as Record<string, string>
        : participant.picks;
      state = {
        ...state,
        participants: state.participants.map((candidate) => candidate.token === token
          ? { ...candidate, picks: nextPicks, version: candidate.version + 1 }
          : candidate),
      };
      save();
      const updated = participantFor(token)!;
      return json({
        version: updated.version,
        picks: updated.picks,
        acceptedRevisionId: 'local-preview-revision',
        acceptedRevisionChecksum: 'local-preview-checksum',
        affectedMatchIds: [],
      });
    }
    if (path.endsWith('/submissions') && method === 'POST') {
      const participant = participantFor(token);
      if (!participant) return json({ error: 'not_found' }, 404);
      state = {
        ...state,
        participants: state.participants.map((candidate) => candidate.token === token
          ? { ...candidate, submitted: true }
          : candidate),
      };
      save();
      return json({
        submissionId: 'local-preview-submission',
        version: participantFor(token)!.version,
        checksum: 'local-preview-submission-checksum',
        active: true,
      });
    }
    if (path.endsWith('/email') && method === 'POST') {
      if (!participantFor(token)) return json({ error: 'not_found' }, 404);
      return json({
        delivery: { state: 'unavailable' },
        returnLink: link(`return=${participantToken}`),
      });
    }
    return json({ error: 'not_found' }, 404);
  };

  return fetcher;
}
